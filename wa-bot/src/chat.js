// Simulador de atendimento no terminal — mesmo cérebro da produção.
// Pra maturar o prompt e medir tokens sem WhatsApp:  npm run chat
// Comandos: /reset (nova conversa) · /tokens (acumulado) · /sair
import readline from 'readline';
import { cfg } from './config.js';
import { loadConv, saveConv } from './store.js';
import { atender, custoUSD } from './brain.js';

const TEL_TESTE = '5500999990000'; // telefone fake — conversa de teste no Firestore

if (!cfg.anthropicKey) {
  console.error('Falta ANTHROPIC_API_KEY no wa-bot/.env (copie de .env.example).');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

let total = { in: 0, out: 0, cw: 0, cr: 0, usd: 0, turnos: 0 };

function printUsage(usage) {
  const u = usage.reduce((a, x) => ({
    in: a.in + (x.input_tokens || 0),
    out: a.out + (x.output_tokens || 0),
    cw: a.cw + (x.cache_creation_input_tokens || 0),
    cr: a.cr + (x.cache_read_input_tokens || 0),
  }), { in: 0, out: 0, cw: 0, cr: 0 });
  const usd = usage.reduce((s, x) => s + custoUSD(x), 0);
  total = { in: total.in + u.in, out: total.out + u.out, cw: total.cw + u.cw, cr: total.cr + u.cr, usd: total.usd + usd, turnos: total.turnos + 1 };
  console.log(`\x1b[2m   tokens: ${u.in} in · ${u.out} out · cache ${u.cw}w/${u.cr}r · US$${usd.toFixed(5)} (R$${(usd * cfg.usdBrl).toFixed(4)}) · ${usage.length} chamada(s)\x1b[0m`);
}

console.log(`\n🍻 Simulador Javari (${cfg.model})`);
console.log('Você é o CLIENTE. Digite mensagens. /reset · /tokens · /sair\n');

let conv = await loadConv(TEL_TESTE);
if (conv.messages.length) console.log(`(retomando conversa com ${conv.messages.length} mensagens — /reset pra zerar)\n`);
conv.nomePerfil = conv.nomePerfil || 'Cliente Teste';

for (;;) {
  const texto = (await ask('\x1b[36mvocê:\x1b[0m ')).trim();
  if (!texto) continue;
  if (texto === '/sair') break;
  if (texto === '/reset') {
    conv = { telefone: TEL_TESTE, status: 'bot', messages: [], nomePerfil: 'Cliente Teste', origem: 'organico' };
    await saveConv(conv);
    console.log('(conversa zerada)\n');
    continue;
  }
  if (texto === '/tokens') {
    console.log(`acumulado: ${total.turnos} turnos · ${total.in + total.cw + total.cr} in (${total.cr} cacheados) · ${total.out} out · US$${total.usd.toFixed(4)} (R$${(total.usd * cfg.usdBrl).toFixed(3)})\n`);
    continue;
  }
  if (conv.status === 'humano') {
    console.log('\x1b[33m(conversa em modo humano — bot pausado; /reset pra voltar)\x1b[0m\n');
    continue;
  }
  try {
    const t0 = Date.now();
    const { reply, usage, handoff } = await atender(conv, texto);
    await saveConv(conv);
    console.log(`\x1b[32mjavari:\x1b[0m ${reply}   \x1b[2m(${((Date.now() - t0) / 1000).toFixed(1)}s)\x1b[0m`);
    printUsage(usage);
    if (handoff) console.log('\x1b[33m   ⚠ handoff: conversa marcada como "humano"\x1b[0m');
    console.log('');
  } catch (e) {
    console.error('erro:', e.message, '\n');
  }
}
rl.close();
console.log(`\nSessão: ${total.turnos} turnos · US$${total.usd.toFixed(4)} (R$${(total.usd * cfg.usdBrl).toFixed(3)})`);
