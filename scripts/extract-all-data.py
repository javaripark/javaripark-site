#!/usr/bin/env python3
"""
Extract data from Consumer Firebird DB (Docker) and generate JSON files:
  1. clientes.json   – all contacts with spending
  2. produtos-consumer.json – products and supplies with categories
  3. financeiro.json  – updated with CATEGORIA + resumoMensal
"""

import json
import subprocess
import sys
import os
from collections import defaultdict
from datetime import datetime

# ── Config ──────────────────────────────────────────────────────────────────
ISQL_CMD = "docker exec -i firebird-consumer /usr/local/firebird/bin/isql"
DB_PATH = "/firebird/data/consumer.fdb"
USER = "SYSDBA"
PASS = "masterkey"
CHARSET = "WIN1252"

DATA_DIR = "/Users/rene/Downloads/JAVARI PARK/public/data"

# ── Helpers ─────────────────────────────────────────────────────────────────

def run_query(sql, timeout=300):
    """Run SQL via isql in the Docker container, return raw stdout."""
    cmd = f'{ISQL_CMD} -user {USER} -password {PASS} -charset {CHARSET} {DB_PATH}'
    try:
        result = subprocess.run(
            cmd, shell=True, input=sql.encode('cp1252'),
            capture_output=True, timeout=timeout,
        )
        # Decode WIN1252 → Python str (Unicode)
        stdout = result.stdout.decode('cp1252', errors='replace')
        stderr = result.stderr.decode('cp1252', errors='replace')
        if result.returncode != 0 and stderr.strip():
            print(f"  [WARN] isql stderr: {stderr.strip()[:200]}", file=sys.stderr)
        return stdout
    except subprocess.TimeoutExpired:
        print(f"  [ERROR] Query timed out after {timeout}s", file=sys.stderr)
        return ""


def parse_fixed_width(output):
    """
    Parse Firebird isql fixed-width output.
    Returns (headers: list[str], rows: list[list[str]]).
    Uses the '===' separator line to determine column boundaries.
    """
    lines = output.split('\n')
    headers = []
    rows = []
    col_ranges = []  # list of (start, end) for each column

    state = 'before_header'
    for line in lines:
        if state == 'before_header':
            # Header line — column names
            stripped = line.strip()
            if stripped and '===' not in stripped and not stripped.startswith('Statement'):
                header_line = line
                state = 'expect_separator'
            continue

        if state == 'expect_separator':
            if '===' in line:
                # Parse column positions from separator
                col_ranges = []
                start = None
                for i, ch in enumerate(line):
                    if ch == '=' and start is None:
                        start = i
                    elif ch != '=' and start is not None:
                        col_ranges.append((start, i))
                        start = None
                if start is not None:
                    col_ranges.append((start, len(line)))

                # Extract header names using positions
                for s, e in col_ranges:
                    h = header_line[s:e].strip() if s < len(header_line) else ''
                    headers.append(h)

                state = 'data'
            continue

        if state == 'data':
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith('Statement'):
                continue
            # isql repeats header+separator every ~20 rows; skip both
            if '===' in line:
                continue
            # Skip repeated header lines (compare first column to header name)
            if headers and col_ranges:
                first_val = line[col_ranges[0][0]:col_ranges[0][1]].strip() if col_ranges[0][0] < len(line) else ''
                if first_val == headers[0]:
                    continue

            # Extract columns using positions
            vals = []
            for s, e in col_ranges:
                v = line[s:e].strip() if s < len(line) else ''
                vals.append(v)
            rows.append(vals)

    return headers, rows


def safe_float(s):
    """Convert string to float, return 0.0 on failure."""
    if not s or s == '<null>':
        return 0.0
    try:
        return float(s.replace(',', '.'))
    except (ValueError, TypeError):
        return 0.0


def safe_int(s):
    """Convert string to int, return 0 on failure."""
    if not s or s == '<null>':
        return 0
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return 0


def safe_date(s):
    """Convert date string to YYYY-MM-DD or None."""
    if not s or s == '<null>':
        return None
    s = s.strip()
    if len(s) >= 10:
        return s[:10]
    return s if s else None


# ── 1. CLIENTES ─────────────────────────────────────────────────────────────

