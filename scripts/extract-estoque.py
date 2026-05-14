#!/usr/bin/env python3
import subprocess, json
from datetime import datetime

def query(sql):
    cmd = ['docker', 'exec', '-i', 'firebird-consumer',
           '/usr/local/firebird/bin/isql', '-user', 'SYSDBA',
           '-password', 'masterkey', '-charset', 'WIN1252',
           '/firebird/data/consumer.fdb']
    proc = subprocess.run(cmd, input=sql.encode('latin-1'), capture_output=True)
    return proc.stdout.decode('cp1252', errors='replace')

sql = """
SELECT pd.CODIGO || '|' || p.CODIGO || '|' || COALESCE(p.NOME,'') || '|' ||
       pd.ESTOQUEATUAL || '|' || pd.ESTOQUEMINIMO || '|' ||
       COALESCE(pd.PRECOCUSTO,0) || '|' || COALESCE(pd.PRECOVENDA,0)
FROM PRODUTODETALHE pd
JOIN PRODUTOS p ON p.CODIGO = pd.CODIGOPRODUTO
WHERE pd.DATADELETE IS NULL
  AND (pd.ESTOQUEATUAL <> 0 OR pd.ESTOQUEMINIMO > 0)
ORDER BY p.NOME;
"""
out = query(sql)

items = []
for line in out.strip().split('\n'):
    line = line.strip()
    if not line or '=====' in line or 'CONCATENATION' in line or '|' not in line:
        continue
    parts = line.split('|')
    if len(parts) < 7:
        continue
    try:
        items.append({
            'pdCodigo': int(parts[0].strip()),
            'prodCodigo': int(parts[1].strip()),
            'nome': parts[2].strip(),
            'estoqueAtual': round(float(parts[3].strip()), 2),
            'estoqueMinimo': round(float(parts[4].strip()), 2),
            'precoCusto': round(float(parts[5].strip()), 2),
            'precoVenda': round(float(parts[6].strip()), 2),
        })
    except (ValueError, IndexError):
        continue

try:
    with open('/Users/rene/Downloads/JAVARI PARK/public/data/produtos-consumer.json', 'r') as f:
        pdata = json.load(f)
    cat_lookup = {}
    tipo_lookup = {}
    for p in pdata.get('produtos', []) + pdata.get('insumos', []):
        cat_lookup[p['nome'].upper().strip()] = p.get('categoria', '')
        tipo_lookup[p['nome'].upper().strip()] = p.get('tipo', '')
    for item in items:
        key = item['nome'].upper().strip()
        item['categoria'] = cat_lookup.get(key, '')
        item['tipo'] = tipo_lookup.get(key, '')
except Exception as e:
    print(f'Warning: Could not load categories: {e}')

for item in items:
    if item['estoqueMinimo'] > 0 and item['estoqueAtual'] <= item['estoqueMinimo']:
        item['status'] = 'baixo'
    elif item['estoqueMinimo'] > 0 and item['estoqueAtual'] <= item['estoqueMinimo'] * 1.5:
        item['status'] = 'atencao'
    else:
        item['status'] = 'ok'

baixo = sum(1 for i in items if i['status'] == 'baixo')
atencao = sum(1 for i in items if i['status'] == 'atencao')
com_minimo = sum(1 for i in items if i['estoqueMinimo'] > 0)

result = {
    'syncedAt': datetime.now().isoformat(),
    'totalItens': len(items),
    'comMinimo': com_minimo,
    'estoqueBaixo': baixo,
    'estoqueAtencao': atencao,
    'itens': items
}

outpath = '/Users/rene/Downloads/JAVARI PARK/public/data/estoque.json'
with open(outpath, 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f'Estoque: {len(items)} itens, {com_minimo} com minimo, {baixo} baixo, {atencao} atencao')
