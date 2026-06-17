// Registra um ciclo de "ML via chat" (análise + melhoria do bot) na collection
// wa_ml_log — pra aparecer no histórico VISUAL do dashboard (aba Atendimento).
// Cada entrada leva um SNAPSHOT das métricas atuais (autonomia etc.), então o
// dashboard consegue desenhar a evolução rumo à independência.
//
// Uso:
//   node ml-log.mjs snapshot            → só registra um ponto de métrica (job semanal)
//   node ml-log.mjs '<json>'            → ciclo completo; json = {titulo, achados, mudancas:[...], commit, data?}
//
// A análise/decisão é feita pelo Claude no chat; este script só PERSISTE o registro.
import path from 'path'; import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { default: dotenv } = await import('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
const { listDocs, addDoc } = await import('./src/firestore.js');

const DIAS = 30;
const corte = Date.now() - DIAS * 86400e3;
const noPeriodo = c => new Date(c.updatedAt || c.UltimaMsgCliente || 0).getTime() >= corte;
const precisouHumano = c => c.status === 'humano' || /\[atendente\]/i.test(c.HistoricoJson || '');

const [conv, alertas, reservas] = await Promise.all([
  listDocs('wa_atendimento', 2000), listDocs('wa_alertas', 1000), listDocs('reservas', 3000),
]);
const periodo = conv.filter(noPeriodo);
const autonomas = periodo.filter(c => !precisouHumano(c));
const atendReais = autonomas.filter(c => (c.MsgsCliente || 0) > 1).length;
const resvP = reservas.filter(r => r.CriadoEm && new Date(r.CriadoEm).getTime() >= corte);
const iaR = resvP.filter(r => r.ViaBot).length;
const alP = alertas.filter(a => new Date(a.CriadoEm || a.criadoEm || 0).getTime() >= corte).length;
const Metricas = {
  autonomia: periodo.length ? Math.round(autonomas.length / periodo.length * 100) : 0,
  conversas: periodo.length,
  handoffs: alP,
  reservasIA: iaR,
  reservasHum: resvP.length - iaR,
  tempoEconMin: atendReais * 10,
};

const arg = process.argv[2] || '';
const hoje = new Date().toISOString().slice(0, 10);
let e;
if (arg === 'snapshot') {
  e = { Tipo: 'snapshot', Titulo: 'Snapshot semanal', Achados: '', Mudancas: [], Commit: '', Data: hoje };
} else {
  let j = {}; try { j = JSON.parse(arg); } catch { console.error('json inválido. uso: node ml-log.mjs \'{"titulo":"...","achados":"...","mudancas":["..."],"commit":"abc"}\''); process.exit(1); }
  e = { Tipo: 'ciclo', Titulo: j.titulo || 'Ciclo de melhoria', Achados: j.achados || '', Mudancas: j.mudancas || [], Commit: j.commit || '', Data: j.data || hoje };
}

const id = await addDoc('wa_ml_log', { ...e, Metricas, CriadoEm: new Date().toISOString() });
console.log(`wa_ml_log gravado (${id}) — ${e.Tipo}: ${e.Titulo} | autonomia ${Metricas.autonomia}%`);
process.exit(0);