def extract_clientes():
    print("=" * 60)
    print("1. CLIENTES")
    print("=" * 60)

    # 1a. Totals
    print("  Querying totals...")
    raw = run_query("SELECT COUNT(*) FROM CONTATOS WHERE DATADELETE IS NULL;")
    _, rows = parse_fixed_width(raw)
    total_contatos = safe_int(rows[0][0]) if rows else 0
    print(f"    Total contatos: {total_contatos}")

    raw = run_query("SELECT COUNT(*) FROM CONTATOS WHERE DATADELETE IS NULL AND FONECELULAR IS NOT NULL;")
    _, rows = parse_fixed_width(raw)
    com_telefone = safe_int(rows[0][0]) if rows else 0
    print(f"    Com telefone: {com_telefone}")

    raw = run_query("SELECT COUNT(*) FROM CONTATOS WHERE DATADELETE IS NULL AND DATANASCIMENTO IS NOT NULL;")
    _, rows = parse_fixed_width(raw)
    com_nascimento = safe_int(rows[0][0]) if rows else 0
    print(f"    Com nascimento: {com_nascimento}")

    # 1b. Birthdays by month
    print("  Querying birthdays by month...")
    raw = run_query("""
        SELECT EXTRACT(MONTH FROM DATANASCIMENTO) AS MES, COUNT(*)
        FROM CONTATOS
        WHERE DATADELETE IS NULL AND DATANASCIMENTO IS NOT NULL
        GROUP BY EXTRACT(MONTH FROM DATANASCIMENTO)
        ORDER BY 1;
    """)
    _, rows = parse_fixed_width(raw)
    aniversarios = [0] * 12
    for r in rows:
        mes = safe_int(r[0])
        cnt = safe_int(r[1])
        if 1 <= mes <= 12:
            aniversarios[mes - 1] = cnt
    print(f"    Aniversarios: {aniversarios}")

    # 1c. Contacts with orders (the heavy query)
    # Split into two parts to avoid timeout:
    # Part A: contacts that HAVE orders (join is needed)
    print("  Querying contacts WITH orders (may take a while)...")
    sql_with_orders = """
        SELECT c.NOME, c.FONECELULAR, c.DATANASCIMENTO,
            COUNT(DISTINCT p.CODIGO) AS PEDIDOS,
            COALESCE(SUM(p.VALORTOTAL), 0) AS TOTAL_GASTO,
            MAX(CAST(p.DATAABERTURA AS DATE)) AS ULTIMO_PEDIDO
        FROM CONTATOS c
        JOIN PEDIDOS p ON p.CODIGOCONTATOCLIENTE = c.CODIGO AND p.DATADELETE IS NULL
        WHERE c.DATADELETE IS NULL
        GROUP BY c.NOME, c.FONECELULAR, c.DATANASCIMENTO
        ORDER BY 5 DESC;
    """
    raw_a = run_query(sql_with_orders, timeout=600)
    _, rows_a = parse_fixed_width(raw_a)
    print(f"    Contacts with orders: {len(rows_a)}")

    contatos = []
    seen_keys = set()  # track (nome, fone) to dedupe
    for r in rows_a:
        nome = r[0] if len(r) > 0 else ''
        fone = r[1] if len(r) > 1 else ''
        nasc = safe_date(r[2]) if len(r) > 2 else None
        pedidos = safe_int(r[3]) if len(r) > 3 else 0
        total = safe_float(r[4]) if len(r) > 4 else 0.0
        ultimo = safe_date(r[5]) if len(r) > 5 else None

        key = (nome, fone)
        seen_keys.add(key)
        entry = {
            "nome": nome,
            "telefone": fone if fone and fone != '<null>' else None,
            "nascimento": nasc,
            "totalGasto": round(total, 2),
            "pedidos": pedidos,
            "ultimoPedido": ultimo,
        }
        contatos.append(entry)

    # Part B: contacts WITHOUT orders but WITH phone number
    print("  Querying contacts WITHOUT orders but WITH phone...")
    sql_no_orders = """
        SELECT c.NOME, c.FONECELULAR, c.DATANASCIMENTO
        FROM CONTATOS c
        WHERE c.DATADELETE IS NULL
          AND c.FONECELULAR IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM PEDIDOS p
            WHERE p.CODIGOCONTATOCLIENTE = c.CODIGO AND p.DATADELETE IS NULL
          )
        ORDER BY c.NOME;
    """
    raw_b = run_query(sql_no_orders, timeout=600)
    _, rows_b = parse_fixed_width(raw_b)
    print(f"    Contacts with phone only (no orders): {len(rows_b)}")

    for r in rows_b:
        nome = r[0] if len(r) > 0 else ''
        fone = r[1] if len(r) > 1 else ''
        nasc = safe_date(r[2]) if len(r) > 2 else None

        key = (nome, fone)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        entry = {
            "nome": nome,
            "telefone": fone if fone and fone != '<null>' else None,
            "nascimento": nasc,
            "totalGasto": 0.0,
            "pedidos": 0,
            "ultimoPedido": None,
        }
        contatos.append(entry)

    print(f"    Total contatos in array: {len(contatos)}")

    result = {
        "syncedAt": datetime.now().isoformat(),
        "totalContatos": total_contatos,
        "comTelefone": com_telefone,
        "comNascimento": com_nascimento,
        "aniversariosPorMes": aniversarios,
        "contatos": contatos,
    }

    out_path = os.path.join(DATA_DIR, "clientes.json")
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"  Wrote {out_path} ({len(contatos)} contatos)")
    return result


