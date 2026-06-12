// Gerenciador da sessão WhatsApp via Baileys.
// O número emissor é definido por QUEM ESCANEIA O QR — por isso é "configurável".
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import qrcode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { isOptedOut, addOptOut } from './store.js';

// Extrai o marcador de anúncio (click-to-WhatsApp) de uma mensagem recebida.
// O Baileys expõe isso em contextInfo.externalAdReply de algum subtipo de mensagem.
// Varre todos os subtipos defensivamente — retorna null se não houver.
// A GRAVAÇÃO acontece no agent.js (handleIncoming), com o telefone JÁ resolvido —
// gravar aqui usava o LID como chave e o contexto nunca casava.
export function extractAdReferral(message) {
  if (!message || typeof message !== 'object') return null;
  for (const key of Object.keys(message)) {
    const sub = message[key];
    const ctx = sub && typeof sub === 'object' ? sub.contextInfo : null;
    const ext = ctx && ctx.externalAdReply;
    if (ext && (ext.sourceId || ext.sourceUrl || ext.title || ext.ctwaClid)) {
      return {
        adId: ext.sourceId || '',
        title: ext.title || '',
        body: ext.body || '',
        sourceUrl: ext.sourceUrl || '',
        sourceType: ext.sourceType || '',
        ctwaClid: ext.ctwaClid || ctx.ctwaClid || '',
        mediaType: ext.mediaType || '',
      };
    }
  }
  return null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', 'auth');

const logger = pino({ level: 'silent' });

let sock = null;
let state = {
  connected: false,
  qrDataUrl: null,   // QR atual (data URL) enquanto não pareado
  me: null,          // número conectado
};

// Handler do bot reativo (registrado pelo server.js). Recebe (mensagem, type).
let onMessage = null;
export function setMessageHandler(fn) { onMessage = fn; }

// Cache de mensagens enviadas (id -> conteúdo). Necessário pro getMessage:
// quando o WhatsApp do destinatário pede reenvio (falha de descriptografia),
// o Baileys precisa devolver o conteúdo original — senão fica "Aguardando esta mensagem".
const sentMessages = new Map();
const SENT_CACHE_MAX = 1000;
function cacheSent(id, message) {
  if (!id || !message) return;
  sentMessages.set(id, message);
  if (sentMessages.size > SENT_CACHE_MAX) {
    const firstKey = sentMessages.keys().next().value;
    sentMessages.delete(firstKey);
  }
}

export function getWaState() {
  return { connected: state.connected, hasQr: !!state.qrDataUrl, me: state.me };
}
export function getQrDataUrl() { return state.qrDataUrl; }

// Normaliza telefone BR → JID do WhatsApp
export function toJid(raw) {
  let d = String(raw).replace(/\D/g, '');
  // Remove +55/55 duplicado e re-adiciona
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return null;
  return { digits: '55' + d, jid: '55' + d + '@s.whatsapp.net' };
}

let connecting = false; // evita startWA() concorrentes empilhando sockets

// Opt-out só dispara se a mensagem FOR a palavra-chave (ou começar com ela),
// não se a palavra aparecer no meio de uma frase ("não vou PARAR de elogiar").
function isOptOutMessage(text) {
  const t = text.trim().toUpperCase();
  // Casa se a mensagem É a palavra-chave, ou COMEÇA com ela seguida de
  // qualquer caractere que não seja letra (espaço, vírgula, ponto, etc).
  // Não casa "PARARAM" nem "PARAR" no meio de uma frase.
  return config.optoutKeywords.some(k => {
    if (t === k) return true;
    if (!t.startsWith(k)) return false;
    const next = t.charAt(k.length);
    return !/[A-ZÀ-Ú]/.test(next); // próximo char não é letra
  });
}

export async function startWA() {
  if (connecting) { console.log('… startWA já em andamento, ignorando chamada duplicada.'); return sock; }
  connecting = true;

  // Limpa socket anterior antes de criar um novo (evita listeners/sockets empilhados)
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end?.(); } catch {}
    sock = null;
  }

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: authState,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      // Responde a pedidos de reenvio do destinatário (corrige "Aguardando esta mensagem")
      getMessage: async (key) => {
        const msg = sentMessages.get(key.id);
        return msg || undefined;
      },
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        state.qrDataUrl = await qrcode.toDataURL(qr);
        console.log('📱 QR gerado. Acesse GET /qr ou escaneie no terminal abaixo:');
        try { console.log(await qrcode.toString(qr, { type: 'terminal', small: true })); } catch {}
      }
      if (connection === 'open') {
        state.connected = true;
        state.qrDataUrl = null;
        state.me = sock.user?.id?.split(':')[0] || null;
        console.log(`✅ Conectado como ${state.me}`);
      }
      if (connection === 'close') {
        state.connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log(`⚠  Conexão fechada (code ${code}).${loggedOut ? ' Deslogado — precisa re-parear.' : ' Reconectando...'}`);
        if (!loggedOut) setTimeout(() => startWA().catch(e => console.error('Erro reconnect:', e)), 3000);
      }
    });

    // Mensagens recebidas: opt-out + captura de anúncio + bot reativo
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const num = (m.key.remoteJid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
        const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
        if (isOptOutMessage(text)) {
          if (num && addOptOut(num)) console.log(`🚫 Opt-out automático: ${num}`);
          continue; // quem pediu pra parar não aciona o bot
        }
        // Bot reativo (assíncrono; nunca pode derrubar o handler).
        // A captura de anúncio acontece lá dentro (handleIncoming), com telefone resolvido.
        if (onMessage) Promise.resolve(onMessage(m, type)).catch(e => console.error('[onMessage]', e?.message));
      }
    });

    return sock;
  } finally {
    connecting = false;
  }
}

