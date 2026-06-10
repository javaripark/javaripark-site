// Bot REATIVO rodando sobre o Baileys (via não-oficial).
// Reusa o cérebro do wa-bot (atender) — só o transporte muda (Baileys, não Cloud API).
//
// Modo recuperação ("remendo"): quando a máquina volta de offline, o WhatsApp
// entrega o backlog de uma vez. Em vez de responder em RAJADA (cara de spam =
// risco de ban), o agente responde o atrasado DEVAGAR, espaçado, com um
// "desculpa a demora". Mensagens ao vivo são respondidas na hora, normalmente.
import { atender, custoUSD } from '../../wa-bot/src/brain.js';
import { loadConv, saveConv } from '../../wa-bot/src/store.js';
import { addDoc } from '../../wa-bot/src/firestore.js';
import { cfg } from '../../wa-bot/src/config.js';
import { sendText } from './wa.js';

const DEBOUNCE_MS = 4000;      // agrupa mensagens picadas ao vivo
const LIVE_AGE_S = 90;         // mais novo que isso = ao vivo; mais velho = atrasado
const STALE_MAX_H = 12;        // não responde nada mais velho que isso (janela já fechada)
const RECOVERY_GAP_MS = 25000; // espaço entre respostas de recuperação (anti-rajada)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// dedup por id de mensagem (em memória; some no restart, mas o watermark abaixo cobre)
const seen = new Set();
function dedup(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 3000) { const it = seen.values(); for (let i = 0; i < 800; i++) seen.delete(it.next().value); }
  return false;
}

const pendentes = new Map();   // debounce ao vivo: telefone -> {texts, last, nome}
const recoveryBuf = new Map(); // recuperação: telefone -> {texts, nome, ts}
let recoveryRunning = false;

// Extrai texto e/ou tipo de mídia de uma mensagem do Baileys
function extractContent(message) {
  const text = message.conversation
    || message.extendedTextMessage?.text
    || message.ephemeralMessage?.message?.conversation
    || message.ephemeralMessage?.message?.extendedTextMessage?.text
    || '';
  let mediaType = '';
  if (!text) {
    if (message.audioMessage) mediaType = 'áudio';
    else if (message.imageMessage) mediaType = 'imagem';
    else if (message.videoMessage) mediaType = 'vídeo';
    else if (message.documentMessage) mediaType = 'documento';
    else if (message.stickerMessage) mediaType = 'figurinha';
    else if (message.locationMessage) mediaType = 'localização';
    else if (message.contactMessage || message.contactsArrayMessage) mediaType = 'contato';
  }
  return { text: (text || '').trim(), mediaType };
}

async function gravarUso(telefone, usage) {
  const t = usage.reduce((a, u) => ({
    In: a.In + (u.input_tokens || 0), Out: a.Out + (u.output_tokens || 0),
    CacheW: a.CacheW + (u.cache_creation_input_tokens || 0), CacheR: a.CacheR + (u.cache_read_input_tokens || 0),
  }), { In: 0, Out: 0, CacheW: 0, CacheR: 0 });
  const sp = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = `${sp.getFullYear()}-${String(sp.getMonth() + 1).padStart(2, '0')}-${String(sp.getDate()).padStart(2, '0')}`;
  await addDoc('wa_usage', {
    Telefone: telefone, Dia: dia, CriadoEm: new Date().toISOString(),
    ...t, Chamadas: usage.length, USD: usage.reduce((s, u) => s + custoUSD(u), 0), Modelo: cfg.model, Via: 'baileys',
  }).catch(e => console.error('[usage]', e.message));
}

async function handleMedia(telefone, nome, mediaType) {
  const conv = await loadConv(telefone);
  if (conv.status === 'humano') return;
  conv.nomePerfil = nome || conv.nomePerfil;
  const aviso = 'Opa! Por aqui eu só consigo ler texto 🙈 (não enxergo áudio, foto, figurinha nem localização). Me conta por escrito que eu te ajudo rapidinho!';
  conv.messages.push({ role: 'user', content: `[cliente enviou ${mediaType}]` });
  conv.messages.push({ role: 'assistant', content: aviso });
  await saveConv(conv);
  await sendText(telefone, aviso);
}