# ── 2. PRODUTOS ─────────────────────────────────────────────────────────────

def extract_produtos():
    print("\n" + "=" * 60)
    print("2. PRODUTOS-CONSUMER")
    print("=" * 60)

    sql = """
        SELECT pr.CODIGO, pr.NOME, e.DESCRICAO AS CATEGORIA, e.TIPO
        FROM PRODUTOS pr
        JOIN ETIQUETAS e ON e.CODIGO = pr.CODIGOETIQUETA
        WHERE pr.NOME NOT STARTING WITH '* Exclu'
        ORDER BY e.TIPO, e.DESCRICAO, pr.NOME;
    """
    print("  Querying products...")
    raw = run_query(sql)
    _, rows = parse_fixed_width(raw)
    print(f"    Raw rows: {len(rows)}")

    produtos = []
    insumos = []
    for r in rows:
        codigo = safe_int(r[0]) if len(r) > 0 else 0
        nome = r[1] if len(r) > 1 else ''
        categoria = r[2] if len(r) > 2 else ''
        tipo = r[3].strip() if len(r) > 3 else ''

        item = {
            "codigo": codigo,
            "nome": nome,
            "categoria": categoria,
            "tipo": tipo,
        }

        if tipo == 'I':
            insumos.append(item)
        else:
            produtos.append(item)

    result = {
        "syncedAt": datetime.now().isoformat(),
        "produtos": produtos,
        "insumos": insumos,
    }

    out_path = os.path.join(DATA_DIR, "produtos-consumer.json")
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"  Wrote {out_path} ({len(produtos)} produtos, {len(insumos)} insumos)")
    return result


# ── 3. FINANCEIRO (update) ──────────────────────────────────────────────────

