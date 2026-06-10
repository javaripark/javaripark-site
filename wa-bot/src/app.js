// App Express do webhook — usado pelo server.js (local/pm2) e pelo index.js
// (Firebase Functions). Na nuvem, awaitProcessing=true: processa ANTES de
// responder (Functions congela a instância após o response).
import express from 'express';
import crypto from 'crypto';
import { cfg } from './config.js';
import { loadConv, saveConv } from './store.js';
import { atender, custoUSD } from './brain.js';

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

async function processEvents(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const msg of value.messages || []) {
        if (dedup(msg.id)) continue;
        const telefone = msg.from;
        // mídia (áudio é MUITO comum no Brasil): nunca deixar no vácuo
        if (msg.type !== 'text') {
          if (['audio', 'image', 'video', 'document'].includes(msg.type)) {
            const conv = await loadConv(telefone);
            if (conv.status !== 'humano') {
              const aviso = 'Opa! Por aqui eu ainda não consigo abrir áudio e arquivos 🙈 Me conta por texto que eu te ajudo rapidinho!';
              conv.messages.push({ role: 'user', content: `[cliente enviou ${msg.type}]` });
              conv.messages.push({ role: 'assistant', content: aviso });
              await saveConv(conv);
              await sendText(telefone, aviso);
            }
          }
          continue;
        }
        const texto = msg.text?.body?.trim();
        if (!texto) continue;

        const conv = await loadConv(telefone);
        conv.nomePerfil = value.contacts?.[0]?.profile?.name || conv.nomePerfil;
        // Origem automática: clique em anúncio (CTWA) chega com referral
        if (msg.referral) conv.origem = 'anuncio';

        // Válvula de escape: "#bot" religa o atendente após handoff
        if (texto.toLowerCase() === '#bot') {
          conv.status = 'bot';
          await saveConv(conv);
          await sendText(telefone, 'Prontinho, tô de volta! 😉 Como posso ajudar?');
          continue;
        }

        if (conv.status === 'humano') {
          // equipe assumiu — registra a mensagem e fica quieto
          conv.messages.push({ role: 'user', content: texto });
          await saveConv(conv);
          continue;
        }

        markRead(msg.id);
        const t0 = Date.now();
        const { reply, usage, handoff } = await atender(conv, texto);
        await saveConv(conv);
        if (reply) await sendText(telefone, reply);
        // Alerta ativo de handoff no WhatsApp do admin
        if (handoff && cfg.adminPhone) {
          await sendText(cfg.adminPhone,
            `⚠️ *Bot pausado — cliente esperando atendimento*\n👤 ${conv.nomePerfil || 'Cliente'} · wa.me/${telefone}\n💬 Última mensagem: "${texto.slice(0, 120)}"\n\n(Responda o cliente pelo app; o bot fica quieto até alguém mandar #bot ou passarem 24h.)`);
        }
        const cost = usage.reduce((s, u) => s + custoUSD(u), 0);
        console.log(`[${telefone}] ${Date.now() - t0}ms · US$${cost.toFixed(5)} · "${texto.slice(0, 60)}"${handoff ? ' · HANDOFF→admin avisado' : ''}`);
      }
    }
  }
}

export function createApp({ awaitProcessing = false } = {}) {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // Verificação do webhook (configuração no painel da Meta)
  app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.metaVerifyToken) {
      return res.send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  app.post('/webhook', async (req, res) => {
    if (!validSignature(req)) { console.error('[webhook] assinatura inválida'); return res.sendStatus(200); }
    if (awaitProcessing) {
      try { await processEvents(req.body); } catch (e) { console.error('[webhook] erro:', e.message); }
      return res.sendStatus(200);
    }
    res.sendStatus(200); // local: responde já e processa em background
    processEvents(req.body).catch(e => console.error('[webhook] erro:', e.message));
  });

  app.get('/health', (_req, res) => res.json({ ok: true, model: cfg.model }));
  return app;
}
