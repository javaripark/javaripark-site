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
# Google Drive: download most recent .fbconsumer backup
# ---------------------------------------------------------------------------
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


def download_latest_backup(drive_service, dest_dir):
    """Download the most recently modified .fbconsumer file from Drive."""
    results = drive_service.files().list(
        q=f"'{DRIVE_FOLDER_ID}' in parents and name contains '.fbconsumer'",
        orderBy="modifiedTime desc",
        pageSize=10,
        fields="files(id, name, modifiedTime, size)"
    ).execute()

    files = results.get("files", [])
    if not files:
        raise RuntimeError("No .fbconsumer files found in Drive folder")

    latest = files[0]
    print(f"Downloading: {latest['name']} (modified: {latest['modifiedTime']}, size: {latest.get('size', '?')} bytes)")

    dest_path = os.path.join(dest_dir, latest["name"])
    from googleapiclient.http import MediaIoBaseDownload
    import io

    request = drive_service.files().get_media(fileId=latest["id"])
    fh = io.FileIO(dest_path, "wb")
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while not done:
        status, done = downloader.next_chunk()
        if status:
            print(f"  Download {int(status.progress() * 100)}%")
    fh.close()

    print(f"Saved to: {dest_path}")
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

    con = fdb.connect(
        database=db_path,
        user="SYSDBA",
        password="masterkey"
    )
    cur = con.cursor()

    # Discover tables
    cur.execute("""
        SELECT RDB$RELATION_NAME FROM RDB$RELATIONS
        WHERE RDB$SYSTEM_FLAG = 0
        ORDER BY RDB$RELATION_NAME
    """)
    tables = [row[0].strip() for row in cur.fetchall()]
    print(f"Found {len(tables)} tables: {', '.join(tables[:20])}...")

    # Try to identify the sales table
    sales_table = find_table(tables, ["VENDA", "VENDAS", "MOVIMENTO", "MOV_VENDA"])
    items_table = find_table(tables, ["ITEM_VENDA", "ITENS_VENDA", "ITEM_MOV", "MOV_ITEM"])
    products_table = find_table(tables, ["PRODUTO", "PRODUTOS", "ITEM", "ITENS"])
    groups_table = find_table(tables, ["GRUPO", "GRUPOS", "CATEGORIA", "CATEGORIAS", "GRUPO_PRODUTO"])
    payment_table = find_table(tables, ["VENDA_PAGAMENTO", "PAGAMENTO", "FORMA_PGTO",
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

    date_col = find_column(sales_cols, ["DATA", "DATA_VENDA", "DT_VENDA", "DATA_MOV", "DATAVENDA"])
    total_col = find_column(sales_cols, ["TOTAL", "VALOR_TOTAL", "VLR_TOTAL", "TOTAL_VENDA", "TOTALVENDA"])
    time_col = find_column(sales_cols, ["HORA", "HORA_VENDA", "HR_VENDA"])
    status_col = find_column(sales_cols, ["STATUS", "SITUACAO", "SIT"])

    if not date_col or not total_col:
        print(f"ERROR: Could not identify date/total columns in {sales_table}")
        print(f"  Available: {sales_cols}")
        con.close()
        return None

    # Query daily aggregates
    status_filter = f"AND {status_col} NOT IN ('C', 'CANCELADA', 'CANCELADO')" if status_col else ""

    daily_data = {}

    # 1. Daily revenue and order count
    sql = f"""
        SELECT {date_col}, COUNT(*), SUM({total_col})
        FROM {sales_table}
        WHERE {total_col} > 0 {status_filter}
        GROUP BY {date_col}
        ORDER BY {date_col}
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
            "topProdutos": []
        }

    print(f"Found {len(daily_data)} days of sales data")

    # 2. Payment methods per day
    if payment_table:
        pay_cols = get_columns(cur, payment_table)
        pay_value_col = find_column(pay_cols, ["VALOR", "VLR", "TOTAL", "VALOR_PAGO"])
        pay_form_col = find_column(pay_cols, ["FORMA", "DESCRICAO", "NOME", "TIPO",
                                               "FORMA_PGTO", "BANDEIRA", "FORMA_PAGAMENTO"])
        pay_sale_col = find_column(pay_cols, ["VENDA_ID", "ID_VENDA", "COD_VENDA", "MOVIMENTO_ID"])
        pay_date_col = find_column(pay_cols, ["DATA", "DATA_VENDA", "DT_VENDA"])

        if pay_value_col and pay_form_col:
            if pay_date_col:
                sql = f"""
                    SELECT {pay_date_col}, {pay_form_col}, SUM({pay_value_col})
                    FROM {payment_table}
                    WHERE {pay_value_col} > 0
                    GROUP BY {pay_date_col}, {pay_form_col}
                """
            elif pay_sale_col:
                sql = f"""
                    SELECT v.{date_col}, p.{pay_form_col}, SUM(p.{pay_value_col})
                    FROM {payment_table} p
                    JOIN {sales_table} v ON v.ID = p.{pay_sale_col}
                    WHERE p.{pay_value_col} > 0
                    GROUP BY v.{date_col}, p.{pay_form_col}
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
                        form_name = (str(row[1] or "")).strip().upper()
                        value = float(row[2] or 0)
                        key = classify_payment(form_name)
                        daily_data[date_str]["formasPagamento"][key] += value
                except Exception as e:
                    print(f"  Payment query failed: {e}")

    # 3. Revenue by hour
    if time_col:
        print("Querying hourly revenue...")
        sql = f"""
            SELECT {date_col}, EXTRACT(HOUR FROM {time_col}), COUNT(*), SUM({total_col})
            FROM {sales_table}
            WHERE {total_col} > 0 {status_filter}
            GROUP BY {date_col}, EXTRACT(HOUR FROM {time_col})
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

    # 4. Top products per day
    if items_table and products_table:
        item_cols = get_columns(cur, items_table)
        item_qty_col = find_column(item_cols, ["QUANTIDADE", "QTD", "QTDE"])
        item_total_col = find_column(item_cols, ["VALOR_TOTAL", "VLR_TOTAL", "TOTAL", "SUBTOTAL"])
        item_prod_col = find_column(item_cols, ["PRODUTO_ID", "ID_PRODUTO", "COD_PRODUTO"])
        item_sale_col = find_column(item_cols, ["VENDA_ID", "ID_VENDA", "COD_VENDA", "MOVIMENTO_ID"])

        prod_cols = get_columns(cur, products_table)
        prod_name_col = find_column(prod_cols, ["NOME", "DESCRICAO", "NOME_PRODUTO", "PRODUTO"])
        prod_group_col = find_column(prod_cols, ["GRUPO_ID", "ID_GRUPO", "COD_GRUPO", "CATEGORIA_ID"])

        if item_qty_col and item_total_col and item_prod_col and prod_name_col:
            print("Querying product sales...")
            group_join = ""
            group_select = "'Sem categoria'"
            if groups_table and prod_group_col:
                grp_cols = get_columns(cur, groups_table)
                grp_name_col = find_column(grp_cols, ["NOME", "DESCRICAO", "GRUPO"])
                if grp_name_col:
                    group_join = f"LEFT JOIN {groups_table} g ON g.ID = p.{prod_group_col}"
                    group_select = f"g.{grp_name_col}"

            sql = f"""
                SELECT v.{date_col}, p.{prod_name_col}, {group_select},
                       SUM(i.{item_qty_col}), SUM(i.{item_total_col})
                FROM {items_table} i
                JOIN {sales_table} v ON v.ID = i.{item_sale_col}
                JOIN {products_table} p ON p.ID = i.{item_prod_col}
                {group_join}
                WHERE i.{item_total_col} > 0 {status_filter.replace(status_col, 'v.' + status_col) if status_col else ''}
                GROUP BY v.{date_col}, p.{prod_name_col}, {group_select}
                ORDER BY v.{date_col}, SUM(i.{item_total_col}) DESC
            """
            try:
                cur.execute(sql)
                day_products = defaultdict(list)
                day_categories = defaultdict(lambda: defaultdict(lambda: {"faturamento": 0, "qtd": 0}))

                for row in cur.fetchall():
                    dt = row[0]
                    if dt is None:
                        continue
                    date_str = dt.strftime("%Y-%m-%d") if isinstance(dt, datetime) else str(dt)[:10]
                    if date_str not in daily_data:
                        continue
                    prod_name = (str(row[1] or "")).strip()
                    cat_name = (str(row[2] or "Sem categoria")).strip()
                    qty = float(row[3] or 0)
                    total = float(row[4] or 0)

                    day_products[date_str].append({"nome": prod_name, "qtd": qty, "faturamento": total})
                    day_categories[date_str][cat_name]["faturamento"] += total
                    day_categories[date_str][cat_name]["qtd"] += qty

                for date_str in daily_data:
                    prods = day_products.get(date_str, [])
                    prods.sort(key=lambda x: x["faturamento"], reverse=True)
                    daily_data[date_str]["topProdutos"] = prods[:15]

                    cats = day_categories.get(date_str, {})
                    daily_data[date_str]["porCategoria"] = [
                        {"nome": k, "faturamento": v["faturamento"], "qtd": v["qtd"]}
                        for k, v in sorted(cats.items(), key=lambda x: x[1]["faturamento"], reverse=True)
                    ]
            except Exception as e:
                print(f"  Product query failed: {e}")

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

    con = fdb.connect(database=db_path, user="SYSDBA", password="masterkey")
    cur = con.cursor()

    cur.execute("""
        SELECT RDB$RELATION_NAME FROM RDB$RELATIONS
        WHERE RDB$SYSTEM_FLAG = 0 ORDER BY RDB$RELATION_NAME
    """)
    tables = [row[0].strip() for row in cur.fetchall()]

    result = {}

    # ── Fornecedores ──
    forn_table = find_table(tables, [
        "FORNECEDOR", "FORNECEDORES", "CLIENTE_FORNECEDOR", "CADASTRO_FORNECEDOR",
        "PESSOA_FORNECEDOR"
    ])
    forn_map = {}
    if forn_table:
        cols = get_columns(cur, forn_table)
        name_col = find_column(cols, ["NOME", "RAZAO_SOCIAL", "RAZAO", "NOME_FANTASIA", "FANTASIA", "DESCRICAO"])
        cnpj_col = find_column(cols, ["CNPJ", "CNPJ_CPF", "CPF_CNPJ", "CGC", "DOCUMENTO"])
        tel_col = find_column(cols, ["TELEFONE", "FONE", "TEL", "TELEFONE1"])
        email_col = find_column(cols, ["EMAIL", "E_MAIL", "CORREIO"])
        id_col = find_column(cols, ["ID", "CODIGO", "COD", "ID_FORNECEDOR"])

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
        "CONTA_PAGAR", "CONTAS_PAGAR", "CONTAS_A_PAGAR", "CONTA",
        "TITULO_PAGAR", "TITULO", "FINANCEIRO", "FIN_PAGAR",
        "LANCAMENTO", "LANCAMENTO_PAGAR"
    ])
    if cp_table:
        cols = get_columns(cur, cp_table)
        desc_col = find_column(cols, ["DESCRICAO", "HISTORICO", "OBSERVACAO", "OBS", "COMPLEMENTO", "DOCUMENTO"])
        valor_col = find_column(cols, ["VALOR", "VLR", "VALOR_TITULO", "VALOR_ORIGINAL"])
        venc_col = find_column(cols, ["VENCIMENTO", "DT_VENCIMENTO", "DATA_VENCIMENTO", "VENCTO"])
        status_col = find_column(cols, ["STATUS", "SITUACAO", "SIT", "PAGO", "QUITADO"])
        forn_col = find_column(cols, ["FORNECEDOR_ID", "ID_FORNECEDOR", "COD_FORNECEDOR",
                                       "PESSOA_ID", "CLIENTE_ID", "CREDOR_ID"])
        data_col = find_column(cols, ["DATA", "DATA_EMISSAO", "DT_EMISSAO", "DATA_LANCAMENTO"])
        valor_pago_col = find_column(cols, ["VALOR_PAGO", "VLR_PAGO", "VALOR_QUITADO"])

        if valor_col and venc_col:
            select = [desc_col or f"'{cp_table}'"]
            if forn_col: select.append(forn_col)
            select.extend([valor_col, venc_col])
            if status_col: select.append(status_col)
            if valor_pago_col: select.append(valor_pago_col)

            sql = f"SELECT {', '.join(select)} FROM {cp_table} ORDER BY {venc_col} DESC"
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
                    if status_col:
                        s = str(row[idx] or "").strip().upper(); idx += 1
                        if s in ("P", "PAGO", "S", "SIM", "1", "Q", "QUITADO"):
                            status = "pago"
                        else:
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
        "COMPRA", "COMPRAS", "ENTRADA", "NOTA_ENTRADA", "ENTRADA_MERCADORIA",
        "NFE_ENTRADA", "NOTA_FISCAL_ENTRADA", "PEDIDO_COMPRA"
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
def upload_to_firestore(daily_data, financial_data=None):
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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print("=" * 60)
    print("Consumer Backup → Firestore Sync")
    print("=" * 60)

    with tempfile.TemporaryDirectory() as tmp:
        # 1. Download from Google Drive
        print("\n[1/5] Downloading backup from Google Drive...")
        drive = get_drive_service()
        backup_path = download_latest_backup(drive, tmp)

        # 2. Restore Firebird database
        print("\n[2/5] Restoring Firebird database...")
        db_path = restore_firebird_backup(backup_path, tmp)

        # 3. Extract sales data
        print("\n[3/5] Extracting sales data...")
        daily_data = query_sales_data(db_path)

        if not daily_data:
            print("ERROR: No sales data extracted. Check table schema.")
            sys.exit(1)

        print(f"\nExtracted {len(daily_data)} days of data")
        total = sum(d["faturamento"] for d in daily_data.values())
        print(f"Total revenue: R$ {total:,.2f}")

        # 4. Extract financial data
        print("\n[4/5] Extracting financial data...")
        financial_data = query_financial_data(db_path)

        if financial_data:
            print(f"Extracted financial data: {', '.join(financial_data.keys())}")
        else:
            print("No financial data found (tables may not exist in this Consumer version)")

        # 5. Upload to Firestore
        print("\n[5/5] Uploading to Firestore...")
        upload_to_firestore(daily_data, financial_data)

    print("\nDone!")


if __name__ == "__main__":
    main()
