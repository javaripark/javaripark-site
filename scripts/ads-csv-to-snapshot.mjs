// Converte o CSV exportado do Meta Ads Manager (boosts do Instagram) no
// public/data/ads-snapshot.json que a aba "Anúncios" do dashboard lê.
// A conta de promoções do Instagram não tem API → atualização é manual:
//   node scripts/ads-csv-to-snapshot.mjs "/caminho/Campaigns-....csv"
//
// Aceita 2 formatos:
//  - AGREGADO (1 linha por campanha): preenche KPIs + tabela + destaques.
//  - BREAKDOWN SEMANAL/DIÁRIO (várias linhas por campanha, uma por período):
//    além do acima, monta a série temporal (campo "evolution") pros gráficos.
// Mapeia colunas pelo NOME do cabeçalho (robusto a reordenação).
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const csvPath = process.argv[2];
if (!csvPath) { console.error('uso: node scripts/ads-csv-to-snapshot.mjs <arquivo.csv>'); process.exit(1); }

function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; } }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = fs.readFileSync(csvPath, 'utf8');
const rows = parseCSV(raw).filter(r => r.some(c => c.trim() !== ''));
const head = rows[0].map(h => h.trim());
const idx = (...names) => { for (const n of names) { const i = head.findIndex(h => h.toLowerCase() === n.toLowerCase()); if (i >= 0) return i; } return -1; };
const C = {
  start: idx('Reporting starts', 'Início dos relatórios'), end: idx('Reporting ends', 'Término dos relatórios'),
  name: idx('Campaign name', 'Nome da campanha', 'Ad name', 'Nome do anúncio', 'Ad set name'),
  delivery: idx('Campaign delivery', 'Veiculação da campanha', 'Ad delivery', 'Delivery', 'Status'),
  results: idx('Results', 'Resultados'), reach: idx('Reach', 'Alcance'),
  spent: idx('Amount spent (BRL)', 'Amount spent', 'Valor usado (BRL)'), impressions: idx('Impressions', 'Impressões'),
  clicks: idx('Link clicks', 'Cliques no link'), ctr: idx('CTR (link click-through rate)'), ends: idx('Ends', 'Termina em'),
  freq: idx('Frequency', 'Frequência'), week: idx('Week', 'Day', 'Date', 'Semana', 'Dia', 'Data'),
  qRank: idx('Quality ranking', 'Classificação de qualidade'),
  eRank: idx('Engagement rate ranking', 'Classificação da taxa de engajamento'),
  cRank: idx('Conversion rate ranking', 'Classificação da taxa de conversão'),
  lpv: idx('Landing page views', 'Visualizações da página de destino'),
};
const num = v => { let s = String(v || '').trim().replace(/[^\d.,\-]/g, ''); if (!s) return 0; const hasC = s.includes(','), hasD = s.includes('.'); if (hasC && hasD) { if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, ''); } else if (hasC) s = s.replace(',', '.'); const n = parseFloat(s); return isNaN(n) ? 0 : n; };
const rk = v => { const s = String(v || '').trim().toLowerCase(); if (!s || s === '-' || s === '—' || s.includes('uncategor') || s.includes('categor')) return ''; if (s.includes('above') || s.includes('acima')) return 'acima'; if (s.includes('below') || s.includes('abaixo')) return 'abaixo'; if (s.includes('average') || s.includes('média') || s.includes('media')) return 'media'; return ''; };
const STATUS = { active: 'ativa', paused: 'pausada', completed: 'encerrada', recently_completed: 'encerrada', inactive: 'inativa' };
const data = rows.slice(1).map(r => ({
  name: (r[C.name] || '').trim().replace(/\.\.\.$/, '…'),
  delivery: (r[C.delivery] || '').trim(),
  results: num(r[C.results]), reach: Math.round(num(r[C.reach])), spent: num(r[C.spent]),
  impressions: Math.round(num(r[C.impressions])), clicks: Math.round(num(r[C.clicks])),
  ends: (r[C.ends] || '').trim().match(/^\d{4}-\d{2}-\d{2}$/) ? r[C.ends].trim() : '',
  pStart: (r[C.start] || '').trim(), pEnd: (r[C.end] || '').trim(),
  bucket: C.week >= 0 ? (r[C.week] || '').trim() : '',
  lpv: Math.round(num(r[C.lpv])), qRank: rk(r[C.qRank]), eRank: rk(r[C.eRank]), cRank: rk(r[C.cRank]),
}));

