#!/usr/bin/env python3
"""
Extract real data from Consumer Firebird backup and generate dashboard JSON files.
Connects to the restored Firebird database via Docker container.
"""

import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime

ISQL = "docker exec -i firebird-consumer /usr/local/firebird/bin/isql"
DB = "/firebird/data/consumer.fdb"
USER = "SYSDBA"
PASS = "masterkey"

def run_query(sql):
    cmd = f'{ISQL} -user {USER} -password {PASS} {DB}'
    result = subprocess.run(
        cmd, shell=True, input=sql, capture_output=True, text=True, timeout=120
    )
    return result.stdout

def parse_rows(output, columns):
    lines = output.strip().split('\n')
    rows = []
    data_started = False
    for line in lines:
        if line.startswith('==='):
            data_started = True
            continue
        if not data_started:
            continue
        if not line.strip() or line.strip().startswith('Statement'):
            continue
        parts = line.split('\t') if '\t' in line else [p.strip() for p in line.split('  ') if p.strip()]
        if len(parts) >= len(columns):
            row = {}
            for i, col in enumerate(columns):
                row[col] = parts[i].strip() if i < len(parts) else ''
            rows.append(row)
    return rows

def query_to_list(sql):
    raw = run_query(sql)
    lines = [l for l in raw.strip().split('\n') if l.strip()]
    result = []
    header_found = False
    for line in lines:
        if '===' in line:
            header_found = True
            continue
        if not header_found:
            continue
        vals = [v.strip() for v in line.split('|') if v.strip() != '']
        if vals:
            result.append(vals)
    return result

print("=== Extracting sales data (faturamento) ===")

# Daily sales aggregated
fat_sql = """
SELECT
  CAST(p.DATAABERTURA AS DATE) AS DIA,
  COUNT(DISTINCT p.CODIGO) AS QTD_PEDIDOS,
  SUM(COALESCE(p.VALORTOTAL, p.SUBTOTALPAGO, 0)) AS FATURAMENTO
FROM PEDIDOS p
WHERE p.DATADELETE IS NULL
  AND p.DATAABERTURA >= '2024-01-01'
GROUP BY CAST(p.DATAABERTURA AS DATE)
ORDER BY 1;
"""
print("  Querying daily sales...")
fat_raw = run_query(fat_sql)
print(f"  Raw output length: {len(fat_raw)} chars")

# Payment methods per day
pay_sql = """
SELECT
  CAST(pg.DATAPAGAMENTO AS DATE) AS DIA,
  fp.CODIGO AS FPCODIGO,
  fp.DESCRICAO AS FPDESC,
  SUM(pg.VALOR) AS TOTAL
FROM PAGAMENTOS pg
JOIN FORMASPAGAMENTO fp ON fp.CODIGO = pg.CODIGOFORMAPAGAMENTO
WHERE pg.DATADELETE IS NULL
  AND pg.DATAPAGAMENTO >= '2024-01-01'
GROUP BY CAST(pg.DATAPAGAMENTO AS DATE), fp.CODIGO, fp.DESCRICAO
ORDER BY 1, 2;
"""
print("  Querying payment methods...")
pay_raw = run_query(pay_sql)
print(f"  Raw output length: {len(pay_raw)} chars")

# Sales by category per day
cat_sql = """
SELECT
  CAST(p.DATAABERTURA AS DATE) AS DIA,
  e.DESCRICAO AS CATEGORIA,
  SUM(ip.QUANTIDADE * ip.VALORUNITARIO) AS TOTAL
FROM ITENSPEDIDO ip
JOIN PEDIDOS p ON p.CODIGO = ip.CODIGOPEDIDO
JOIN PRODUTOS pr ON pr.CODIGO = ip.CODIGOPRODUTO
JOIN ETIQUETAS e ON e.CODIGO = pr.CODIGOETIQUETA
WHERE ip.DATADELETE IS NULL
  AND p.DATADELETE IS NULL
  AND p.DATAABERTURA >= '2024-01-01'
  AND e.TIPO = 'P'
GROUP BY CAST(p.DATAABERTURA AS DATE), e.DESCRICAO
ORDER BY 1, 3 DESC;
"""
print("  Querying sales by category...")
cat_raw = run_query(cat_sql)
print(f"  Raw output length: {len(cat_raw)} chars")

