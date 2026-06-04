#!/usr/bin/env python3
"""
Sync Consumer POS data to Firestore for the admin dashboard.

Pipeline:
1. Connect to Google Drive via service account
2. Download the most recently modified .fbconsumer backup
3. Restore the Firebird database using gbak
4. Query sales data (vendas, itens, formas de pagamento)
5. Query financial data (contas a pagar, fornecedores, compras)
6. Aggregate daily metrics
7. Upload to Firestore:
   - artifacts/{appId}/public/data/faturamento/{date}
   - artifacts/{appId}/public/data/financeiro/{contas_pagar|fornecedores|compras|resumo}

Requirements:
  pip install google-api-python-client google-auth firebase-admin firebird-driver

Environment variables:
  GOOGLE_SERVICE_ACCOUNT_JSON  - Service account credentials (JSON string)
  DRIVE_FOLDER_ID              - Google Drive folder ID with .fbconsumer backups
  FIREBASE_SERVICE_ACCOUNT_JSON - Firebase service account credentials (JSON string)
  FIREBASE_PROJECT_ID          - Firebase project ID (default: central-de-reservas-jsp)
"""

import os
import sys
import json
import subprocess
import tempfile
from datetime import datetime, timedelta
from collections import defaultdict

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DRIVE_FOLDER_ID = os.environ.get("DRIVE_FOLDER_ID", "1ktZnYUoMIYWBN7dkQlkLzvIcVtlSS3Rs")
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "central-de-reservas-jsp")
FIRESTORE_PATH_FAT = f"artifacts/{FIREBASE_PROJECT_ID}/public/data/faturamento"
FIRESTORE_PATH_FIN = f"artifacts/{FIREBASE_PROJECT_ID}/public/data/financeiro"

# ---------------------------------------------------------------------------
# Google Drive: download backup by day-of-week strategy
# ---------------------------------------------------------------------------
DIAS_SEMANA = {
    0: "segunda-feira",
    1: "terça-feira",
    2: "quarta-feira",
    3: "quinta-feira",
    4: "sexta-feira",
    5: "sábado",
    6: "domingo",
}

# BRT = UTC-3
BRT_OFFSET = timedelta(hours=-3)

