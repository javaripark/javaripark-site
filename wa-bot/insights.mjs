// Digest de insights do atendimento — material pra MELHORAR O PROMPT via chat.
// "machine learning programático via chat": este script CRUNCHA os dados (números,
// buckets, padrões); a ANÁLISE/decisão é feita pelo Claude no chat, lendo o digest.
// NÃO chama LLM/API — é só agregação determinística.
//
// Uso:   node wa-bot/insights.mjs [dias]        (default 30)
//        node wa-bot/insights.mjs 14 --save     (salva em ~/Library/Logs/javari-insights/)
//
// Rotina: rode quando quiser e cole o resultado no chat com o Claude, pedindo
// "analisa e proponha ajustes no prompt". Também roda sozinho via LaunchAgent
// (com.javari.insights) — ver CLAUDE.md (Runbook).
import path from 'path'; import { fileURLToPath } from 'url';
import fs from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { default: dotenv } = await import('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
const { listDocs } = await import('./src/firestore.js');

const DIAS = parseInt(process.argv.find(a => /^\d+$/.test(a)) || '30', 10);
const SAVE = process.argv.includes('--save');
const agora = Date.now();
const corte = agora - DIAS * 86400e3;
const txtDe = m => Array.isArray(m.content) ? m.content.filter(b => b?.type === 'text').map(b => b.text).join(' ') : String(m.content || '');
const msgs = c => { try { return JSON.parse(c.HistoricoJson || '[]'); } catch { return []; } };
const noPeriodo = c => new Date(c.updatedAt || c.UltimaMsgCliente || 0).getTime() >= corte;
const pct = (n, d) => d ? Math.round(n / d * 100) : 0;

const [conv, alertas, reservas, usage] = await Promise.all([
  listDocs('wa_atendimento', 2000), listDocs('wa_alertas', 1000),
  listDocs('reservas', 3000), listDocs('wa_usage', 5000),
]);

const periodo = conv.filter(noPeriodo);
const precisouHumano = c => c.status === 'humano' || /\[atendente\]/i.test(c.HistoricoJson || '');
const autonomas = periodo.filter(c => !precisouHumano(c));
const atendReais = autonomas.filter(c => (c.MsgsCliente || 0) > 1);
const resvP = reservas.filter(r => r.CriadoEm && new Date(r.CriadoEm).getTime() >= corte);
const iaR = resvP.filter(r => r.ViaBot).length, humR = resvP.length - iaR;
const custoP = usage.filter(u => u.CriadoEm && new Date(u.CriadoEm).getTime() >= corte && u.Telefone !== 'AJUSTE-TESTES-CLAUDE')
  .reduce((s, u) => s + (u.USD || 0), 0);
// tempo médio OBSERVADO por atendimento = span (1º contato → última msg), capado a 30min
const spansMin = atendReais.filter(c => c.PrimeiroContato && c.UltimaMsgCliente)
  .map(c => Math.min(30, Math.max(0, (new Date(c.UltimaMsgCliente) - new Date(c.PrimeiroContato)) / 60000)));
const avgMin = spansMin.length ? spansMin.reduce((s, d) => s + d, 0) / spansMin.length : 10;
const minutos = Math.round(atendReais.length * avgMin);

// --- Temas das perguntas do cliente (buckets por palavra-chave) ---
const TEMAS = [
  ['foto/mapa/ver o espaço', /\bfoto|imagem|v[ií]deo|mapa|conhe[cç]|como [ée] o (lugar|espa[cç]o)|onde fica/i],
  ['preço/entrada', /\bpre[cç]o|valor|quanto|entrada|couvert|consuma[cç]/i],
  ['horário/funcionamento', /\bhor[aá]rio|que horas|abre|fecha|at[ée] que horas/i],
  ['reserva', /\breserv|mesa|garantir|setor/i],
  ['copa/jogo', /\bjogo|copa|brasil|tel[aã]o|partida/i],
  ['música/atração', /\bm[uú]sica|banda|atra[cç][aã]o|samba|pagode|sertanejo|ao vivo|show/i],
  ['bus/banheira', /\bbus|l?ounge|camarote|banheira|karaok/i],
  ['criança/menor', /\bcrian[cç]|menor|kids|filh/i],
  ['fumar', /\bfum|cigarro|narguil|tabac/i],
  ['pet', /\bpet|cachorr|cs?[aã]o\b|gat/i],
  ['estacionamento', /\bestacion|vaga|carro/i],
  ['acessibilidade', /\bcadeirant|pcd|acess[ií]vel|defici/i],
  ['cardápio/comida', /\bcard[aá]pio|comida|petisc|bebida|drink|cozinha|vegan|vegetarian|gl[uú]ten/i],
  ['aniversário', /\banivers|brinde|convite/i],
  ['pagamento', /\bpagamento|pix|cart[aã]o|d[ée]bito|cr[ée]dito|vale|vr|va\b/i],
];
const temaCount = TEMAS.map(([nome]) => [nome, 0]);
for (const c of periodo) for (const m of msgs(c)) {
  if (m.role !== 'user') continue;
  const t = txtDe(m);
  TEMAS.forEach(([, re], i) => { if (re.test(t)) temaCount[i][1]++; });
}
temaCount.sort((a, b) => b[1] - a[1]);

// --- Sinais de problema na fala do BOT (regressões a caçar) ---
const PROBLEMAS = [
  ['vazou termo interno (overflow/filho/pai)', /\boverflow|setor filho|setor pai\b/i],
  ['expôs ocupação (lotado/cheio/principais/só sobra)', /\blotad|tá cheio|está cheio|principais (já )?reservad|s[óo] sobra|j[áa] fecharam/i],
  ['vazou token __SILENCIO__', /sil[eê]ncio_{0,2}|_{2}sil/i],
  ['negrito markdown (**)', /\*\*/],
  ['pediu desculpa por não ver foto', /n[aã]o consigo ver|s[óo] (consigo )?ler texto|n[aã]o enxergo/i],
  ['prometeu sem executar (contradição)', /reserva (confirmada|feita).{0,30}(mas|por[ée]m).{0,30}(ocupad|cheio)/i],
];
const probHits = PROBLEMAS.map(([nome]) => [nome, []]);
for (const c of periodo) for (const m of msgs(c)) {
  if (m.role !== 'assistant') continue;
  const t = txtDe(m); if (!t || /^\[atendente\]/i.test(t)) continue;
  PROBLEMAS.forEach(([, re], i) => { if (re.test(t)) probHits[i][1].push({ tel: c.id, trecho: t.slice(0, 110) }); });
}

// --- Frustração do cliente ---
const frustRe = /\?{2,}|ningu[ée]m responde|al[oô]\?|cad[ée]|n[aã]o respond|demora|p[ée]ssimo|horr[ií]vel|absurdo|reclama/i;
const frustrados = [];
for (const c of periodo) {
  const f = msgs(c).filter(m => m.role === 'user' && frustRe.test(txtDe(m)));
  if (f.length) frustrados.push({ tel: c.id, nome: c.NomePerfil || '—', trecho: txtDe(f[0]).slice(0, 100) });
}

// --- Handoffs por motivo (alertas no período) ---
const alP = alertas.filter(a => new Date(a.CriadoEm || a.criadoEm || 0).getTime() >= corte);
const motivos = alP.map(a => (a.Motivo || a.motivo || 'sem motivo').toString());

// --- Conversas que precisaram de humano (pra analisar gaps) ---
const handoffDetalhe = periodo.filter(precisouHumano).slice(0, 25).map(c => {
  const primeira = msgs(c).find(m => m.role === 'user');
  return { tel: c.id, nome: c.NomePerfil || '—', abriu: primeira ? txtDe(primeira).slice(0, 90) : '—' };
});

// ---------- monta markdown ----------
const L = [];
L.push(`# Digest de atendimento — últimos ${DIAS} dias`);
L.push(`_gerado ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${periodo.length} conversas no período_\n`);
L.push(`## 1. Resumo`);
L.push(`- Conversas: **${periodo.length}**`);
L.push(`- Autonomia (sem humano): **${pct(autonomas.length, periodo.length)}%** (${autonomas.length}/${periodo.length})`);
L.push(`- Reservas IA × Humano: **${iaR} × ${humR}** (${pct(iaR, resvP.length)}% automatizadas)`);
L.push(`- Tempo economizado (estim.): **≈ ${Math.floor(minutos / 60)}h ${minutos % 60}min** (${atendReais.length} atend. autônomos × ~${avgMin.toFixed(0)} min observados, capado a 30min)`);
L.push(`- Custo Claude API no período: **US$ ${custoP.toFixed(2)}**`);
L.push(`- Handoffs (alertas): **${alP.length}**\n`);
L.push(`## 2. O que o cliente mais pergunta (temas)`);
temaCount.filter(([, n]) => n > 0).forEach(([nome, n]) => L.push(`- ${nome}: **${n}**`));
L.push(`\n## 3. Handoffs por motivo (oportunidades de independência)`);
if (motivos.length) motivos.forEach((m, i) => L.push(`${i + 1}. ${m.slice(0, 140)}`)); else L.push(`- (nenhum no período)`);
L.push(`\n## 4. ⚠ Sinais de problema na fala do bot (regressões a corrigir no prompt/código)`);
let algumProb = false;
probHits.forEach(([nome, hits]) => { if (hits.length) { algumProb = true; L.push(`- **${nome}**: ${hits.length}x`); hits.slice(0, 3).forEach(h => L.push(`    - [${h.tel}] "${h.trecho}"`)); } });
if (!algumProb) L.push(`- nenhum padrão problemático detectado ✓`);
L.push(`\n## 5. Clientes com sinais de frustração`);
if (frustrados.length) frustrados.slice(0, 12).forEach(f => L.push(`- [${f.tel}] ${f.nome}: "${f.trecho}"`)); else L.push(`- nenhum ✓`);
L.push(`\n## 6. Conversas que precisaram de humano (analisar se dava pro bot resolver)`);
if (handoffDetalhe.length) handoffDetalhe.forEach(h => L.push(`- [${h.tel}] ${h.nome} — abriu: "${h.abriu}"`)); else L.push(`- nenhuma ✓`);
L.push(`\n---\n## Para o Claude (no chat)`);
L.push(`Leia este digest e proponha: (a) ajustes no prompt pra reduzir os handoffs da seção 3 e os problemas da seção 4; (b) FAQs faltando, olhando a seção 2; (c) qualquer padrão de frustração (seção 5) que indique falha de UX. Foque em INDEPENDÊNCIA: o que o bot escalou que poderia resolver sozinho.`);

const out = L.join('\n');
console.log(out);
if (SAVE) {
  const dir = path.join(process.env.HOME, 'Library/Logs/javari-insights');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `insights-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, out);
  console.error(`\n[salvo em ${file}]`);
}
process.exit(0);
