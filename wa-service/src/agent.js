// Bot REATIVO rodando sobre o Baileys (via não-oficial).
// Reusa o cérebro do wa-bot (atender) — só o transporte muda (Baileys, não Cloud API).
//
// Modo recuperação ("remendo"): quando a máquina volta de offline, o WhatsApp
// entrega o backlog de uma vez. Em vez de responder em RAJADA (cara de spam =
// risco de ban), o agente responde o atrasado DEVAGAR, espaçado, com um
// "desculpa a demora". Mensagens ao vivo são respondidas na hora, normalmente.
import { atender, custoUSD } from '../../wa-bot/src/brain.js';
import { loadConv, saveConv } from '../../wa-bot/src/store.js';
import { addDoc, getDoc } from '../../wa-bot/src/firestore.js';
import { cfg } from '../../wa-bot/src/config.js';
import { config } from './config.js';
import { sendText, sendToJid, resolvePhone, extractAdReferral } from './wa.js';
import { getAdReferral, recordAdReferral } from './store.js';

const DEBOUNCE_MS = 10000;     // agrupa mensagens picadas ao vivo (espera 10s após a última; gente escreve em 3 msgs)
const MEDIA_COOLDOWN_MS = 90000; // 1 aviso "só leio texto" por rajada de mídia (cliente manda 5 fotos = 1 resposta, não 5)
const LIVE_AGE_S = 90;         // mais novo que isso = ao vivo; mais velho = atrasado
const STALE_MAX_H = 12;        // não responde nada mais velho que isso (janela já fechada)
const RECOVERY_GAP_MS = 25000; // espaço entre respostas de recuperação (anti-rajada)

// Pausa GLOBAL do bot — o painel grava wa_config/main.BotPausado (true/false).
// Cache de 15s pra não ler o Firestore a cada mensagem; aplicar leva no máx ~15s.
// Pausado = o bot fica em silêncio (a equipe atende manual pelo app); retomar é 1 clique.
let _pausa = { v: false, at: 0 };
async function botPausado() {
  if (Date.now() - _pausa.at < 15000) return _pausa.v;
  try { const d = await getDoc('wa_config/main'); _pausa = { v: !!(d && d.BotPausado), at: Date.now() }; }
  catch { /* falha de leitura: fail-open (não pausa) */ }
  return _pausa.v;
}

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
const midiaUltimoAviso = new Map(); // telefone -> ts do último aviso de mídia (cooldown anti-spam de rajada)
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

async function handleMedia(telefone, nome, mediaType, replyJid) {
  // Anti-spam de rajada: cliente manda várias fotos seguidas → 1 aviso só, não 1 por foto
  // (caso 0544: 3 imagens = 3 respostas idênticas). Check+set SÍNCRONO antes de qualquer
  // await — eventos de mídia chegam concorrentes; assim só o 1º da rajada responde.
  const agora = Date.now();
  const ultimo = midiaUltimoAviso.get(telefone) || 0;
  if (agora - ultimo < MEDIA_COOLDOWN_MS) return; // dentro da janela → ignora (já avisou)
  midiaUltimoAviso.set(telefone, agora);
  if (midiaUltimoAviso.size > 2000) { const it = midiaUltimoAviso.keys(); for (let i = 0; i < 500; i++) midiaUltimoAviso.delete(it.next().value); }

  const conv = await loadConv(telefone);
  if (conv.status === 'humano') return;
  conv.nomePerfil = nome || conv.nomePerfil;
  // Imagem/vídeo: cliente quase sempre quer MOSTRAR ou VER o espaço → já aponta as fontes visuais.
  const querVer = mediaType === 'imagem' || mediaType === 'vídeo';
  const aviso = querVer
    ? 'Opa! Por aqui eu só leio texto, então não consigo abrir o que você mandou 🙈 — mas se a ideia é ver o espaço, dá uma olhada nos vídeos do nosso Instagram @javaripark e no mapa da casa com fotos em javaripark.com.br/regras. Qualquer coisa, me conta por escrito que eu ajudo! 😊'
    : 'Opa! Por aqui eu só consigo ler texto 🙈 (não enxergo áudio, foto, figurinha nem localização). Me conta por escrito que eu te ajudo rapidinho!';
  conv.messages.push({ role: 'user', content: `[cliente enviou ${mediaType}]` });
  conv.messages.push({ role: 'assistant', content: aviso });
  await saveConv(conv);
  if (replyJid) await sendToJid(replyJid, aviso); else await sendText(telefone, aviso);
}