def get_drive_service():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not creds_json:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON not set")

    creds_info = json.loads(creds_json)
    creds = service_account.Credentials.from_service_account_info(
        creds_info, scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    return build("drive", "v3", credentials=creds)


def list_drive_backups(drive_service):
    """List all .fbconsumer files in the Drive folder."""
    results = drive_service.files().list(
        q=f"'{DRIVE_FOLDER_ID}' in parents and name contains '.fbconsumer'",
        orderBy="modifiedTime desc",
        pageSize=20,
        fields="files(id, name, modifiedTime, size)"
    ).execute()
    return results.get("files", [])


def pick_backup(files, now_brt):
    """
    Select which .fbconsumer to download based on day-of-week.

    Strategy:
      - Files are named by day: segunda-feira.fbconsumer ... domingo.fbconsumer
      - domingo.fbconsumer condenses the whole week (weekly close)
      - On Sunday/Monday, prioritize domingo for weekly close
      - Other days: look for yesterday's file (backup generated overnight)
      - Fallback: most recently modified file
      - Stale check: warn if selected file hasn't been modified in >48h
    """
    by_name = {}
    for f in files:
        key = f["name"].replace(".fbconsumer", "").lower().strip()
        by_name[key] = f

    weekday = now_brt.weekday()  # 0=Mon, 6=Sun
    today_name = DIAS_SEMANA[weekday]
    yesterday_name = DIAS_SEMANA[(weekday - 1) % 7]

    print(f"Hoje (BRT): {now_brt.strftime('%A %Y-%m-%d')} → {today_name}")
    print(f"Arquivos no Drive: {[f['name'] for f in files]}")

    chosen = None
    reason = ""

    # Sunday or Monday morning → prioritize domingo (weekly close)
    if weekday in (6, 0):
        if "domingo" in by_name:
            chosen = by_name["domingo"]
            reason = "fechamento semanal (domingo condensa a semana)"
        elif yesterday_name in by_name:
            chosen = by_name[yesterday_name]
            reason = f"fallback para {yesterday_name} (domingo não encontrado)"

    # Other days: look for yesterday's file first, then today's
    if not chosen:
        if yesterday_name in by_name:
            chosen = by_name[yesterday_name]
            reason = f"backup diário de {yesterday_name}"
        elif today_name in by_name:
            chosen = by_name[today_name]
            reason = f"backup diário de {today_name}"

    # Final fallback: most recently modified
    if not chosen:
        if files:
            chosen = files[0]
            reason = f"fallback: arquivo mais recente ({chosen['name']})"
        else:
            return None, "Nenhum arquivo .fbconsumer encontrado no Drive"

    # Stale check
    mod_time = datetime.fromisoformat(chosen["modifiedTime"].replace("Z", "+00:00"))
    age_hours = (now_brt.astimezone(mod_time.tzinfo) - mod_time).total_seconds() / 3600
    stale_warning = ""
    if age_hours > 48:
        stale_warning = f" ⚠ ATENÇÃO: arquivo não atualizado há {age_hours:.0f}h"

    size_mb = int(chosen.get("size", 0)) / (1024 * 1024)
    print(f"Selecionado: {chosen['name']} ({reason})")
    print(f"  Modificado: {chosen['modifiedTime']} ({age_hours:.0f}h atrás, {size_mb:.0f}MB){stale_warning}")

    return chosen, stale_warning


def download_file(drive_service, file_info, dest_dir):
    """Download a specific file from Drive."""
    from googleapiclient.http import MediaIoBaseDownload
    import io

    dest_path = os.path.join(dest_dir, file_info["name"])
    request = drive_service.files().get_media(fileId=file_info["id"])
    fh = io.FileIO(dest_path, "wb")
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while not done:
        status, done = downloader.next_chunk()
        if status:
            print(f"  Download {int(status.progress() * 100)}%")
    fh.close()
    print(f"Salvo em: {dest_path}")
    return dest_path


# ---------------------------------------------------------------------------
# Firebird: restore backup and query data
# ---------------------------------------------------------------------------
def restore_firebird_backup(backup_path, dest_dir):
    """Restore .fbconsumer (Firebird backup) to a .fdb database file."""
    db_path = os.path.join(dest_dir, "consumer.fdb")

    # Detect Firebird version from backup header
    with open(backup_path, "rb") as f:
        header = f.read(128)
    print(f"Backup header (hex): {header[:32].hex()}")
    print(f"Backup header (ascii): {header[:64]}")

    # Find gbak binary (Firebird 4 installs to /opt/firebird/bin/)
    gbak_bin = "gbak"
    for candidate in ["/opt/firebird/bin/gbak", "/usr/bin/gbak", "gbak"]:
        try:
            subprocess.run([candidate, "-z"], capture_output=True, timeout=5)
            gbak_bin = candidate
            break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    # Firebird env vars for embedded mode
    fb_env = os.environ.copy()
    fb_env["FIREBIRD_TMP"] = dest_dir
    fb_env["FIREBIRD_LOCK"] = dest_dir

    # Try gbak restore
    for extra_args in [[], ["-page_size", "16384"]]:
        try:
            result = subprocess.run(
                [gbak_bin, "-c", "-user", "SYSDBA", "-password", "masterkey",
                 *extra_args, backup_path, db_path],
                capture_output=True, text=True, timeout=300,
                env=fb_env
            )
            if result.returncode == 0:
                print(f"Restored backup to: {db_path}")
                return db_path
            print(f"gbak stderr: {result.stderr[:500]}")
            if os.path.exists(db_path):
                os.remove(db_path)
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            print(f"gbak failed: {e}")

    print("gbak restore failed, trying as raw .fdb file...")

    # If gbak fails, the file might already be a .fdb database
    import shutil
    shutil.copy2(backup_path, db_path)
    print(f"Copied as raw database to: {db_path}")
    return db_path


def query_sales_data(db_path):
    """
    Query the Consumer Firebird database for sales data.

    Note: Table/column names may vary by Consumer version.
    Common schema:
      VENDA (ID, DATA, HORA, TOTAL, STATUS, MESA, ...)
      ITEM_VENDA (ID, VENDA_ID, PRODUTO_ID, QUANTIDADE, VALOR_UNITARIO, VALOR_TOTAL, ...)
      PRODUTO (ID, NOME, PRECO, GRUPO_ID, ...)
      GRUPO (ID, NOME, ...)
      FORMA_PGTO or VENDA_PAGAMENTO (VENDA_ID, FORMA, VALOR, ...)

    The script will try multiple known schema variants.
    """
    import firebird.driver as fdb

    # Point firebird-driver to Firebird 4 client library if available
    fb_lib = "/opt/firebird/lib/libfbclient.so"
    if os.path.exists(fb_lib):
        fdb.driver_config.fb_client_library.value = fb_lib

    # Set Firebird env vars for embedded mode
    db_dir = os.path.dirname(db_path)
    os.environ.setdefault("FIREBIRD_TMP", db_dir)
    os.environ.setdefault("FIREBIRD_LOCK", db_dir)
    os.environ.setdefault("FIREBIRD", "/opt/firebird")

    con = fdb.connect(
        database=db_path,
        user="SYSDBA",
        password="masterkey",
        charset="WIN1252"
    )
    cur = con.cursor()

    # Discover tables
    cur.execute("""
        SELECT RDB$RELATION_NAME FROM RDB$RELATIONS
        WHERE RDB$SYSTEM_FLAG = 0
        ORDER BY RDB$RELATION_NAME
    """)
    tables = [row[0].strip() for row in cur.fetchall()]
    print(f"Found {len(tables)} tables:")
    for i in range(0, len(tables), 10):
        print(f"  {', '.join(tables[i:i+10])}")

    # Try to identify the sales table (Consumer uses PEDIDOS, not VENDA)
    sales_table = find_table(tables, ["PEDIDOS", "PEDIDO", "VENDA", "VENDAS", "MOVIMENTO", "MOV_VENDA"])
    items_table = find_table(tables, ["ITENSPEDIDO", "ITEMPEDIDO", "ITEM_VENDA", "ITENS_VENDA",
                                       "ITEM_MOV", "MOV_ITEM"])
    products_table = find_table(tables, ["PRODUTODETALHE", "PRODUTO", "PRODUTOS", "ITEM", "ITENS"])
    groups_table = find_table(tables, ["PRODUTOTIPO", "GRUPO", "GRUPOS", "CATEGORIA", "CATEGORIAS",
                                        "GRUPO_PRODUTO"])
    payment_table = find_table(tables, ["PAGAMENTOS", "PAGAMENTO", "VENDA_PAGAMENTO", "FORMA_PGTO",
                                         "MOV_PAGAMENTO", "RECEBIMENTO", "VENDA_FORMA_PGTO"])

    if not sales_table:
        print("ERROR: Could not identify sales table. Available tables:")
        for t in tables:
            print(f"  - {t}")
        # Save table list to help debug
        save_table_schema(cur, tables)
        con.close()
        return None

    print(f"Using tables: sales={sales_table}, items={items_table}, products={products_table}, "
          f"groups={groups_table}, payments={payment_table}")

    # Discover columns for the sales table
    sales_cols = get_columns(cur, sales_table)
    print(f"Sales columns: {sales_cols}")

    date_col = find_column(sales_cols, ["DATA", "DATAABERTURA", "DATAFECHAMENTO", "DATAPEDIDO",
                                         "DATA_VENDA", "DT_VENDA", "DATA_MOV", "DATAVENDA",
                                         "DATAHORAPEDIDO", "DATAHORA"])
    total_col = find_column(sales_cols, ["VALORTOTAL", "TOTAL", "TOTALFINAL", "TOTALPEDIDO",
                                          "VALOR_TOTAL", "VLR_TOTAL", "TOTAL_VENDA", "TOTALVENDA",
                                          "SUBTOTALPAGO"])
    time_col = find_column(sales_cols, ["HORA", "DATAABERTURA", "DATAFECHAMENTO", "HORAPEDIDO",
                                          "HORA_VENDA", "HR_VENDA", "DATAHORAPEDIDO", "DATAHORA"])
    status_col = find_column(sales_cols, ["STATUS", "SITUACAO", "SIT", "STATUSPEDIDO"])
    delete_col = find_column(sales_cols, ["DATADELETE"])

    sales_pk = find_column(sales_cols, ["ID", "IDPEDIDO", "CODIGO"])

    if not date_col or not total_col:
        print(f"ERROR: Could not identify date/total columns in {sales_table}")
        print(f"  Available: {sales_cols}")
        con.close()
        return None

    print(f"Mapped: date={date_col}, total={total_col}, time={time_col}, status={status_col}, "
          f"delete={delete_col}, pk={sales_pk}")

    # Query daily aggregates — filter cancelled orders
    if delete_col:
        status_filter = f"AND {delete_col} IS NULL"
    elif status_col:
        status_filter = f"AND {status_col} NOT IN ('C', 'CANCELADA', 'CANCELADO')"
    else:
        status_filter = ""

    daily_data = {}

    # Use CAST(x AS DATE) for TIMESTAMP columns so we aggregate by day
    date_expr = f"CAST({date_col} AS DATE)"

    # 1. Daily revenue and order count
    sql = f"""
        SELECT {date_expr}, COUNT(*), SUM({total_col})
        FROM {sales_table}
        WHERE {total_col} > 0 {status_filter}
        GROUP BY {date_expr}
        ORDER BY {date_expr}
    """
    print(f"Querying daily revenue...")
    cur.execute(sql)
    for row in cur.fetchall():
        dt = row[0]
        if dt is None:
            continue
        if isinstance(dt, datetime):
            date_str = dt.strftime("%Y-%m-%d")
        else:
            date_str = str(dt)[:10]

        daily_data[date_str] = {
            "faturamento": float(row[2] or 0),
            "qtdVendas": int(row[1] or 0),
            "ticketMedio": round(float(row[2] or 0) / max(int(row[1] or 1), 1), 2),
            "formasPagamento": {"pix": 0, "credito": 0, "debito": 0, "dinheiro": 0, "outros": 0},
            "porCategoria": [],
            "porHora": [],
            "topProdutos": [],
            "topProdutosPorCategoria": {}
        }

    print(f"Found {len(daily_data)} days of sales data")

    # 2. Payment methods per day
    if payment_table:
        pay_cols = get_columns(cur, payment_table)
        print(f"Payment columns: {pay_cols}")
        pay_value_col = find_column(pay_cols, ["VALOR", "VALORPAGO", "VLR", "TOTAL", "VALOR_PAGO"])
        pay_form_fk = find_column(pay_cols, ["CODIGOFORMAPAGAMENTO", "IDFORMAPAGAMENTO"])
        pay_form_col = find_column(pay_cols, ["FORMA", "DESCRICAO", "NOME", "TIPO",
                                               "FORMA_PGTO", "BANDEIRA", "FORMA_PAGAMENTO"])
        pay_sale_col = find_column(pay_cols, ["CODIGOPEDIDO", "IDPEDIDO", "VENDA_ID", "ID_VENDA",
                                               "COD_VENDA", "MOVIMENTO_ID"])
        pay_date_col = find_column(pay_cols, ["DATAPAGAMENTO", "DATA", "DATA_VENDA", "DT_VENDA"])

        # Build payment method name lookup if FORMASPAGAMENTO table exists
        formas_map = {}
        formas_table = find_table(tables, ["FORMASPAGAMENTO", "FORMAPAGAMENTO", "FORMA_PAGAMENTO"])
        if formas_table and pay_form_fk:
            f_cols = get_columns(cur, formas_table)
            f_name = find_column(f_cols, ["DESCRICAO", "NOME", "FORMA", "TIPO"])
            f_id = find_column(f_cols, ["CODIGO", "ID", "IDFORMAPAGAMENTO"])
            if f_name and f_id:
                try:
                    cur.execute(f"SELECT {f_id}, {f_name} FROM {formas_table}")
                    for row in cur.fetchall():
                        formas_map[row[0]] = str(row[1] or "").strip()
                    print(f"  Payment methods: {formas_map}")
                except Exception as e:
                    print(f"  Failed to load payment methods: {e}")

        form_col_or_fk = pay_form_fk or pay_form_col
        if pay_value_col and form_col_or_fk:
            if pay_sale_col and sales_pk:
                sql = f"""
                    SELECT CAST(v.{date_col} AS DATE), p.{form_col_or_fk}, SUM(p.{pay_value_col})
                    FROM {payment_table} p
                    JOIN {sales_table} v ON v.{sales_pk} = p.{pay_sale_col}
                    WHERE p.{pay_value_col} > 0
                    GROUP BY CAST(v.{date_col} AS DATE), p.{form_col_or_fk}
                """
            elif pay_date_col:
                sql = f"""
                    SELECT CAST({pay_date_col} AS DATE), {form_col_or_fk}, SUM({pay_value_col})
                    FROM {payment_table}
                    WHERE {pay_value_col} > 0
                    GROUP BY CAST({pay_date_col} AS DATE), {form_col_or_fk}
                """
            else:
                sql = None

            if sql:
                print("Querying payment methods...")
                try:
                    cur.execute(sql)
                    for row in cur.fetchall():
                        dt = row[0]
                        if dt is None:
                            continue
                        date_str = dt.strftime("%Y-%m-%d") if isinstance(dt, datetime) else str(dt)[:10]
                        if date_str not in daily_data:
                            continue
                        raw_form = row[1]
                        if pay_form_fk and formas_map:
                            form_name = formas_map.get(raw_form, str(raw_form or "")).upper()
                        else:
                            form_name = str(raw_form or "").strip().upper()
                        value = float(row[2] or 0)
                        key = classify_payment(form_name)
                        daily_data[date_str]["formasPagamento"][key] += value
                except Exception as e:
                    print(f"  Payment query failed: {e}")

    # 3. Revenue by hour
    if time_col:
        print("Querying hourly revenue...")
        sql = f"""
            SELECT {date_expr}, EXTRACT(HOUR FROM {time_col}), COUNT(*), SUM({total_col})
            FROM {sales_table}
            WHERE {total_col} > 0 {status_filter}
            GROUP BY {date_expr}, EXTRACT(HOUR FROM {time_col})
        """
        try:
            cur.execute(sql)
            for row in cur.fetchall():
                dt = row[0]
                if dt is None:
                    continue
                date_str = dt.strftime("%Y-%m-%d") if isinstance(dt, datetime) else str(dt)[:10]
                if date_str not in daily_data:
                    continue
                daily_data[date_str]["porHora"].append({
                    "hora": int(row[1] or 0),
                    "faturamento": float(row[3] or 0),
                    "qtd": int(row[2] or 0)
                })
        except Exception as e:
            print(f"  Hourly query failed: {e}")

    # 4. Top products per day (with real ETIQUETAS categories)
    if items_table and products_table:
        item_cols = get_columns(cur, items_table)
        print(f"Item columns: {item_cols}")
        item_qty_col = find_column(item_cols, ["QUANTIDADE", "QTD", "QTDE"])
        item_total_col = find_column(item_cols, ["VALORTOTAL", "VALOR_TOTAL", "VLR_TOTAL", "TOTAL",
                                                   "SUBTOTAL", "VALORFINAL"])
        item_prod_col = find_column(item_cols, ["CODIGOPRODUTODETALHE", "CODIGOPRODUTO",
                                                  "IDPRODUTODETALHE", "IDPRODUTO", "PRODUTO_ID",
                                                  "ID_PRODUTO", "COD_PRODUTO"])
        item_sale_col = find_column(item_cols, ["CODIGOPEDIDO", "IDPEDIDO", "VENDA_ID",
                                                  "ID_VENDA", "COD_VENDA", "MOVIMENTO_ID"])
        item_name_col = find_column(item_cols, ["NOMEPRODUTO", "NOME_PRODUTO"])

        # Build ETIQUETAS category map for product-level category resolution
        etiqueta_table = find_table(tables, ["ETIQUETAS", "ETIQUETA"])
        etiqueta_map = {}
        if etiqueta_table:
            e_cols = get_columns(cur, etiqueta_table)
            print(f"ETIQUETAS columns: {e_cols}")
            e_pk = find_column(e_cols, ["CODIGO", "ID"])
            e_desc = find_column(e_cols, ["DESCRICAO", "NOME"])
            if e_pk and e_desc:
                try:
                    cur.execute(f"SELECT {e_pk}, {e_desc} FROM {etiqueta_table}")
                    for row in cur.fetchall():
                        etiqueta_map[row[0]] = str(row[1] or "").strip()
                    print(f"  Loaded {len(etiqueta_map)} etiquetas: {etiqueta_map}")
                except Exception as e:
                    print(f"  Failed to load ETIQUETAS: {e}")

        # Discover PRODUTOS table (the actual products table, not PRODUTODETALHE)
        # products_table from main query is PRODUTODETALHE; we need the real PRODUTOS for CODIGOETIQUETA
        real_prod_table = find_table(tables, ["PRODUTOS"])
        prod_cols = get_columns(cur, real_prod_table) if real_prod_table else []
        print(f"PRODUTOS (real) columns: {prod_cols}")
        p_pk = find_column(prod_cols, ["CODIGO", "ID"]) if prod_cols else None
        p_etiqueta_col = find_column(prod_cols, ["CODIGOETIQUETA", "ETIQUETA_ID", "IDETIQUETA"]) if prod_cols else None

        # PRODUTODETALHE columns for join path (ITENSPEDIDO.CODIGOPRODUTODETALHE → PRODUTODETALHE.CODIGO → PRODUTODETALHE.CODIGOPRODUTO → PRODUTOS.CODIGO)
        prod_detail_table = find_table(tables, ["PRODUTODETALHE"])
        pd_cols = get_columns(cur, prod_detail_table) if prod_detail_table else []
        pd_pk = find_column(pd_cols, ["CODIGO", "ID"]) if pd_cols else None
        pd_prod_fk = find_column(pd_cols, ["CODIGOPRODUTO", "PRODUTO_ID", "IDPRODUTO"]) if pd_cols else None
        print(f"PRODUTODETALHE join: pk={pd_pk}, prod_fk={pd_prod_fk}")

        # Prefer joining through PRODUTODETALHE -> PRODUTOS -> ETIQUETAS for real categories
        if item_qty_col and item_total_col and item_sale_col and item_name_col:
            joined_status = ""
            if delete_col:
                joined_status = f"AND v.{delete_col} IS NULL"
            elif status_col:
                joined_status = f"AND v.{status_col} NOT IN ('C', 'CANCELADA', 'CANCELADO')"

            # Try the full join: ITENSPEDIDO -> PRODUTODETALHE -> PRODUTOS -> ETIQUETAS
            use_etiqueta_join = (etiqueta_map and prod_detail_table and real_prod_table
                                 and item_prod_col and pd_pk and pd_prod_fk
                                 and p_pk and p_etiqueta_col)

            if use_etiqueta_join:
                print(f"Querying product sales (with ETIQUETAS: i.{item_prod_col} → pd.{pd_pk} → pd.{pd_prod_fk} → p.{p_pk} → p.{p_etiqueta_col} → e.{e_pk})...")
                sql = f"""
                    SELECT CAST(v.{date_col} AS DATE),
                           i.{item_name_col},
                           e.{e_desc},
                           SUM(i.{item_qty_col}),
                           SUM(i.{item_total_col})
                    FROM {items_table} i
                    JOIN {sales_table} v ON v.{sales_pk or 'CODIGO'} = i.{item_sale_col}
                    LEFT JOIN {prod_detail_table} pd ON pd.{pd_pk} = i.{item_prod_col}
                    LEFT JOIN {real_prod_table} p ON p.{p_pk} = pd.{pd_prod_fk}
                    LEFT JOIN {etiqueta_table} e ON e.{e_pk} = p.{p_etiqueta_col}
                    WHERE i.{item_total_col} > 0 AND i.{item_name_col} IS NOT NULL {joined_status}
                    GROUP BY CAST(v.{date_col} AS DATE), i.{item_name_col}, e.{e_desc}
                    ORDER BY CAST(v.{date_col} AS DATE), SUM(i.{item_total_col}) DESC
                """
            else:
                print("Querying product sales (no ETIQUETAS join available, falling back)...")
                sql = f"""
                    SELECT CAST(v.{date_col} AS DATE), i.{item_name_col}, NULL,
                           SUM(i.{item_qty_col}), SUM(i.{item_total_col})
                    FROM {items_table} i
                    JOIN {sales_table} v ON v.{sales_pk or 'CODIGO'} = i.{item_sale_col}
                    WHERE i.{item_total_col} > 0 AND i.{item_name_col} IS NOT NULL {joined_status}
                    GROUP BY CAST(v.{date_col} AS DATE), i.{item_name_col}
                    ORDER BY CAST(v.{date_col} AS DATE), SUM(i.{item_total_col}) DESC
                """

            try:
                cur.execute(sql)
                day_products = defaultdict(list)
                day_categories = defaultdict(lambda: defaultdict(lambda: {"faturamento": 0, "qtd": 0}))
                # Track products per category per day for topProdutosPorCategoria
                day_cat_products = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: {"qtd": 0, "faturamento": 0})))

                for row in cur.fetchall():
                    dt = row[0]
                    if dt is None:
                        continue
                    date_str = dt.strftime("%Y-%m-%d") if isinstance(dt, datetime) else str(dt)[:10]
                    if date_str not in daily_data:
                        continue
                    prod_name = (str(row[1] or "")).strip()
                    cat_name = (str(row[2] or "")).strip() or "Sem categoria"
                    qty = float(row[3] or 0)
                    total = float(row[4] or 0)

                    day_products[date_str].append({"nome": prod_name, "categoria": cat_name, "qtd": qty, "faturamento": total})
                    day_categories[date_str][cat_name]["faturamento"] += total
                    day_categories[date_str][cat_name]["qtd"] += qty
                    day_cat_products[date_str][cat_name][prod_name]["qtd"] += qty
                    day_cat_products[date_str][cat_name][prod_name]["faturamento"] += total

                for date_str in daily_data:
                    prods = day_products.get(date_str, [])
                    prods.sort(key=lambda x: x["faturamento"], reverse=True)
                    daily_data[date_str]["topProdutos"] = prods[:15]

                    cats = day_categories.get(date_str, {})
                    daily_data[date_str]["porCategoria"] = [
                        {"nome": k, "faturamento": v["faturamento"], "qtd": v["qtd"]}
                        for k, v in sorted(cats.items(), key=lambda x: x[1]["faturamento"], reverse=True)
                    ]

                    # Build topProdutosPorCategoria: { "Drinks": [...], "Grill": [...], ... }
                    cat_prods = day_cat_products.get(date_str, {})
                    top_by_cat = {}
                    for cat, prods_in_cat in cat_prods.items():
                        items_sorted = sorted(
                            [{"nome": pn, "qtd": pv["qtd"], "faturamento": pv["faturamento"]}
                             for pn, pv in prods_in_cat.items()],
                            key=lambda x: x["faturamento"], reverse=True
                        )
                        top_by_cat[cat] = items_sorted[:10]
                    daily_data[date_str]["topProdutosPorCategoria"] = top_by_cat

            except Exception as e:
                print(f"  Product query failed: {e}")
                import traceback
                traceback.print_exc()

    con.close()
    return daily_data


