#!/usr/bin/env python3
"""
Parse raw Firebird SET LIST ON output and generate real dashboard JSON files.
"""

import json
import re
from collections import defaultdict
from datetime import datetime

RESULTS_DIR = "/Users/rene/.claude/projects/-Users-rene-Downloads-JAVARI-PARK/51f87bde-57d3-4a13-96b2-2239df56e06a/tool-results"
OUT_DIR = "/Users/rene/Downloads/JAVARI PARK/public/data"

def parse_list_records(text):
    records = []
    current = {}
    for line in text.split('\n'):
        line = line.rstrip()
        if not line.strip():
            if current:
                records.append(current)
                current = {}
            continue
        m = re.match(r'^(\w+)\s{2,}(.+)$', line)
        if m:
            key = m.group(1).strip()
            val = m.group(2).strip()
            current[key] = val
    if current:
        records.append(current)
    return records

def to_float(s):
    try:
        return float(s)
    except (ValueError, TypeError):
        return 0.0

def to_int(s):
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return 0

# ============================================================
# 1. Load product-to-category mapping
# ============================================================
print("Loading product-to-category mapping...")
with open(f"{RESULTS_DIR}/basuta7tx.txt", encoding="latin-1") as f:
    cat_records = parse_list_records(f.read())

product_category = {}
for r in cat_records:
    nome = r.get("NOME", "").strip()
    cat = r.get("CATEGORIA", "").strip()
    if nome and cat:
        product_category[nome.upper()] = cat

print(f"  {len(product_category)} product-category mappings loaded")

# ============================================================
# 2. Parse daily sales
# ============================================================
print("Parsing daily sales...")
with open(f"{RESULTS_DIR}/bdgn1hrck.txt", encoding="latin-1") as f:
    sales_records = parse_list_records(f.read())

daily = {}
for r in sales_records:
    date = r.get("DIA", "").strip()
    if not date or not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
        continue
    daily[date] = {
        "date": date,
        "faturamento": round(to_float(r.get("FATURAMENTO", "0")), 2),
        "qtdVendas": to_int(r.get("QTD_PEDIDOS", "0")),
    }

print(f"  {len(daily)} days parsed")

# ============================================================
# 3. Parse payment methods per day
# ============================================================
print("Parsing payment methods...")
with open(f"{RESULTS_DIR}/bepr1kay0.txt", encoding="latin-1") as f:
    pay_records = parse_list_records(f.read())

payments_by_day = defaultdict(lambda: defaultdict(float))
for r in pay_records:
    date = r.get("DIA", "").strip()
    if not date or not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
        continue
    fp_code = to_int(r.get("FPCODIGO", "0"))
    total = to_float(r.get("TOTAL", "0"))

    if fp_code == 1:
        key = "dinheiro"
    elif fp_code == 3:
        key = "credito"
    elif fp_code == 4:
        key = "debito"
    elif fp_code in (18, 21):
        key = "pix"
    elif fp_code in (11,):
        key = "vale_refeicao"
    elif fp_code in (1003,):
        key = "musicos"
    elif fp_code in (1004,):
        key = "brindes"
    else:
        key = "outros"

    payments_by_day[date][key] += total

print(f"  {len(payments_by_day)} days with payment data")

# ============================================================
# 4. Parse hourly breakdown per day
# ============================================================
print("Parsing hourly breakdown...")
with open(f"{RESULTS_DIR}/bbi6ejq7r.txt", encoding="latin-1") as f:
    hour_records = parse_list_records(f.read())

hours_by_day = defaultdict(list)
for r in hour_records:
    date = r.get("DIA", "").strip()
    if not date or not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
        continue
    hora = to_int(r.get("HORA", "0"))
    total = to_float(r.get("TOTAL", "0"))
    hours_by_day[date].append({"hora": hora, "faturamento": round(total, 2)})

print(f"  {len(hours_by_day)} days with hourly data")

# ============================================================
# 5. Parse products per day and build categories
# ============================================================
print("Parsing products per day...")
with open(f"{RESULTS_DIR}/bnsxn67e5.txt", encoding="latin-1") as f:
    prod_records = parse_list_records(f.read())

prods_by_day = defaultdict(list)
cats_by_day = defaultdict(lambda: defaultdict(float))

for r in prod_records:
    date = r.get("DIA", "").strip()
    if not date or not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
        continue
    produto = r.get("PRODUTO", "").strip()
    qty = to_float(r.get("QTD", "0"))
    total = to_float(r.get("TOTAL", "0"))

    if produto and total > 0:
        prods_by_day[date].append({
            "nome": produto,
            "qtd": round(qty, 0),
            "faturamento": round(total, 2)
        })

        cat = product_category.get(produto.upper(), "OUTROS")
        cats_by_day[date][cat] += total

print(f"  {len(prods_by_day)} days with product data")
print(f"  {len(cats_by_day)} days with category data")