// Núcleo: processa um texto final (já agrupado) de um cliente.
async function processar(telefone, nome, textoFinal, { recovery, ts, replyJid }) {
  if (await botPausado()) { console.log(`[${telefone}] BOT PAUSADO — não respondeu`); return; }
  const conv = await loadConv(telefone);
  conv.nomePerfil = nome || conv.nomePerfil;
  const responder = (txt) => replyJid ? sendToJid(replyJid, txt) : sendText(telefone, txt);

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
    await responder('Prontinho, tô de volta! 😉 Como posso ajudar?');
    return;
  }

  // Equipe assumiu (handoff) → registra e fica quieto
  if (conv.status === 'humano') {
    conv.messages.push({ role: 'user', content: textoFinal });
    conv.primeiroContato = conv.primeiroContato || new Date().toISOString();
    conv.ultimaMsgCliente = new Date().toISOString();
    conv.msgsCliente = (conv.msgsCliente || 0) + 1;
    // Cliente segue falando e ninguém da equipe respondeu → re-alerta o admin
    // (cooldown 15min pra não virar spam). Pedido do René 11/06.
    const PING_COOLDOWN_MS = 15 * 60 * 1000;
    const ultimoPing = conv.adminPingEm ? new Date(conv.adminPingEm).getTime() : 0;
    const devePingar = cfg.adminPhone && Date.now() - ultimoPing > PING_COOLDOWN_MS;
    if (devePingar) conv.adminPingEm = new Date().toISOString();
    await saveConv(conv);
    if (devePingar) {
      await sendText(cfg.adminPhone,
        `⏰ *Cliente AINDA esperando atendimento humano*\n👤 ${conv.nomePerfil || 'Cliente'} · wa.me/${telefone}\n💬 "${textoFinal.slice(0, 120)}"`);
    }
    return;
  }

  const agora = new Date().toISOString();
  conv.primeiroContato = conv.primeiroContato || agora;
  conv.ultimaMsgCliente = agora;
  conv.msgsCliente = (conv.msgsCliente || 0) + 1;

  // Lead de anúncio: marca a origem (persiste em Origem, alimenta o card do painel)
  // e injeta o tema do anúncio na abertura — o bot conecta o assunto (Copa, dia
  // dos namorados etc.) em vez de menu genérico.
  const ad = getAdReferral(telefone);
  if (ad) {
    conv.origem = 'anuncio';
    if (conv.messages.length < 4 && (ad.title || ad.body)) conv.adInfo = `${ad.title || ''}${ad.body ? ' — ' + ad.body : ''}`.slice(0, 300);
  }

  const { reply, usage, handoff, reservou, negociou } = await atender(conv, textoFinal);
  if (handoff) conv.adminPingEm = agora; // alerta inicial conta pro cooldown do re-ping
  if (reservou) { conv.etapa = 'ganho'; conv.reservouEm = agora; }
  else if (negociou && conv.etapa !== 'ganho') conv.etapa = 'negociacao';
  await saveConv(conv);
  await gravarUso(telefone, usage);

  let out = reply;
  if (recovery && out) out = 'Oi! Desculpa a demora pra te responder 🙏\n\n' + out;
  if (out) await responder(out);

  // Alerta de handoff pro admin (via Baileys — sem template, é não-oficial)
  if (handoff && cfg.adminPhone) {
    await sendText(cfg.adminPhone,
      `⚠️ *Bot pausado — cliente esperando atendimento*\n👤 ${conv.nomePerfil || 'Cliente'} · wa.me/${telefone}\n💬 Última mensagem: "${textoFinal.slice(0, 120)}"\n\n(Responda o cliente pelo app; o bot fica quieto até alguém mandar #bot ou passarem 24h.)`);
  }

  const cost = usage.reduce((s, u) => s + custoUSD(u), 0);
  console.log(`[${telefone}] ${recovery ? 'RECUP·' : ''}US$${cost.toFixed(5)} · "${textoFinal.slice(0, 50)}"${handoff ? ' · HANDOFF' : ''}`);
}

// Debounce de mensagens picadas ao vivo (a última "vence")
async function liveDebounce(telefone, nome, text, msgId, replyJid) {
  const lote = pendentes.get(telefone) || { texts: [], nome: '', replyJid };
  lote.texts.push(text);
  lote.last = msgId;
  lote.nome = nome || lote.nome;
  lote.replyJid = replyJid;
  pendentes.set(telefone, lote);
  await sleep(DEBOUNCE_MS);
  if (pendentes.get(telefone)?.last !== msgId) return; // chegou msg mais nova
  pendentes.delete(telefone);
  await processar(telefone, lote.nome, lote.texts.join('\n'), { recovery: false, replyJid: lote.replyJid });
}