def query_financial_data(db_path):
    """
    Query financial tables from Consumer: contas a pagar, fornecedores, compras.

    Common Consumer tables:
      CONTA_PAGAR / CONTAS_PAGAR (ID, DESCRICAO, FORNECEDOR_ID, VALOR, VENCIMENTO, STATUS, ...)
      FORNECEDOR / FORNECEDORES (ID, NOME, CNPJ, TELEFONE, EMAIL, ...)
      COMPRA / COMPRAS / ENTRADA / NOTA_ENTRADA (ID, DATA, FORNECEDOR_ID, TOTAL, NOTA, ...)
    """
    import firebird.driver as fdb

    con = fdb.connect(database=db_path, user="SYSDBA", password="masterkey", charset="WIN1252")
    cur = con.cursor()

    cur.execute("""
        SELECT RDB$RELATION_NAME FROM RDB$RELATIONS
        WHERE RDB$SYSTEM_FLAG = 0 ORDER BY RDB$RELATION_NAME
    """)
    tables = [row[0].strip() for row in cur.fetchall()]

    result = {}

    # ── Fornecedores ──
    forn_table = find_table(tables, [
        "FORNECEDORES", "FORNECEDOR", "CONTATOS", "CLIENTE_FORNECEDOR",
        "CADASTRO_FORNECEDOR", "PESSOA_FORNECEDOR"
    ])
    forn_map = {}
    if forn_table:
        cols = get_columns(cur, forn_table)
        print(f"Fornecedores columns: {cols}")
        name_col = find_column(cols, ["NOME", "RAZAOSOCIAL", "RAZAO_SOCIAL", "RAZAO",
                                       "NOMEFANTASIA", "NOME_FANTASIA", "FANTASIA", "DESCRICAO"])
        cnpj_col = find_column(cols, ["CNPJOUCPF", "CNPJ", "CNPJCPF", "CNPJ_CPF", "CPF_CNPJ",
                                       "CGC", "DOCUMENTO"])
        tel_col = find_column(cols, ["FONEPRINCIPAL", "TELEFONE", "FONE", "TEL", "TELEFONE1",
                                      "CELULAR", "FONESECUNDARIO"])
        email_col = find_column(cols, ["EMAIL", "E_MAIL", "CORREIO"])
        id_col = find_column(cols, ["CODIGO", "ID", "IDCONTATO", "IDFORNECEDOR", "COD",
                                     "ID_FORNECEDOR"])

        if name_col and id_col:
            select_parts = [f"{id_col}", f"{name_col}"]
            if cnpj_col: select_parts.append(f"{cnpj_col}")
            if tel_col: select_parts.append(f"{tel_col}")
            if email_col: select_parts.append(f"{email_col}")

            sql = f"SELECT {', '.join(select_parts)} FROM {forn_table} ORDER BY {name_col}"
            try:
                cur.execute(sql)
                items = []
                for row in cur.fetchall():
                    fid = row[0]
                    item = {"nome": str(row[1] or "").strip()}
                    idx = 2
                    if cnpj_col:
                        item["cnpj"] = str(row[idx] or "").strip(); idx += 1
                    if tel_col:
                        item["telefone"] = str(row[idx] or "").strip(); idx += 1
                    if email_col:
                        item["email"] = str(row[idx] or "").strip(); idx += 1
                    if item["nome"]:
                        items.append(item)
                        forn_map[fid] = item["nome"]

                if items:
                    result["fornecedores"] = {"items": items, "syncedAt": datetime.utcnow().isoformat()}
                    print(f"  Found {len(items)} fornecedores")
            except Exception as e:
                print(f"  Fornecedores query failed: {e}")

    # ── Contas a Pagar ──
    cp_table = find_table(tables, [
        "CONTASPAGAR", "CONTA_PAGAR", "CONTAS_PAGAR", "CONTAS_A_PAGAR", "CONTA",
        "TITULO_PAGAR", "TITULO", "FINANCEIRO", "FIN_PAGAR",
        "LANCAMENTO", "LANCAMENTO_PAGAR"
    ])
    if cp_table:
        cols = get_columns(cur, cp_table)
        print(f"Contas a pagar columns: {cols}")
        desc_col = find_column(cols, ["DESCRICAO", "HISTORICO", "OBSERVACAO", "OBS", "COMPLEMENTO",
                                       "DOCUMENTO", "NOMEFORNECEDOR"])
        valor_col = find_column(cols, ["VALOR", "VALORTOTAL", "VLR", "VALOR_TITULO", "VALOR_ORIGINAL"])
        venc_col = find_column(cols, ["DATAVENCIMENTO", "VENCIMENTO", "DT_VENCIMENTO",
                                       "DATA_VENCIMENTO", "VENCTO"])
        cp_status_col = find_column(cols, ["STATUS", "SITUACAO", "SIT", "PAGO", "QUITADO"])
        forn_col = find_column(cols, ["CODIGOFORNECEDOR", "IDFORNECEDOR", "IDCONTATO",
                                       "FORNECEDOR_ID", "ID_FORNECEDOR", "COD_FORNECEDOR",
                                       "PESSOA_ID", "CLIENTE_ID", "CREDOR_ID"])
        data_col = find_column(cols, ["DATACADASTRO", "DATA", "DATAEMISSAO", "DATA_EMISSAO",
                                       "DT_EMISSAO", "DATA_LANCAMENTO", "DATALANCAMENTO"])
        valor_pago_col = find_column(cols, ["VALORPAGO", "VALOR_PAGO", "VLR_PAGO", "VALOR_QUITADO"])
        cp_delete_col = find_column(cols, ["DATADELETE"])

        if valor_col and venc_col:
            select = [desc_col or f"'{cp_table}'"]
            if forn_col: select.append(forn_col)
            select.extend([valor_col, venc_col])
            if cp_status_col: select.append(cp_status_col)
            if valor_pago_col: select.append(valor_pago_col)

            where = ""
            if cp_delete_col:
                where = f"WHERE {cp_delete_col} IS NULL"

            sql = f"SELECT {', '.join(select)} FROM {cp_table} {where} ORDER BY {venc_col} DESC"
            try:
                cur.execute(sql)
                items = []
                total_pagar = 0
                total_vencido = 0
                today = datetime.now().strftime("%Y-%m-%d")

                for row in cur.fetchall():
                    idx = 0
                    descricao = str(row[idx] or "").strip(); idx += 1
                    fornecedor_nome = ""
                    if forn_col:
                        fid = row[idx]; idx += 1
                        fornecedor_nome = forn_map.get(fid, str(fid or ""))
                    valor = float(row[idx] or 0); idx += 1
                    venc_raw = row[idx]; idx += 1
                    vencimento = venc_raw.strftime("%Y-%m-%d") if isinstance(venc_raw, datetime) else str(venc_raw or "")[:10]

                    status = ""
                    if cp_status_col:
                        s = str(row[idx] or "").strip().upper(); idx += 1
                        if s in ("P", "PAGO", "S", "SIM", "1", "Q", "QUITADO"):
                            status = "pago"
                        else:
                            status = "pendente"
                    elif valor_pago_col:
                        status = "pendente"
                    else:
                        status = "pendente"

                    if valor_pago_col:
                        vp = float(row[idx] or 0); idx += 1
                        if vp >= valor and valor > 0:
                            status = "pago"

                    item = {
                        "descricao": descricao,
                        "fornecedor": fornecedor_nome,
                        "valor": valor,
                        "vencimento": vencimento,
                        "status": status,
                    }
                    items.append(item)

                    if status != "pago":
                        total_pagar += valor
                        if vencimento < today:
                            total_vencido += valor

                if items:
                    result["contas_pagar"] = {"items": items[:500], "syncedAt": datetime.utcnow().isoformat()}
                    result["resumo"] = {
                        "totalAPagar": total_pagar,
                        "totalVencido": total_vencido,
                        "totalContas": len(items),
                        "syncedAt": datetime.utcnow().isoformat()
                    }
                    print(f"  Found {len(items)} contas a pagar (total: R$ {total_pagar:,.2f}, vencido: R$ {total_vencido:,.2f})")
            except Exception as e:
                print(f"  Contas a pagar query failed: {e}")

    # ── Compras / Notas de Entrada ──
    compra_table = find_table(tables, [
        "ESTOQUEMOVIMENTACAO", "COMPRA", "COMPRAS", "ENTRADA", "NOTA_ENTRADA",
        "ENTRADA_MERCADORIA", "NFE_ENTRADA", "NOTA_FISCAL_ENTRADA", "PEDIDO_COMPRA"
    ])
    if compra_table:
        cols = get_columns(cur, compra_table)
        data_col = find_column(cols, ["DATA", "DATA_ENTRADA", "DT_ENTRADA", "DATA_EMISSAO", "DATA_COMPRA"])
        total_col = find_column(cols, ["TOTAL", "VALOR_TOTAL", "VLR_TOTAL", "TOTAL_NOTA"])
        nota_col = find_column(cols, ["NOTA", "NUMERO_NOTA", "NR_NOTA", "NOTA_FISCAL", "NUMERO", "NFE"])
        forn_col = find_column(cols, ["FORNECEDOR_ID", "ID_FORNECEDOR", "COD_FORNECEDOR", "PESSOA_ID"])

        if data_col and total_col:
            select = [data_col, total_col]
            if nota_col: select.append(nota_col)
            if forn_col: select.append(forn_col)

            sql = f"SELECT {', '.join(select)} FROM {compra_table} WHERE {total_col} > 0 ORDER BY {data_col} DESC"
            try:
                cur.execute(sql)
                items = []
                for row in cur.fetchall():
                    idx = 0
                    dt_raw = row[idx]; idx += 1
                    data_str = dt_raw.strftime("%Y-%m-%d") if isinstance(dt_raw, datetime) else str(dt_raw or "")[:10]
                    total = float(row[idx] or 0); idx += 1
                    nota = ""
                    if nota_col:
                        nota = str(row[idx] or "").strip(); idx += 1
                    fornecedor_nome = ""
                    if forn_col:
                        fid = row[idx]; idx += 1
                        fornecedor_nome = forn_map.get(fid, str(fid or ""))

                    items.append({
                        "data": data_str,
                        "total": total,
                        "nota": nota,
                        "fornecedor": fornecedor_nome,
                    })

                if items:
                    result["compras"] = {"items": items[:500], "syncedAt": datetime.utcnow().isoformat()}
                    total_compras = sum(i["total"] for i in items)
                    print(f"  Found {len(items)} compras (total: R$ {total_compras:,.2f})")
            except Exception as e:
                print(f"  Compras query failed: {e}")

    con.close()

    if not result:
        print("  No financial tables found. Skipping financial data.")
        return None

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def find_table(tables, candidates):
    for c in candidates:
        for t in tables:
            if t.upper() == c.upper():
                return t
    return None


