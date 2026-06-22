// Converte o CSV exportado do Meta Ads Manager (boosts do Instagram) no
// public/data/ads-snapshot.json que a aba "Anúncios" do dashboard lê.
// A conta de promoções do Instagram não tem API → atualização é manual:
//   node scripts/ads-csv-to-snapshot.mjs "/caminho/para/Campaigns-....csv"
// Mapeia colunas pelo NOME do cabeçalho (robusto a reordenação entre exports).
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const csvPath = process.argv[2];
if (!csvPath) { console.error('uso: node scripts/ads-csv-to-snapshot.mjs <arquivo.csv>'); process.exit(1); }

// parser CSV simples com aspas (campos podem ter vírgula dentro de "")
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
  start: idx('Reporting starts'), end: idx('Reporting ends'), name: idx('Campaign name'),
  delivery: idx('Campaign delivery'), results: idx('Results'), reach: idx('Reach'),
  spent: idx('Amount spent (BRL)', 'Amount spent'), impressions: idx('Impressions'),
  clicks: idx('Link clicks'), cpr: idx('Cost per results', 'Cost per result'),
  ctr: idx('CTR (link click-through rate)'), ends: idx('Ends'),
};
const num = v => { const n = parseFloat(String(v || '').replace(/[^\d.\-]/g, '')); return isNaN(n) ? 0 : n; };
const STATUS = { active: 'ativa', paused: 'pausada', completed: 'encerrada', recently_completed: 'encerrada', inactive: 'inativa' };

let inactiveCount = 0;
const campaigns = [];
for (const r of rows.slice(1)) {
  const spent = num(r[C.spent]); const results = num(r[C.results]);
  const status = STATUS[(r[C.delivery] || '').trim()] || 'encerrada';
  if (status === 'inativa' || (spent === 0 && results === 0)) { inactiveCount++; continue; }
  campaigns.push({
    name: (r[C.name] || '').trim().replace(/\.\.\.$/, '…'),
    status,
    spent: +spent.toFixed(2),
    conversations: Math.round(results),
    costPerConv: results > 0 ? +(spent / results).toFixed(2) : 0,
    reach: Math.round(num(r[C.reach])),
    impressions: Math.round(num(r[C.impressions])),
    linkClicks: Math.round(num(r[C.clicks])),
    ctr: +num(r[C.ctr]).toFixed(3),
    ends: (r[C.ends] || '').trim().match(/^\d{4}-\d{2}-\d{2}$/) ? r[C.ends].trim() : '',
  });
}

const sum = k => campaigns.reduce((s, c) => s + (c[k] || 0), 0);
const spent = +sum('spent').toFixed(2), conversations = sum('conversations');
const snap = {
  snapshotDate: rows[1][C.end] || new Date().toISOString().slice(0, 10),
  periodStart: rows[1][C.start] || '',
  periodEnd: rows[1][C.end] || '',
  source: 'Meta Ads Manager — boosts do Instagram (conta fora do Business)',
  currency: 'BRL',
  manual: true,
  totals: {
    spent, conversations,
    costPerConversation: conversations ? +(spent / conversations).toFixed(2) : 0,
    reach: sum('reach'),            // soma por campanha (aprox.: alcance único do total não vem no CSV)
    impressions: sum('impressions'),
    linkClicks: sum('linkClicks'),
  },
  inactiveCount,
  campaigns,
};

const out = path.join(__dirname, '..', 'public', 'data', 'ads-snapshot.json');
fs.writeFileSync(out, JSON.stringify(snap, null, 2));
console.log(`ads-snapshot.json atualizado: ${snap.periodStart} → ${snap.periodEnd}`);
console.log(`  gasto R$${spent.toFixed(2)} · ${conversations} conversas · custo/conversa R$${snap.totals.costPerConversation} · ${campaigns.length} campanhas (+${inactiveCount} inativa)`);
console.log(`  alcance ${snap.totals.reach.toLocaleString('pt-BR')} (somado) · ${snap.totals.impressions.toLocaleString('pt-BR')} impressões`);