# ============================================================
# 6. Assemble faturamento.json
# ============================================================
print("\nAssembling faturamento.json...")
faturamento = []
for date in sorted(daily.keys()):
    entry = daily[date].copy()

    if date in payments_by_day:
        entry["formasPagamento"] = {
            "pix": round(payments_by_day[date].get("pix", 0), 2),
            "credito": round(payments_by_day[date].get("credito", 0), 2),
            "debito": round(payments_by_day[date].get("debito", 0), 2),
            "dinheiro": round(payments_by_day[date].get("dinheiro", 0), 2),
            "vale_refeicao": round(payments_by_day[date].get("vale_refeicao", 0), 2),
            "musicos": round(payments_by_day[date].get("musicos", 0), 2),
            "brindes": round(payments_by_day[date].get("brindes", 0), 2),
            "outros": round(payments_by_day[date].get("outros", 0), 2),
        }

    if date in cats_by_day:
        cats_sorted = sorted(cats_by_day[date].items(), key=lambda x: -x[1])
        entry["porCategoria"] = [
            {"nome": cat, "faturamento": round(val, 2)}
            for cat, val in cats_sorted[:15]
        ]

    if date in prods_by_day:
        entry["topProdutos"] = prods_by_day[date][:20]

    if date in hours_by_day:
        entry["porHora"] = sorted(hours_by_day[date], key=lambda x: x["hora"])

    faturamento.append(entry)

out_fat = f"{OUT_DIR}/faturamento.json"
with open(out_fat, 'w', encoding='utf-8') as f:
    json.dump(faturamento, f, ensure_ascii=False, indent=2)
print(f"  Wrote {len(faturamento)} days to {out_fat}")

# Stats
total_rev = sum(d["faturamento"] for d in faturamento)
print(f"  Total revenue: R$ {total_rev:,.2f}")
if faturamento:
    print(f"  Date range: {faturamento[0]['date']} to {faturamento[-1]['date']}")

# ============================================================
# 7. Parse contas a pagar
# ============================================================
print("\nParsing contas a pagar...")
with open(f"{RESULTS_DIR}/baca1mze0.txt", encoding="latin-1") as f:
    cp_records = parse_list_records(f.read())

contas_pagar = []
for r in cp_records:
    desc = r.get("DESCRICAO", "").strip()
    forn = r.get("FORNECEDOR", "").strip()
    venc = r.get("DATAVENCIMENTO", "").strip()
    valor = to_float(r.get("VALOR", "0"))
    dt_pag = r.get("DATAPAGAMENTO", "").strip()
    val_pago = to_float(r.get("VALORPAGO", "0"))

    if not desc or not venc:
        continue

    if dt_pag and val_pago > 0:
        status = "pago"
    elif venc < "2026-05-11":
        status = "vencido"
    else:
        status = "pendente"

    contas_pagar.append({
        "descricao": desc,
        "fornecedor": forn,
        "vencimento": venc,
        "valor": round(valor, 2),
        "status": status,
        "dataPagamento": dt_pag if dt_pag else None,
        "valorPago": round(val_pago, 2) if val_pago > 0 else None,
    })

print(f"  {len(contas_pagar)} contas a pagar parsed")

# ============================================================
# 8. Parse fornecedores
# ============================================================
print("Parsing fornecedores...")
with open(f"{RESULTS_DIR}/bvbezsjet.txt", encoding="latin-1") as f:
    forn_records = parse_list_records(f.read())

fornecedores = []
for r in forn_records:
    nome = r.get("NOME", "").strip()
    if not nome:
        continue
    fornecedores.append({
        "nome": nome,
        "cnpj": r.get("CNPJ", "").strip(),
        "telefone": r.get("FONE", "").strip(),
        "email": r.get("EMAIL", "").strip(),
    })

print(f"  {len(fornecedores)} fornecedores parsed")

# ============================================================
# 9. Build compras from contas a pagar (filter supply-related)
# ============================================================
supply_keywords = [
    "fornecimento", "compra", "nf ", "nota ", "mercadoria",
    "bebida", "cerveja", "destilado", "insumo", "alimento",
]

compras = []
for cp in contas_pagar:
    desc_lower = cp["descricao"].lower()
    if any(kw in desc_lower for kw in supply_keywords):
        compras.append({
            "data": cp["vencimento"],
            "fornecedor": cp["fornecedor"],
            "descricao": cp["descricao"],
            "total": cp["valor"],
        })

compras.sort(key=lambda x: x["data"], reverse=True)
print(f"  {len(compras)} compras identified")

# ============================================================
# 10. Resumo financeiro
# ============================================================
total_a_pagar = sum(cp["valor"] for cp in contas_pagar if cp["status"] != "pago")
total_vencido = sum(cp["valor"] for cp in contas_pagar if cp["status"] == "vencido")
total_pago = sum(cp["valor"] for cp in contas_pagar if cp["status"] == "pago")

# ============================================================
# 11. Write financeiro.json
# ============================================================
financeiro = {
    "contas_pagar": {
        "items": contas_pagar
    },
    "fornecedores": {
        "items": fornecedores
    },
    "compras": {
        "items": compras[:50]
    },
    "resumo": {
        "totalAPagar": round(total_a_pagar, 2),
        "totalVencido": round(total_vencido, 2),
        "totalPago": round(total_pago, 2),
    }
}

out_fin = f"{OUT_DIR}/financeiro.json"
with open(out_fin, 'w', encoding='utf-8') as f:
    json.dump(financeiro, f, ensure_ascii=False, indent=2)
print(f"\nWrote financeiro.json:")
print(f"  {len(contas_pagar)} contas a pagar")
print(f"  {len(fornecedores)} fornecedores")
print(f"  {len(compras)} compras")
print(f"  Total a pagar: R$ {total_a_pagar:,.2f}")
print(f"  Total vencido: R$ {total_vencido:,.2f}")
print(f"  Total pago: R$ {total_pago:,.2f}")

print("\nDone!")