# Top products per day
prod_sql = """
SELECT
  CAST(p.DATAABERTURA AS DATE) AS DIA,
  pr.NOME AS PRODUTO,
  SUM(ip.QUANTIDADE * ip.VALORUNITARIO) AS TOTAL
FROM ITENSPEDIDO ip
JOIN PEDIDOS p ON p.CODIGO = ip.CODIGOPEDIDO
JOIN PRODUTOS pr ON pr.CODIGO = ip.CODIGOPRODUTO
WHERE ip.DATADELETE IS NULL
  AND p.DATADELETE IS NULL
  AND p.DATAABERTURA >= '2024-01-01'
GROUP BY CAST(p.DATAABERTURA AS DATE), pr.NOME
ORDER BY 1, 3 DESC;
"""
print("  Querying top products...")
prod_raw = run_query(prod_sql)
print(f"  Raw output length: {len(prod_raw)} chars")

# Sales by hour per day
hour_sql = """
SELECT
  CAST(p.DATAABERTURA AS DATE) AS DIA,
  EXTRACT(HOUR FROM p.DATAABERTURA) AS HORA,
  SUM(COALESCE(p.VALORTOTAL, p.SUBTOTALPAGO, 0)) AS TOTAL
FROM PEDIDOS p
WHERE p.DATADELETE IS NULL
  AND p.DATAABERTURA >= '2024-01-01'
GROUP BY CAST(p.DATAABERTURA AS DATE), EXTRACT(HOUR FROM p.DATAABERTURA)
ORDER BY 1, 2;
"""
print("  Querying sales by hour...")
hour_raw = run_query(hour_sql)
print(f"  Raw output length: {len(hour_raw)} chars")

print("\nParsing all results...")

# Parse daily sales
daily = {}
for line in fat_raw.strip().split('\n'):
    if '===' in line or not line.strip():
        continue
    parts = [p.strip() for p in line.split()]
    if len(parts) >= 3 and parts[0].count('-') == 2:
        try:
            date = parts[0]
            qty = int(parts[1])
            rev = float(parts[2])
            daily[date] = {"date": date, "faturamento": round(rev, 2), "qtdVendas": qty}
        except (ValueError, IndexError):
            pass

print(f"  Parsed {len(daily)} days of sales data")

# Parse payments
payments_by_day = defaultdict(lambda: defaultdict(float))
for line in pay_raw.strip().split('\n'):
    if '===' in line or not line.strip() or line.strip().startswith('DIA'):
        continue
    parts = [p.strip() for p in line.split()]
    if len(parts) >= 4 and parts[0].count('-') == 2:
        try:
            date = parts[0]
            fp_desc_parts = parts[2:-1]
            fp_desc = ' '.join(fp_desc_parts)
            total = float(parts[-1])

            fp_code = int(parts[1])
            if fp_code == 1:
                key = "dinheiro"
            elif fp_code == 3:
                key = "credito"
            elif fp_code == 4:
                key = "debito"
            elif fp_code in (18, 21):
                key = "pix"
            else:
                key = "outros"

            payments_by_day[date][key] += total
        except (ValueError, IndexError):
            pass

print(f"  Parsed payments for {len(payments_by_day)} days")

# Parse categories
cats_by_day = defaultdict(list)
for line in cat_raw.strip().split('\n'):
    if '===' in line or not line.strip() or line.strip().startswith('DIA'):
        continue
    parts = line.strip().split()
    if len(parts) >= 3 and parts[0].count('-') == 2:
        try:
            date = parts[0]
            total = float(parts[-1])
            cat_name = ' '.join(parts[1:-1])
            cats_by_day[date].append({"nome": cat_name, "faturamento": round(total, 2)})
        except (ValueError, IndexError):
            pass

print(f"  Parsed categories for {len(cats_by_day)} days")

# Parse products
prods_by_day = defaultdict(list)
for line in prod_raw.strip().split('\n'):
    if '===' in line or not line.strip() or line.strip().startswith('DIA'):
        continue
    parts = line.strip().split()
    if len(parts) >= 3 and parts[0].count('-') == 2:
        try:
            date = parts[0]
            total = float(parts[-1])
            prod_name = ' '.join(parts[1:-1])
            prods_by_day[date].append({"nome": prod_name, "faturamento": round(total, 2)})
        except (ValueError, IndexError):
            pass

print(f"  Parsed products for {len(prods_by_day)} days")