// Recuperação: processa o backlog DEVAGAR, um cliente por vez, espaçado.
function bufferRecovery(telefone, nome, text, ts, replyJid) {
  const b = recoveryBuf.get(telefone) || { texts: [], nome: '', ts, replyJid };
  b.texts.push(text);
  b.nome = nome || b.nome;
  b.replyJid = replyJid;
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
      try { await processar(telefone, b.nome, b.texts.join('\n'), { recovery: true, ts: b.ts, replyJid: b.replyJid }); }
      catch (e) { console.error('[recovery]', telefone, e.message); }
      if (recoveryBuf.size) await sleep(RECOVERY_GAP_MS); // espaça → sem rajada
    }
  } finally { recoveryRunning = false; }
}

// Handler chamado pelo wa.js a cada mensagem recebida.
// type: 'notify' = nova/entregue agora · 'append' = sync de histórico antigo (ignorar)
// Humano respondeu o cliente pela nossa linha (digitou no app) → pausa o bot nessa
// conversa pra não atravessar (caso Thaís 14/06: Rodrigo assumiu e o bot continuou).
// Retomar = "Devolver pro bot" no painel ou o cliente manda #bot.
export async function handleHumanTakeover(m) {
  try {
    if (dedup(m.key?.id)) return;             // mesma msg não entra 2x no histórico
    const telefone = await resolvePhone(m);
    if (!telefone) return;
    if (telefone === cfg.adminPhone) return; // o próprio admin não é "cliente"
    const conv = await loadConv(telefone);
    // Registra a resposta do humano no histórico (marcador [atendente] → o painel
    // mostra "Humano respondeu"; o bot, ao retomar, vê o contexto do que foi dito).
    const { text, mediaType } = extractContent(m.message);
    const corpo = text || (mediaType ? `[atendente enviou ${mediaType}]` : '');
    if (corpo) conv.messages.push({ role: 'assistant', content: `[atendente] ${corpo}` });
    const jaPausado = conv.status === 'humano';
    conv.status = 'humano';
    conv.adminPingEm = new Date().toISOString(); // humano já está atendendo → não auto-pingar
    await saveConv(conv);
    if (!jaPausado) console.log(`[${telefone}] HUMANO assumiu (resposta pela linha) → bot pausado nesta conversa`);
    else console.log(`[${telefone}] humano respondeu (registrado no histórico)`);
  } catch (e) { console.error('[takeover]', e?.message); }
}

export async function handleIncoming(m, type) {
  try {
    if (type === 'append') return;                         // histórico antigo → não responde
    if (!m.message || m.key?.fromMe) return;
    const jid = m.key?.remoteJid || '';
    if (jid.endsWith('@g.us') || jid.includes('broadcast')) return; // grupo/status → ignora

    const telefone = await resolvePhone(m);                // resolve LID → telefone real
    if (!telefone) return;

    // Captura o marcador de anúncio (click-to-WhatsApp) com o telefone JÁ resolvido.
    // Antes era gravado em wa.js com o LID como chave → o contexto nunca casava.
    try {
      const ad = extractAdReferral(m.message);
      if (ad) {
        recordAdReferral(telefone, ad);
        console.log(`📣 Lead de anúncio: ${telefone} ← "${ad.title || ad.adId || 'ad'}"`);
      }
    } catch (e) { console.warn('[ad-referral]', e?.message); }

    // 🔒 TRAVA DE SEGURANÇA: em modo teste, o bot SÓ responde números autorizados.
    if (config.botMode !== 'live' && !config.testNumbers.includes(telefone)) {
      console.log(`[modo-teste] ignorado (fora da allowlist): ${telefone}`);
      return;
    }

    if (dedup(m.key.id)) return;

    const ts = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);
    const ageS = Math.floor(Date.now() / 1000) - ts;
    if (ageS > STALE_MAX_H * 3600) return;                 // velho demais → ignora

    const nome = m.pushName || '';
    const replyJid = jid;                                  // responde de volta no JID de origem (LID ou PN)
    const { text, mediaType } = extractContent(m.message);

    if (!text) { if (mediaType) await handleMedia(telefone, nome, mediaType, replyJid); return; }

    if (ageS > LIVE_AGE_S) { bufferRecovery(telefone, nome, text, ts, replyJid); runRecovery(); }
    else { liveDebounce(telefone, nome, text, m.key.id, replyJid); }
  } catch (e) {
    console.error('[agent] erro:', e.message);
  }
}