// Núcleo: processa um texto final (já agrupado) de um cliente.
async function processar(telefone, nome, textoFinal, { recovery, ts }) {
  const conv = await loadConv(telefone);
  conv.nomePerfil = nome || conv.nomePerfil;

  // Watermark anti-duplicação (cobre o restart): se a conversa já foi atualizada
  // DEPOIS desta mensagem, ela já foi tratada — não responde de novo.
  if (recovery && ts && conv.ultimaMsgCliente) {
    if (new Date(conv.ultimaMsgCliente).getTime() >= ts * 1000) return;
  }

  // Admin respondendo "ok" → só silêncio (renova janela)
  if (telefone === cfg.adminPhone && textoFinal.trim().toLowerCase() === 'ok') return;

  // "#bot" religa o atendente após handoff
  if (textoFinal.toLowerCase() === '#bot') {
    conv.status = 'bot';
    await saveConv(conv);
    await sendText(telefone, 'Prontinho, tô de volta! 😉 Como posso ajudar?');
    return;
  }

  // Equipe assumiu (handoff) → registra e fica quieto
  if (conv.status === 'humano') {
    conv.messages.push({ role: 'user', content: textoFinal });
    conv.primeiroContato = conv.primeiroContato || new Date().toISOString();
    conv.ultimaMsgCliente = new Date().toISOString();
    conv.msgsCliente = (conv.msgsCliente || 0) + 1;
    await saveConv(conv);
    return;
  }

  const agora = new Date().toISOString();
  conv.primeiroContato = conv.primeiroContato || agora;
  conv.ultimaMsgCliente = agora;
  conv.msgsCliente = (conv.msgsCliente || 0) + 1;

  const { reply, usage, handoff, reservou, negociou } = await atender(conv, textoFinal);
  if (reservou) { conv.etapa = 'ganho'; conv.reservouEm = agora; }
  else if (negociou && conv.etapa !== 'ganho') conv.etapa = 'negociacao';
  await saveConv(conv);
  await gravarUso(telefone, usage);

  let out = reply;
  if (recovery && out) out = 'Oi! Desculpa a demora pra te responder 🙏\n\n' + out;
  if (out) await sendText(telefone, out);

  // Alerta de handoff pro admin (via Baileys — sem template, é não-oficial)
  if (handoff && cfg.adminPhone) {
    await sendText(cfg.adminPhone,
      `⚠️ *Bot pausado — cliente esperando atendimento*\n👤 ${conv.nomePerfil || 'Cliente'} · wa.me/${telefone}\n💬 Última mensagem: "${textoFinal.slice(0, 120)}"\n\n(Responda o cliente pelo app; o bot fica quieto até alguém mandar #bot ou passarem 24h.)`);
  }

  const cost = usage.reduce((s, u) => s + custoUSD(u), 0);
  console.log(`[${telefone}] ${recovery ? 'RECUP·' : ''}US$${cost.toFixed(5)} · "${textoFinal.slice(0, 50)}"${handoff ? ' · HANDOFF' : ''}`);
}

// Debounce de mensagens picadas ao vivo (a última "vence")
async function liveDebounce(telefone, nome, text, msgId) {
  const lote = pendentes.get(telefone) || { texts: [], nome: '' };
  lote.texts.push(text);
  lote.last = msgId;
  lote.nome = nome || lote.nome;
  pendentes.set(telefone, lote);
  await sleep(DEBOUNCE_MS);
  if (pendentes.get(telefone)?.last !== msgId) return; // chegou msg mais nova
  pendentes.delete(telefone);
  await processar(telefone, lote.nome, lote.texts.join('\n'), { recovery: false });
}

// Recuperação: processa o backlog DEVAGAR, um cliente por vez, espaçado.
function bufferRecovery(telefone, nome, text, ts) {
  const b = recoveryBuf.get(telefone) || { texts: [], nome: '', ts };
  b.texts.push(text);
  b.nome = nome || b.nome;
  b.ts = Math.min(b.ts || ts, ts); // guarda o mais antigo pro watermark
  recoveryBuf.set(telefone, b);
}
async function runRecovery() {
  if (recoveryRunning) return;
  recoveryRunning = true;
  try {
    await sleep(3000); // agrupa fragmentos que chegam juntos no reconnect
    while (recoveryBuf.size) {
      const [telefone, b] = recoveryBuf.entries().next().value;
      recoveryBuf.delete(telefone);
      try { await processar(telefone, b.nome, b.texts.join('\n'), { recovery: true, ts: b.ts }); }
      catch (e) { console.error('[recovery]', telefone, e.message); }
      if (recoveryBuf.size) await sleep(RECOVERY_GAP_MS); // espaça → sem rajada
    }
  } finally { recoveryRunning = false; }
}

// Handler chamado pelo wa.js a cada mensagem recebida.
// type: 'notify' = nova/entregue agora · 'append' = sync de histórico antigo (ignorar)
export async function handleIncoming(m, type) {
  try {
    if (type === 'append') return;                         // histórico antigo → não responde
    if (!m.message || m.key?.fromMe) return;
    const jid = m.key?.remoteJid || '';
    if (!jid.endsWith('@s.whatsapp.net')) return;          // grupo/status → ignora
    const telefone = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    if (!telefone) return;
    if (dedup(m.key.id)) return;

    const ts = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);
    const ageS = Math.floor(Date.now() / 1000) - ts;
    if (ageS > STALE_MAX_H * 3600) return;                 // velho demais → ignora

    const nome = m.pushName || '';
    const { text, mediaType } = extractContent(m.message);

    if (!text) { if (mediaType) await handleMedia(telefone, nome, mediaType); return; }

    if (ageS > LIVE_AGE_S) { bufferRecovery(telefone, nome, text, ts); runRecovery(); }
    else { liveDebounce(telefone, nome, text, m.key.id); }
  } catch (e) {
    console.error('[agent] erro:', e.message);
  }
}