# Parse hours
hours_by_day = defaultdict(list)
for line in hour_raw.strip().split('\n'):
    if '===' in line or not line.strip() or line.strip().startswith('DIA'):
        continue
    parts = [p.strip() for p in line.split()]
    if len(parts) >= 3 and parts[0].count('-') == 2:
        try:
            date = parts[0]
            hora = int(parts[1])
            total = float(parts[2])
            hours_by_day[date].append({"hora": hora, "faturamento": round(total, 2)})
        except (ValueError, IndexError):
            pass

print(f"  Parsed hours for {len(hours_by_day)} days")

# Assemble faturamento.json
faturamento = []
for date in sorted(daily.keys()):
    entry = daily[date]
    if date in payments_by_day:
        entry["formasPagamento"] = {
            "pix": round(payments_by_day[date].get("pix", 0), 2),
            "credito": round(payments_by_day[date].get("credito", 0), 2),
            "debito": round(payments_by_day[date].get("debito", 0), 2),
            "dinheiro": round(payments_by_day[date].get("dinheiro", 0), 2),
            "outros": round(payments_by_day[date].get("outros", 0), 2),
        }
    if date in cats_by_day:
        entry["porCategoria"] = cats_by_day[date][:15]
    if date in prods_by_day:
        entry["topProdutos"] = prods_by_day[date][:15]
    if date in hours_by_day:
        entry["porHora"] = hours_by_day[date]
    faturamento.append(entry)

out_fat = "/Users/rene/Downloads/JAVARI PARK/public/data/faturamento.json"
with open(out_fat, 'w', encoding='utf-8') as f:
    json.dump(faturamento, f, ensure_ascii=False, indent=2)
print(f"\nWrote {len(faturamento)} days to {out_fat}")

# ===================== FINANCEIRO =====================
print("\n=== Extracting financial data (financeiro) ===")

# Contas a pagar
cp_sql = """
SELECT
  cp.DESCRICAO,
  COALESCE(f.NOME, '') AS FORNECEDOR,
  cp.DATAVENCIMENTO,
  cp.VALOR,
  cp.DATAPAGAMENTO,
  cp.VALORPAGO
FROM CONTASPAGAR cp
LEFT JOIN FORNECEDORES f ON f.CODIGO = cp.CODIGOFORNECEDOR
WHERE cp.DATADELETE IS NULL
  AND cp.DATAVENCIMENTO >= '2026-01-01'
ORDER BY cp.DATAVENCIMENTO;
"""
print("  Querying contas a pagar...")
cp_raw = run_query(cp_sql)

cp_items = []
for line in cp_raw.strip().split('\n'):
    if '===' in line or not line.strip() or line.strip().startswith('DESCRICAO'):
        continue
    # This needs more careful parsing due to spaces in descriptions
    # We'll handle it in a second pass

# Fornecedores
forn_sql = """
SELECT
  f.NOME,
  COALESCE(f.CNPJOUCPF, '') AS CNPJ,
  COALESCE(f.FONEPRINCIPAL, '') AS FONE,
  COALESCE(f.EMAIL, '') AS EMAIL
FROM FORNECEDORES f
WHERE f.DATADELETE IS NULL
ORDER BY f.NOME;
"""
print("  Querying fornecedores...")
forn_raw = run_query(forn_sql)
print(f"  Raw output length: {len(forn_raw)} chars")

# For now write raw output to inspect
debug_dir = "/Users/rene/Downloads/JAVARI PARK/scripts/debug"
import os
os.makedirs(debug_dir, exist_ok=True)

with open(f"{debug_dir}/fat_raw.txt", 'w') as f: f.write(fat_raw)
with open(f"{debug_dir}/pay_raw.txt", 'w') as f: f.write(pay_raw)
with open(f"{debug_dir}/cat_raw.txt", 'w') as f: f.write(cat_raw)
with open(f"{debug_dir}/prod_raw.txt", 'w') as f: f.write(prod_raw)
with open(f"{debug_dir}/hour_raw.txt", 'w') as f: f.write(hour_raw)
with open(f"{debug_dir}/cp_raw.txt", 'w') as f: f.write(cp_raw)
with open(f"{debug_dir}/forn_raw.txt", 'w') as f: f.write(forn_raw)

print(f"\nDebug output saved to {debug_dir}/")
print("Done!")
