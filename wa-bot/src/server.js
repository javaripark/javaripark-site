// Webhook da WhatsApp Cloud API + envio de respostas via Graph API.
import express from 'express';
import crypto from 'crypto';
import { cfg } from './config.js';
import { loadConv, saveConv } from './store.js';
import { atender, custoUSD } from './brain.js';

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Dedup: a Meta reenvia eventos; guarda os últimos ids processados
const seen = new Set();
function dedup(id) {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 2000) { const it = seen.values(); for (let i = 0; i < 500; i++) seen.delete(it.next().value); }
  return false;
}

function validSignature(req) {
  if (!cfg.metaAppSecret) return true; // simulação local sem secret
  const sig = req.get('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.metaAppSecret).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (e) { return false; }
}

async function sendText(to, body) {
  const r = await fetch(`https://graph.facebook.com/v23.0/${cfg.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.metaToken}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!r.ok) console.error('[send] erro', r.status, (await r.text()).slice(0, 200));
}

async function markRead(messageId) {
  await fetch(`https://graph.facebook.com/v23.0/${cfg.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.metaToken}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => {});
}

// Verificação do webhook (configuração no painel da Meta)
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.metaVerifyToken) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde já; a Meta tem timeout curto
  if (!validSignature(req)) { console.error('[webhook] assinatura inválida'); return; }
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const msg of value.messages || []) {
          if (dedup(msg.id)) continue;
          if (msg.type !== 'text') continue; // áudio/imagem: ignora por ora
          const telefone = msg.from;
          const texto = msg.text?.body?.trim();
          if (!texto) continue;

          const conv = await loadConv(telefone);
          conv.nomePerfil = value.contacts?.[0]?.profile?.name || conv.nomePerfil;
          // Origem automática: clique em anúncio (CTWA) chega com referral
          if (msg.referral) conv.origem = 'anuncio';

          if (conv.status === 'humano') {
            // equipe assumiu — registra a mensagem e fica quieto
            conv.messages.push({ role: 'user', content: texto });
            await saveConv(conv);
            continue;
          }

          markRead(msg.id);
          const t0 = Date.now();
          const { reply, usage } = await atender(conv, texto);
          await saveConv(conv);
          if (reply) await sendText(telefone, reply);
          const cost = usage.reduce((s, u) => s + custoUSD(u), 0);
          console.log(`[${telefone}] ${Date.now() - t0}ms · US$${cost.toFixed(5)} · "${texto.slice(0, 60)}"`);
        }
      }
    }
  } catch (e) {
    console.error('[webhook] erro:', e.message);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, model: cfg.model }));

app.listen(cfg.port, () => console.log(`javari-wa-bot na porta ${cfg.port} · modelo ${cfg.model}`));
