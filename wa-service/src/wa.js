// Gerenciador da sessão WhatsApp via Baileys.
// O número emissor é definido por QUEM ESCANEIA O QR — por isso é "configurável".
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import qrcode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { isOptedOut, addOptOut } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', 'auth');

const logger = pino({ level: 'silent' });

let sock = null;
let state = {
  connected: false,
  qrDataUrl: null,   // QR atual (data URL) enquanto não pareado
  me: null,          // número conectado
};

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

export async function startWA() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      state.qrDataUrl = await qrcode.toDataURL(qr);
      console.log('📱 QR gerado. Acesse GET /qr ou escaneie no terminal abaixo:');
      // Também imprime no terminal pra teste local
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

  // Opt-out automático: cliente respondeu PARAR/SAIR/etc
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim().toUpperCase();
      if (config.optoutKeywords.some(k => text === k || text.includes(k))) {
        const num = (m.key.remoteJid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
        if (num && addOptOut(num)) console.log(`🚫 Opt-out automático: ${num}`);
      }
    }
  });

  return sock;
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
    await sock.sendMessage(check.jid, { text: message });
    return { ok: true, jid: check.jid };
  } catch (e) {
    return { ok: false, reason: 'erro_envio', detail: String(e?.message || e) };
  }
}