def extract_financeiro():
    print("\n" + "=" * 60)
    print("3. FINANCEIRO (update)")
    print("=" * 60)

    # Load existing
    fin_path = os.path.join(DATA_DIR, "financeiro.json")
    with open(fin_path, 'r', encoding='utf-8') as f:
        financeiro = json.load(f)
    print(f"  Loaded existing financeiro.json (keys: {list(financeiro.keys())})")

    # 3a. Re-query contas_pagar WITH categoria
    print("  Querying contas a pagar with CATEGORIA...")
    sql_cp = """
        SELECT cp.DESCRICAO, COALESCE(f.NOME,'') AS FORNECEDOR,
            cc.DESCRICAO AS CATEGORIA,
            cp.DATAVENCIMENTO, cp.VALOR,
            cp.DATAPAGAMENTO, cp.VALORPAGO
        FROM CONTASPAGAR cp
        LEFT JOIN FORNECEDORES f ON f.CODIGO = cp.CODIGOFORNECEDOR
        LEFT JOIN CATEGORIACONTAS cc ON cc.CODIGO = cp.CODIGOCATEGORIACONTAS
        WHERE cp.DATAVENCIMENTO >= '2024-01-01'
        ORDER BY cp.DATAVENCIMENTO;
    """
    raw_cp = run_query(sql_cp, timeout=300)
    _, rows_cp = parse_fixed_width(raw_cp)
    print(f"    Rows: {len(rows_cp)}")

    items = []
    total_a_pagar = 0.0
    total_vencido = 0.0
    total_pago_val = 0.0
    today_str = datetime.now().strftime('%Y-%m-%d')

    for r in rows_cp:
        descricao = r[0] if len(r) > 0 else ''
        fornecedor = r[1] if len(r) > 1 else ''
        categoria = r[2] if len(r) > 2 else ''
        vencimento = safe_date(r[3]) if len(r) > 3 else None
        valor = safe_float(r[4]) if len(r) > 4 else 0.0
        data_pag = safe_date(r[5]) if len(r) > 5 else None
        valor_pago = safe_float(r[6]) if len(r) > 6 else 0.0

        if categoria == '<null>':
            categoria = ''

        if data_pag:
            status = 'pago'
            total_pago_val += valor_pago
        elif vencimento and vencimento < today_str:
            status = 'vencido'
            total_vencido += valor
        else:
            status = 'aberto'
            total_a_pagar += valor

        item = {
            "descricao": descricao,
            "fornecedor": fornecedor,
            "categoria": categoria,
            "vencimento": vencimento,
            "valor": round(valor, 2),
            "status": status,
        }
        if data_pag:
            item["dataPagamento"] = data_pag
            item["valorPago"] = round(valor_pago, 2)

        items.append(item)

    financeiro['contas_pagar'] = {"items": items}
    financeiro['resumo'] = {
        "totalAPagar": round(total_a_pagar, 2),
        "totalVencido": round(total_vencido, 2),
        "totalPago": round(total_pago_val, 2),
    }
    print(f"    contas_pagar items: {len(items)}")
    print(f"    resumo: {financeiro['resumo']}")

    # 3b. resumoMensal from VWRESUMOFINANCEIRO
    print("  Querying resumo financeiro mensal...")
    sql_resumo = """
        SELECT DATA, VALORRECEBER, VALORPAGAR
        FROM VWRESUMOFINANCEIRO
        WHERE DATA >= '2024-01-01'
        ORDER BY DATA;
    """
    raw_resumo = run_query(sql_resumo, timeout=300)
    _, rows_resumo = parse_fixed_width(raw_resumo)
    print(f"    Daily rows: {len(rows_resumo)}")

    # Aggregate by month
    monthly = defaultdict(lambda: {"receita": 0.0, "despesa": 0.0})
    for r in rows_resumo:
        data = safe_date(r[0]) if len(r) > 0 else None
        receita = safe_float(r[1]) if len(r) > 1 else 0.0
        despesa = safe_float(r[2]) if len(r) > 2 else 0.0
        if data and len(data) >= 7:
            mes = data[:7]  # "YYYY-MM"
            monthly[mes]["receita"] += receita
            monthly[mes]["despesa"] += despesa

    resumo_mensal = []
    for mes in sorted(monthly.keys()):
        resumo_mensal.append({
            "mes": mes,
            "receita": round(monthly[mes]["receita"], 2),
            "despesa": round(monthly[mes]["despesa"], 2),
        })
    financeiro['resumoMensal'] = resumo_mensal
    print(f"    resumoMensal: {len(resumo_mensal)} months")

    with open(fin_path, 'w', encoding='utf-8') as f:
        json.dump(financeiro, f, ensure_ascii=False, indent=2)
    print(f"  Wrote {fin_path}")
    return financeiro


# ── Main ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print(f"Starting extraction at {datetime.now().isoformat()}")
    print(f"Output directory: {DATA_DIR}\n")

    os.makedirs(DATA_DIR, exist_ok=True)

    clientes = extract_clientes()
    produtos = extract_produtos()
    financeiro = extract_financeiro()

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  clientes.json:          {len(clientes['contatos'])} contatos")
    print(f"  produtos-consumer.json: {len(produtos['produtos'])} produtos, {len(produtos['insumos'])} insumos")
    print(f"  financeiro.json:        {len(financeiro['contas_pagar']['items'])} contas_pagar, {len(financeiro['resumoMensal'])} meses resumo")
    print(f"\nDone at {datetime.now().isoformat()}")
