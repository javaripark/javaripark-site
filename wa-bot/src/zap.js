// Envio via Graph API — compartilhado entre o webhook (app.js) e o resgate (nudge.js)
import { cfg } from './config.js';

export async function sendText(to, body) {
  const r = await fetch(`https://graph.facebook.com/v23.0/${cfg.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.metaToken}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!r.ok) console.error('[send] erro', r.status, (await r.text()).slice(0, 200));
  return r.ok;
}

export async function markRead(messageId) {
  await fetch(`https://graph.facebook.com/v23.0/${cfg.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.metaToken}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => {});
}