// ---- série temporal (evolution): por bucket de período ----
// bucket = coluna Week/Day se existir; senão o par (Reporting starts→ends) de cada linha
const keyOf = d => d.bucket || (d.pStart && d.pEnd ? `${d.pStart}→${d.pEnd}` : '');
const buckets = [...new Set(data.map(keyOf).filter(Boolean))];
let evolution = [];
if (buckets.length > 1) {
  const byB = {};
  for (const d of data) { const k = keyOf(d); if (!k) continue; (byB[k] ||= { spent: 0, conversations: 0, reach: 0, impressions: 0, linkClicks: 0 }); const b = byB[k]; b.spent += d.spent; b.conversations += d.results; b.reach += d.reach; b.impressions += d.impressions; b.linkClicks += d.clicks; }
  evolution = Object.entries(byB).map(([k, b]) => ({
    label: k.includes('→') ? k.split('→')[0] : k,
    periodEnd: k.includes('→') ? k.split('→')[1] : k,
    spent: +b.spent.toFixed(2), conversations: Math.round(b.conversations),
    costPerConv: b.conversations > 0 ? +(b.spent / b.conversations).toFixed(2) : 0,
    reach: b.reach, impressions: b.impressions, linkClicks: b.linkClicks,
    ctr: b.impressions > 0 ? +(b.linkClicks / b.impressions * 100).toFixed(3) : 0,
    cpm: b.impressions > 0 ? +(b.spent / b.impressions * 1000).toFixed(2) : 0,
    freq: b.reach > 0 ? +(b.impressions / b.reach).toFixed(2) : 0,
  })).sort((a, b) => (a.periodEnd || a.label).localeCompare(b.periodEnd || b.label));
}

// ---- campanhas ----
// Série temporal (breakdown semanal): mesma campanha aparece em várias linhas (1/semana)
// → agrega por NOME. CSV agregado (1 período): nomes repetidos são BOOSTS separados do
// mesmo post → mantém cada linha (não mescla).
const isTimeSeries = buckets.length > 1;
let inactiveCount = 0; const groups = {};
data.forEach((d, i) => {
  const status = STATUS[d.delivery] || 'encerrada';
  if (status === 'inativa' || (d.spent === 0 && d.results === 0)) { inactiveCount++; return; }
  const key = isTimeSeries ? d.name : `${d.name}@@${i}`; // agregado: cada linha é única
  const c = (groups[key] ||= { name: d.name, status, spent: 0, conversations: 0, reach: 0, impressions: 0, linkClicks: 0, lpv: 0, ends: '', qRank: '', eRank: '', cRank: '' });
  c.spent += d.spent; c.conversations += d.results; c.reach = Math.max(c.reach, d.reach);
  c.impressions += d.impressions; c.linkClicks += d.clicks; c.lpv += d.lpv;
  if (d.ends > c.ends) c.ends = d.ends;
  if (d.qRank) c.qRank = d.qRank; if (d.eRank) c.eRank = d.eRank; if (d.cRank) c.cRank = d.cRank;
  if (status === 'ativa') c.status = 'ativa';
});
const campaigns = Object.values(groups).map(c => ({
  name: c.name, status: c.status, spent: +c.spent.toFixed(2), conversations: Math.round(c.conversations),
  costPerConv: c.conversations > 0 ? +(c.spent / c.conversations).toFixed(2) : 0,
  reach: c.reach, impressions: c.impressions, linkClicks: c.linkClicks, lpv: c.lpv,
  ctr: c.impressions > 0 ? +(c.linkClicks / c.impressions * 100).toFixed(3) : 0,
  cpm: c.impressions > 0 ? +(c.spent / c.impressions * 1000).toFixed(2) : 0,
  cpc: c.linkClicks > 0 ? +(c.spent / c.linkClicks).toFixed(2) : 0,
  freq: c.reach > 0 ? +(c.impressions / c.reach).toFixed(2) : 0,
  qRank: c.qRank, eRank: c.eRank, cRank: c.cRank, ends: c.ends,
}));

const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
const spent = +sum(campaigns, 'spent').toFixed(2), conversations = sum(campaigns, 'conversations');
const allStarts = data.map(d => d.pStart).filter(Boolean).sort();
const allEnds = data.map(d => d.pEnd).filter(Boolean).sort();
const snap = {
  snapshotDate: allEnds[allEnds.length - 1] || new Date().toISOString().slice(0, 10),
  periodStart: allStarts[0] || '', periodEnd: allEnds[allEnds.length - 1] || '',
  source: 'Meta Ads Manager — boosts do Instagram (conta fora do Business)',
  currency: 'BRL', manual: true,
  totals: (() => { const reach = sum(campaigns, 'reach'), impressions = sum(campaigns, 'impressions'), linkClicks = sum(campaigns, 'linkClicks'), lpv = sum(campaigns, 'lpv');
    return { spent, conversations, costPerConversation: conversations ? +(spent / conversations).toFixed(2) : 0,
    reach, impressions, linkClicks, lpv,
    ctr: impressions ? +(linkClicks / impressions * 100).toFixed(3) : 0,
    cpm: impressions ? +(spent / impressions * 1000).toFixed(2) : 0,
    cpc: linkClicks ? +(spent / linkClicks).toFixed(2) : 0,
    freq: reach ? +(impressions / reach).toFixed(2) : 0 }; })(),
  evolution, inactiveCount, campaigns,
};

fs.writeFileSync(path.join(__dirname, '..', 'public', 'data', 'ads-snapshot.json'), JSON.stringify(snap, null, 2));
console.log(`ads-snapshot.json: ${snap.periodStart} → ${snap.periodEnd}`);
console.log(`  R$${spent.toFixed(2)} · ${conversations} conversas · custo/conversa R$${snap.totals.costPerConversation} · ${campaigns.length} campanhas (+${inactiveCount} inativa)`);
console.log(`  evolução: ${evolution.length} pontos no tempo ${evolution.length ? '✓' : '(CSV agregado — exporte com breakdown semanal pra preencher)'}`);