def get_columns(cur, table):
    cur.execute(f"""
        SELECT RDB$FIELD_NAME FROM RDB$RELATION_FIELDS
        WHERE RDB$RELATION_NAME = '{table}'
        ORDER BY RDB$FIELD_POSITION
    """)
    return [row[0].strip() for row in cur.fetchall()]


def find_column(columns, candidates):
    for c in candidates:
        for col in columns:
            if col.upper() == c.upper():
                return col
    return None


def classify_payment(name):
    name = name.upper()
    if any(k in name for k in ["PIX"]):
        return "pix"
    if any(k in name for k in ["CRED", "CRÉDITO", "CREDIT"]):
        return "credito"
    if any(k in name for k in ["DEB", "DÉBITO", "DEBIT"]):
        return "debito"
    if any(k in name for k in ["DINH", "ESPE", "CASH"]):
        return "dinheiro"
    return "outros"


def save_table_schema(cur, tables):
    """Save full schema to help debug unknown Consumer versions."""
    schema = {}
    for t in tables:
        cols = get_columns(cur, t)
        schema[t] = cols
    with open("/tmp/consumer_schema.json", "w") as f:
        json.dump(schema, f, indent=2)
    print("Schema saved to /tmp/consumer_schema.json")


# ---------------------------------------------------------------------------
# Firestore upload
# ---------------------------------------------------------------------------
def upload_to_firestore(daily_data, financial_data=None, sync_meta=None):
    import firebase_admin
    from firebase_admin import credentials, firestore

    creds_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if not creds_json:
        raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_JSON not set")

    cred = credentials.Certificate(json.loads(creds_json))
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    # Upload daily sales data
    batch_size = 0
    batch = db.batch()

    for date_str, data in daily_data.items():
        ref = db.document(f"{FIRESTORE_PATH_FAT}/{date_str}")
        batch.set(ref, data)
        batch_size += 1

        if batch_size >= 400:
            batch.commit()
            print(f"  Committed {batch_size} faturamento documents")
            batch = db.batch()
            batch_size = 0

    if batch_size > 0:
        batch.commit()
        print(f"  Committed {batch_size} faturamento documents")

    print(f"Uploaded {len(daily_data)} days to Firestore ({FIRESTORE_PATH_FAT})")

    # Upload financial data
    if financial_data:
        for key, data in financial_data.items():
            db.document(f"{FIRESTORE_PATH_FIN}/{key}").set(data)
            print(f"  Uploaded financeiro/{key}")
        print(f"Uploaded {len(financial_data)} financial documents to Firestore ({FIRESTORE_PATH_FIN})")

    # Upload sync metadata
    if sync_meta:
        db.document(f"{FIRESTORE_PATH_FIN}/sync_status").set(sync_meta)
        print(f"  Uploaded sync_status: {sync_meta['arquivo']}")