// Resolve o telefone REAL (PN) de uma mensagem, lidando com o LID do WhatsApp.
// Ordem: remoteJidAlt (PN que vem junto) → getPNForLID (mapeamento) → fallback LID.
export async function resolvePhone(m) {
  const jid = m?.key?.remoteJid || '';
  const alt = m?.key?.remoteJidAlt || '';
  const digits = j => String(j).replace(/@.*/, '').replace(/\D/g, '');
  if (jid.endsWith('@s.whatsapp.net')) return digits(jid);
  if (alt.endsWith('@s.whatsapp.net')) return digits(alt);
  if (jid.endsWith('@lid')) {
    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (pn) return digits(pn);
    } catch (e) { console.warn('[lid] getPNForLID falhou:', e?.message); }
    // fallback: usa o próprio LID como chave (o bot ainda responde; reserva pode não casar telefone)
    console.warn('[lid] PN não resolvido, usando LID como chave:', jid);
    return 'lid' + digits(jid);
  }
  return null;
}

// Envia direto pra um JID já conhecido (LID ou PN) — usado pelas RESPOSTAS reativas,
// que devem voltar exatamente de onde a mensagem veio.
export async function sendToJid(jid, message) {
  if (!sock || !state.connected) return { ok: false, reason: 'desconectado' };
  if (!jid) return { ok: false, reason: 'jid_vazio' };
  try {
    const sent = await sock.sendMessage(jid, { text: message });
    if (sent?.key?.id) cacheSent(sent.key.id, sent.message);
    return { ok: true, jid };
  } catch (e) {
    return { ok: false, reason: 'erro_envio', detail: String(e?.message || e) };
  }
}

// Envia uma mensagem de texto. Retorna {ok, reason}
export async function sendText(rawNumber, message) {
  if (!sock || !state.connected) return { ok: false, reason: 'desconectado' };
  const norm = toJid(rawNumber);
  if (!norm) return { ok: false, reason: 'numero_invalido' };
  if (isOptedOut(norm.digits.replace(/^55/, '')) || isOptedOut(norm.digits)) {
    return { ok: false, reason: 'opt_out' };
  }
  // Confirma que o número existe no WhatsApp (evita enviar pra inexistente)
  try {
    const [check] = await sock.onWhatsApp(norm.digits);
    if (!check?.exists) return { ok: false, reason: 'sem_whatsapp' };
    const sent = await sock.sendMessage(check.jid, { text: message });
    // Guarda no cache pro getMessage poder reenviar se o destinatário pedir
    if (sent?.key?.id) cacheSent(sent.key.id, sent.message);
    return { ok: true, jid: check.jid };
  } catch (e) {
    return { ok: false, reason: 'erro_envio', detail: String(e?.message || e) };
  }
}
