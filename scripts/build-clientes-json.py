#!/usr/bin/env python3
"""
Build clientes.json from extracted Consumer data for CRM dashboard.
"""

import json
import re
from collections import defaultdict
from datetime import datetime, date

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
# 1. Load contacts with birthdates
# ============================================================
print("Loading contacts...")
with open(f"{RESULTS_DIR}/bm6smlojd.txt", encoding="latin-1") as f:
    contact_records = parse_list_records(f.read())

print(f"  {len(contact_records)} contacts with birthdates loaded")

# ============================================================
# 2. Load client purchase history
# ============================================================
print("Loading purchase history...")
with open(f"{RESULTS_DIR}/b4zs43g0n.txt", encoding="latin-1") as f:
    purchase_records = parse_list_records(f.read())

print(f"  {len(purchase_records)} clients with purchase history")

# Build purchase lookup
purchases_by_client = {}
for r in purchase_records:
    cid = to_int(r.get("CLIENTE_ID", "0"))
    if cid:
        purchases_by_client[cid] = {
            "totalVisitas": to_int(r.get("TOTAL_VISITAS", "0")),
            "totalGasto": round(to_float(r.get("TOTAL_GASTO", "0")), 2),
            "primeiraVisita": r.get("PRIMEIRA_VISITA", "").strip(),
            "ultimaVisita": r.get("ULTIMA_VISITA", "").strip(),
        }

# ============================================================
# 3. Build client list with enrichment
# ============================================================
print("Building client analytics...")

today = date(2026, 5, 11)
clients = []
birthday_by_month = defaultdict(int)
birthday_upcoming = []

for r in contact_records:
    cid = to_int(r.get("CODIGO", "0"))
    nome = r.get("NOME", "").strip()
    bday_str = r.get("DATANASCIMENTO", "").strip()
    phone = r.get("FONECELULAR", "").strip()
    if not phone:
        phone = r.get("FONEPRINCIPAL", "").strip()

    if not nome or not bday_str:
        continue

    # Parse birthdate — some have weird years (0003, 0014 etc.)
    # We only care about month and day
    try:
        parts = bday_str.split('-')
        if len(parts) == 3:
            year = int(parts[0])
            month = int(parts[1])
            day = int(parts[2])
            if month < 1 or month > 12 or day < 1 or day > 31:
                continue
        else:
            continue
    except (ValueError, IndexError):
        continue

    birthday_by_month[month] += 1

    purchase = purchases_by_client.get(cid, {})

    client = {
        "id": cid,
        "nome": nome,
        "aniversarioMes": month,
        "aniversarioDia": day,
        "telefone": phone,
        "totalVisitas": purchase.get("totalVisitas", 0),
        "totalGasto": purchase.get("totalGasto", 0),
        "ultimaVisita": purchase.get("ultimaVisita", ""),
    }
    clients.append(client)

    # Check if birthday is upcoming (next 30 days)
    try:
        bday_this_year = date(today.year, month, day)
        days_until = (bday_this_year - today).days
        if days_until < 0:
            bday_this_year = date(today.year + 1, month, day)
            days_until = (bday_this_year - today).days
        if 0 <= days_until <= 30:
            birthday_upcoming.append({
                "nome": nome,
                "telefone": phone,
                "dia": day,
                "mes": month,
                "diasAte": days_until,
                "totalVisitas": purchase.get("totalVisitas", 0),
                "totalGasto": purchase.get("totalGasto", 0),
            })
    except ValueError:
        pass

birthday_upcoming.sort(key=lambda x: x["diasAte"])

# ============================================================
# 4. Build analytics summaries
# ============================================================

# Loyalty tiers
vip_clients = [c for c in clients if c["totalVisitas"] >= 10]
regulars = [c for c in clients if 3 <= c["totalVisitas"] < 10]
occasionals = [c for c in clients if 1 <= c["totalVisitas"] < 3]
no_visits = [c for c in clients if c["totalVisitas"] == 0]

# Top spenders
top_spenders = sorted(
    [c for c in clients if c["totalGasto"] > 0],
    key=lambda x: -x["totalGasto"]
)[:50]

# Most frequent visitors
most_frequent = sorted(
    [c for c in clients if c["totalVisitas"] > 0],
    key=lambda x: -x["totalVisitas"]
)[:50]

# Month names in Portuguese
month_names = {
    1: "Janeiro", 2: "Fevereiro", 3: "Março", 4: "Abril",
    5: "Maio", 6: "Junho", 7: "Julho", 8: "Agosto",
    9: "Setembro", 10: "Outubro", 11: "Novembro", 12: "Dezembro"
}

aniversarios_por_mes = [
    {"mes": month_names[m], "mesNum": m, "quantidade": birthday_by_month.get(m, 0)}
    for m in range(1, 13)
]

# ============================================================
# 5. Write clientes.json
# ============================================================
clientes_data = {
    "resumo": {
        "totalContatos": len(contact_records),
        "comAniversario": len(clients),
        "comTelefone": sum(1 for c in clients if c["telefone"]),
        "clientesVIP": len(vip_clients),
        "clientesRegulares": len(regulars),
        "clientesOcasionais": len(occasionals),
        "semCompras": len(no_visits),
    },
    "aniversariosPorMes": aniversarios_por_mes,
    "aniversariosProximos": birthday_upcoming[:30],
    "topGastadores": top_spenders,
    "maisFrequentes": most_frequent,
    "fidelidade": {
        "vip": {"qtd": len(vip_clients), "label": "VIP (10+ visitas)"},
        "regular": {"qtd": len(regulars), "label": "Regular (3-9 visitas)"},
        "ocasional": {"qtd": len(occasionals), "label": "Ocasional (1-2 visitas)"},
        "semCompra": {"qtd": len(no_visits), "label": "Sem compras registradas"},
    },
}

out_path = f"{OUT_DIR}/clientes.json"
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(clientes_data, f, ensure_ascii=False, indent=2)

print(f"\nWrote clientes.json:")
print(f"  Total contacts: {len(contact_records)}")
print(f"  With valid birthday: {len(clients)}")
print(f"  Upcoming birthdays (30d): {len(birthday_upcoming)}")
print(f"  VIP clients: {len(vip_clients)}")
print(f"  Regular clients: {len(regulars)}")
print(f"  Occasional clients: {len(occasionals)}")
print(f"  Top spender: {top_spenders[0]['nome'] if top_spenders else 'N/A'} (R$ {top_spenders[0]['totalGasto']:,.2f})" if top_spenders else "")
print(f"  Most frequent: {most_frequent[0]['nome'] if most_frequent else 'N/A'} ({most_frequent[0]['totalVisitas']} visits)" if most_frequent else "")
print("\nDone!")