# ---------------------------------------------------------------------------
# Static JSON export (for GitHub Pages dashboard)
# ---------------------------------------------------------------------------
def write_static_json(daily_data, financial_data, db_path, repo_root):
    """Write static JSON files to public/data/ for the dashboard."""
    import firebird.driver as fdb

    data_dir = os.path.join(repo_root, "public", "data")
    os.makedirs(data_dir, exist_ok=True)
    now_iso = datetime.utcnow().isoformat()

    # 1. faturamento.json — array sorted by date
    fat_array = []
    for date_str in sorted(daily_data.keys()):
        entry = dict(daily_data[date_str])
        entry["date"] = date_str
        fat_array.append(entry)

    fat_path = os.path.join(data_dir, "faturamento.json")
    with open(fat_path, "w", encoding="utf-8") as f:
        json.dump(fat_array, f, ensure_ascii=False)
    print(f"  Wrote {fat_path} ({len(fat_array)} days)")

    # 2. financeiro.json — flat object with contas_pagar, fornecedores, compras, resumo, resumoMensal
    if financial_data:
        fin = dict(financial_data)
        # Build resumoMensal from contas_pagar
        cp_items = fin.get("contas_pagar", {}).get("items", [])
        monthly = defaultdict(lambda: {"receita": 0, "despesa": 0})
        for item in cp_items:
            venc = item.get("vencimento", "")[:7]  # YYYY-MM
            if venc:
                monthly[venc]["despesa"] += item.get("valor", 0)
        # Add revenue from faturamento
        for date_str, data in daily_data.items():
            mes = date_str[:7]
            monthly[mes]["receita"] += data.get("faturamento", 0)
        fin["resumoMensal"] = [{"mes": k, "receita": round(v["receita"], 2), "despesa": round(v["despesa"], 2)}
                               for k, v in sorted(monthly.items())]
        # resumo
        total_despesa = sum(i.get("valor", 0) for i in cp_items)
        total_pago = sum(i.get("valorPago", 0) for i in cp_items if i.get("status") == "pago")
        fin["resumo"] = {
            "totalContas": len(cp_items),
            "totalDespesa": round(total_despesa, 2),
            "totalPago": round(total_pago, 2),
        }

        fin_path = os.path.join(data_dir, "financeiro.json")
        with open(fin_path, "w", encoding="utf-8") as f:
            json.dump(fin, f, ensure_ascii=False)
        print(f"  Wrote {fin_path}")

    # 3. clientes.json — extract from CONTATOS table
    try:
        con = fdb.connect(database=db_path, user="SYSDBA", password="masterkey", charset="WIN1252")
        cur = con.cursor()
        tables = [row[0].strip() for row in cur.execute(
            "SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE RDB$SYSTEM_FLAG=0").fetchall()]

        contatos_table = find_table(tables, ["CONTATOS", "CONTATO", "PESSOA", "PESSOAS", "CLIENTE", "CLIENTES"])
        if contatos_table:
            cols = get_columns(cur, contatos_table)
            print(f"CONTATOS columns ({contatos_table}): {cols}")
            nome_col = find_column(cols, ["NOME", "RAZAOSOCIAL", "RAZAO_SOCIAL", "NOMECLIENTE"])
            tel_col = find_column(cols, ["FONECELULAR", "TELEFONE", "CELULAR", "FONE", "TEL"])
            nasc_col = find_column(cols, ["DATANASCIMENTO", "NASCIMENTO", "DATA_NASCIMENTO", "DTNASC"])
            pk_col = find_column(cols, ["CODIGO", "ID", "IDCONTATO", "IDPESSOA", "COD"])
            sexo_col = find_column(cols, ["SEXO", "GENERO"])
            delete_col_c = find_column(cols, ["DATADELETE"])

            if nome_col:
                # Get spending data per client using CODIGOCONTATOCLIENTE from PEDIDOS
                spending = {}
                sales_table = find_table(tables, ["PEDIDOS", "PEDIDO", "VENDA", "VENDAS"])
                if sales_table:
                    s_cols = get_columns(cur, sales_table)
                    s_contato = find_column(s_cols, ["CODIGOCONTATOCLIENTE", "IDPESSOA", "PESSOA_ID",
                                                      "CLIENTE_ID", "ID_PESSOA", "IDCLIENTE"])
                    s_total = find_column(s_cols, ["VALORTOTAL", "TOTAL", "TOTALFINAL", "TOTALPEDIDO", "SUBTOTALPAGO"])
                    s_date = find_column(s_cols, ["DATA", "DATAABERTURA", "DATAFECHAMENTO", "DATAPEDIDO", "DATAHORAPEDIDO"])
                    s_delete = find_column(s_cols, ["DATADELETE"])
                    if s_contato and s_total:
                        del_filter = f"AND {s_delete} IS NULL" if s_delete else ""
                        cur.execute(f"""
                            SELECT {s_contato}, COUNT(*), SUM({s_total}), MAX({s_date})
                            FROM {sales_table}
                            WHERE {s_total} > 0 {del_filter}
                            GROUP BY {s_contato}
                        """)
                        for row in cur.fetchall():
                            pid = row[0]
                            if pid:
                                last_dt = row[3]
                                if isinstance(last_dt, datetime):
                                    last_str = last_dt.strftime("%Y-%m-%d")
                                else:
                                    last_str = str(last_dt or "")[:10]
                                spending[pid] = {
                                    "pedidos": int(row[1] or 0),
                                    "totalGasto": round(float(row[2] or 0), 2),
                                    "ultimoPedido": last_str,
                                }

                select_cols = [nome_col]
                if pk_col: select_cols.insert(0, pk_col)
                if tel_col: select_cols.append(tel_col)
                if nasc_col: select_cols.append(nasc_col)
                if sexo_col: select_cols.append(sexo_col)

                # Filter: non-null name, not deleted, not starting with '* Exclu'
                where_parts = [f"{nome_col} IS NOT NULL"]
                if delete_col_c:
                    where_parts.append(f"{delete_col_c} IS NULL")
                where_parts.append(f"{nome_col} NOT LIKE '* Exclu%'")
                where_clause = " AND ".join(where_parts)

                cur.execute(f"SELECT {', '.join(select_cols)} FROM {contatos_table} WHERE {where_clause} ORDER BY {nome_col}")
                contatos = []
                com_tel = 0
                com_nasc = 0
                com_sexo = 0
                aniv_por_mes = [0] * 12
                for row in cur.fetchall():
                    idx = 0
                    pid = None
                    if pk_col:
                        pid = row[idx]; idx += 1
                    nome = str(row[idx] or "").strip(); idx += 1
                    telefone = ""
                    if tel_col:
                        telefone = str(row[idx] or "").strip(); idx += 1
                    nascimento = ""
                    if nasc_col:
                        raw = row[idx]; idx += 1
                        if raw:
                            if isinstance(raw, datetime):
                                nascimento = raw.strftime("%Y-%m-%d")
                            else:
                                nascimento = str(raw)[:10]
                    sexo = None
                    if sexo_col:
                        raw_sexo = row[idx]; idx += 1
                        if raw_sexo:
                            sexo = str(raw_sexo).strip()

                    if not nome or nome.upper() in ("NONE", "NULL", ""):
                        continue
                    # Double-check exclusion filter (belt and suspenders)
                    if nome.startswith("* Exclu"):
                        continue

                    c = {"nome": nome, "telefone": telefone, "nascimento": nascimento, "sexo": sexo}
                    sp = spending.get(pid, {})
                    c["totalGasto"] = sp.get("totalGasto", 0)
                    c["pedidos"] = sp.get("pedidos", 0)
                    c["ultimoPedido"] = sp.get("ultimoPedido", "")
                    contatos.append(c)
                    if telefone:
                        com_tel += 1
                    if nascimento:
                        com_nasc += 1
                        try:
                            m = int(nascimento.split("-")[1])
                            aniv_por_mes[m - 1] += 1
                        except (IndexError, ValueError):
                            pass
                    if sexo:
                        com_sexo += 1

                cli_data = {
                    "syncedAt": now_iso,
                    "totalContatos": len(contatos),
                    "comTelefone": com_tel,
                    "comNascimento": com_nasc,
                    "comSexo": com_sexo,
                    "aniversariosPorMes": aniv_por_mes,
                    "contatos": contatos,
                }
                cli_path = os.path.join(data_dir, "clientes.json")
                with open(cli_path, "w", encoding="utf-8") as f:
                    json.dump(cli_data, f, ensure_ascii=False)
                print(f"  Wrote {cli_path} ({len(contatos)} contatos, {com_tel} com tel, {com_sexo} com sexo)")

        # 4. produtos-consumer.json + estoque.json + cardapio.json
        prod_detail = find_table(tables, ["PRODUTODETALHE"])
        prod_table = find_table(tables, ["PRODUTOS"])
        groups_table = find_table(tables, ["PRODUTOTIPO", "GRUPO", "GRUPOS", "CATEGORIA"])
        if prod_detail and prod_table:
            pd_cols = get_columns(cur, prod_detail)
            p_cols = get_columns(cur, prod_table)

            pd_pk = find_column(pd_cols, ["CODIGO", "ID"])
            pd_prod = find_column(pd_cols, ["CODIGOPRODUTO", "PRODUTO_ID", "IDPRODUTO"])
            pd_est_atual = find_column(pd_cols, ["ESTOQUEATUAL"])
            pd_est_min = find_column(pd_cols, ["ESTOQUEMINIMO"])
            pd_preco_custo = find_column(pd_cols, ["PRECOCUSTO"])
            pd_preco_venda = find_column(pd_cols, ["PRECOVENDA"])
            p_nome = find_column(p_cols, ["NOME", "DESCRICAO"])
            p_tipo = find_column(p_cols, ["TIPO"])
            p_grupo = find_column(p_cols, ["CODIGOPRODUTOTIPO", "GRUPO_ID", "IDGRUPO", "TIPO_ID"])

            # Load category names from ETIQUETAS (real menu categories in Consumer POS)
            cat_map = {}
            etiqueta_table = find_table(tables, ["ETIQUETAS", "ETIQUETA"])
            p_etiqueta = find_column(p_cols, ["CODIGOETIQUETA", "ETIQUETA_ID", "IDETIQUETA"])
            if etiqueta_table and p_etiqueta:
                e_cols = get_columns(cur, etiqueta_table)
                e_pk = find_column(e_cols, ["CODIGO", "ID"])
                e_desc = find_column(e_cols, ["DESCRICAO", "NOME"])
                if e_pk and e_desc:
                    cur.execute(f"SELECT {e_pk}, {e_desc} FROM {etiqueta_table}")
                    for row in cur.fetchall():
                        cat_map[row[0]] = str(row[1] or "").strip()
                    print(f"  Loaded {len(cat_map)} categories from {etiqueta_table}")
            elif groups_table:
                # Fallback to PRODUTOTIPO
                g_cols = get_columns(cur, groups_table)
                g_pk = find_column(g_cols, ["CODIGO", "ID"])
                g_nome = find_column(g_cols, ["NOME", "DESCRICAO"])
                if g_pk and g_nome:
                    cur.execute(f"SELECT {g_pk}, {g_nome} FROM {groups_table}")
                    for row in cur.fetchall():
                        cat_map[row[0]] = str(row[1] or "").strip()
                    print(f"  Loaded {len(cat_map)} categories from {groups_table} (fallback)")
                p_etiqueta = p_grupo  # Use grupo column as fallback

            cur.execute(f"""
                SELECT pd.{pd_pk}, pd.{pd_prod}, p.{p_nome},
                       COALESCE(pd.{pd_est_atual}, 0), COALESCE(pd.{pd_est_min}, 0),
                       COALESCE(pd.{pd_preco_custo}, 0), COALESCE(pd.{pd_preco_venda}, 0),
                       {('p.' + p_etiqueta) if p_etiqueta else 'NULL'},
                       {('p.' + p_tipo) if p_tipo else 'NULL'}
                FROM {prod_detail} pd
                LEFT JOIN {prod_table} p ON pd.{pd_prod} = p.CODIGO
                WHERE p.{p_nome} NOT LIKE '%* Exclu%'
                ORDER BY p.{p_nome}
            """)

            produtos = []
            insumos = []
            estoque_itens = []
            for row in cur.fetchall():
                pd_code = row[0]
                prod_code = row[1]
                nome = str(row[2] or "").strip()
                est_atual = float(row[3] or 0)
                est_min = float(row[4] or 0)
                preco_custo = float(row[5] or 0)
                preco_venda = float(row[6] or 0)
                etiqueta_id = row[7]
                tipo = str(row[8] or "").strip()

                if not nome:
                    continue

                categoria = cat_map.get(etiqueta_id, "SEM CATEGORIA") if etiqueta_id else "SEM CATEGORIA"

                item = {
                    "codigo": prod_code,
                    "nome": nome,
                    "categoria": categoria,
                    "tipo": tipo,
                    "precoVenda": round(preco_venda, 2),
                    "precoCusto": round(preco_custo, 2),
                }
                if preco_venda > 0:
                    produtos.append(item)
                else:
                    insumos.append(item)

                # Estoque
                status = "ok"
                if est_min > 0:
                    if est_atual <= est_min:
                        status = "baixo"
                    elif est_atual <= est_min * 1.5:
                        status = "atencao"
                estoque_itens.append({
                    "pdCodigo": pd_code,
                    "prodCodigo": prod_code,
                    "nome": nome,
                    "estoqueAtual": est_atual,
                    "estoqueMinimo": est_min,
                    "precoCusto": preco_custo,
                    "precoVenda": preco_venda,
                    "categoria": categoria,
                    "tipo": tipo,
                    "status": status,
                })

            # produtos-consumer.json
            prod_path = os.path.join(data_dir, "produtos-consumer.json")
            with open(prod_path, "w", encoding="utf-8") as f:
                json.dump({"syncedAt": now_iso, "produtos": produtos, "insumos": insumos}, f, ensure_ascii=False)
            print(f"  Wrote {prod_path} ({len(produtos)} produtos, {len(insumos)} insumos)")

            # estoque.json
            est_baixo = sum(1 for i in estoque_itens if i["status"] == "baixo")
            est_atencao = sum(1 for i in estoque_itens if i["status"] == "atencao")
            est_path = os.path.join(data_dir, "estoque.json")
            with open(est_path, "w", encoding="utf-8") as f:
                json.dump({
                    "syncedAt": now_iso,
                    "totalItens": len(estoque_itens),
                    "comMinimo": sum(1 for i in estoque_itens if i["estoqueMinimo"] > 0),
                    "estoqueBaixo": est_baixo,
                    "estoqueAtencao": est_atencao,
                    "itens": estoque_itens,
                }, f, ensure_ascii=False)
            print(f"  Wrote {est_path} ({len(estoque_itens)} itens, {est_baixo} baixo, {est_atencao} atenção)")

            # cardapio.json — products grouped by category (only sellable items)
            from collections import OrderedDict
            cardapio_cats = defaultdict(list)
            for p in produtos:
                cardapio_cats[p["categoria"]].append({
                    "name": p["nome"],
                    "price": p["precoVenda"],
                })
            cardapio = {
                "syncedAt": now_iso,
                "source": "consumer-pos",
                "totalProdutos": len(produtos),
                "categories": [
                    {"category": cat, "items": sorted(items, key=lambda x: x["name"])}
                    for cat, items in sorted(cardapio_cats.items())
                ],
            }
            card_path = os.path.join(data_dir, "cardapio.json")
            with open(card_path, "w", encoding="utf-8") as f:
                json.dump(cardapio, f, ensure_ascii=False)
            print(f"  Wrote {card_path} ({len(cardapio['categories'])} categorias)")

        con.close()
    except Exception as e:
        print(f"  Warning: could not extract clientes/produtos/estoque: {e}")
        import traceback
        traceback.print_exc()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    from datetime import timezone

    now_brt = datetime.now(timezone.utc) + BRT_OFFSET
    now_brt = now_brt.replace(tzinfo=timezone(BRT_OFFSET))

    # Detect repo root (for static JSON output)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(script_dir)

    print("=" * 60)
    print(f"Consumer Backup → Firestore Sync ({now_brt.strftime('%Y-%m-%d %H:%M BRT')})")
    print("=" * 60)

    with tempfile.TemporaryDirectory() as tmp:
        # 1. Select and download from Google Drive
        print("\n[1/6] Selecting backup from Google Drive...")
        drive = get_drive_service()
        files = list_drive_backups(drive)

        if not files:
            print("Nenhum arquivo .fbconsumer encontrado no Drive. Nada a sincronizar.")
            sys.exit(0)

        chosen, stale_warning = pick_backup(files, now_brt)
        if not chosen:
            print(f"Backup não encontrado: {stale_warning}")
            sys.exit(0)

        print(f"\nBaixando {chosen['name']}...")
        backup_path = download_file(drive, chosen, tmp)

        # 2. Restore Firebird database
        print("\n[2/6] Restoring Firebird database...")
        db_path = restore_firebird_backup(backup_path, tmp)

        # 3. Extract sales data
        print("\n[3/6] Extracting sales data...")
        daily_data = query_sales_data(db_path)

        if not daily_data:
            print("ERROR: No sales data extracted. Check table schema.")
            sys.exit(1)

        print(f"\nExtracted {len(daily_data)} days of data")
        total = sum(d["faturamento"] for d in daily_data.values())
        print(f"Total revenue: R$ {total:,.2f}")

        # 4. Extract financial data
        print("\n[4/6] Extracting financial data...")
        financial_data = query_financial_data(db_path)

        if financial_data:
            print(f"Extracted financial data: {', '.join(financial_data.keys())}")
        else:
            print("No financial data found (tables may not exist in this Consumer version)")

        # 5. Upload to Firestore
        print("\n[5/6] Uploading to Firestore...")
        sync_meta = {
            "arquivo": chosen["name"],
            "modificado": chosen["modifiedTime"],
            "syncedAt": datetime.utcnow().isoformat(),
            "dias": len(daily_data),
            "faturamentoTotal": total,
        }
        if stale_warning:
            sync_meta["aviso"] = stale_warning.strip()
        upload_to_firestore(daily_data, financial_data, sync_meta)

        # 6. Write static JSON files for dashboard
        print("\n[6/6] Writing static JSON files...")
        write_static_json(daily_data, financial_data, db_path, repo_root)

    print("\nDone!")


if __name__ == "__main__":
    main()
