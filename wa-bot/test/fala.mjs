// Turno único de conversa com o bot REAL, com estado persistido — pro
// "time de clientes fakes" dirigido na sessão de treino.
//   node test/fala.mjs <telefone> <nomePerfil> "<mensagem>"
//   node test/fala.mjs --status <telefone>   (banco + conversa)
//   node test/fala.mjs --reset <telefone>    (apaga conversa e reservas do número)
import { atender, custoUSD } from '../src/brain.js';
import { loadConv, saveConv } from '../src/store.js';
import { queryDocs, deleteDoc } from '../src/firestore.js';

const [, , a, b, ...resto] = process.argv;

async function estado(tel) {
  const rs = await queryDocs('reservas', [['Whatsapp', tel]]);
  const al = await queryDocs('wa_alertas', [['Telefone', tel]]);
  const conv = await loadConv(tel);
  console.log('status conversa:', conv.status, '· msgs:', conv.messages.length);
  console.log('reservas:', JSON.stringify(rs.map(r => ({ id: r.id.slice(0, 6), Data: r.Data, Setor: r.Setor, Pessoas: r['Quantidade de Pessoas'], Nome: `${r.Nome} ${r.Sobrenome}`, Obs: (r.Observacoes || '').slice(0, 50) }))));
  if (al.length) console.log('alertas:', JSON.stringify(al.map(x => x.Motivo.slice(0, 70))));
}

if (a === '--status') { await estado(b); process.exit(0); }
if (a === '--reset') {
  for (const r of await queryDocs('reservas', [['Whatsapp', b]])) await deleteDoc('reservas/' + r.id);
  for (const x of await queryDocs('wa_alertas', [['Telefone', b]])) await deleteDoc('wa_alertas/' + x.id);
  for (const c of await queryDocs('wa_cancelamentos', [['Whatsapp', b]])) await deleteDoc('wa_cancelamentos/' + c.id);
  await deleteDoc('wa_atendimento/' + b).catch(() => {});
  console.log('resetado:', b);
  process.exit(0);
}

const tel = a, nome = b, msg = resto.join(' ');
const conv = await loadConv(tel);
conv.nomePerfil = conv.nomePerfil || nome;
if (conv.status === 'humano') { console.log('(modo humano — bot calado)'); process.exit(0); }
const r = await atender(conv, msg);
await saveConv(conv);
console.log('🤖', r.reply);
const usd = r.usage.reduce((s, u) => s + custoUSD(u), 0);
console.log(`   [US$${usd.toFixed(4)}${r.handoff ? ' · HANDOFF' : ''}]`);
