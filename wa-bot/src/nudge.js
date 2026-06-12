// Resgate de abandono: cliente que estava NEGOCIANDO reserva e sumiu recebe
// UMA cutucada gentil dentro da janela grátis de 24h da Meta.
// Regras: 3h–23h de silêncio · só entre 10h e 21h (SP) · máx 1 nudge por
// cliente a cada 7 dias · nudge entra no histórico (o bot sabe que cutucou).
import { listDocs } from './firestore.js';
import { loadConv, saveConv } from './store.js';

const MIN_IDLE_H = 3, MAX_IDLE_H = 23, HORA_INI = 10, HORA_FIM = 21, COOLDOWN_D = 7;

const TEXTOS = [
  nome => `Oi${nome ? ' ' + nome : ''}! 😊 Vi que a gente tava quase fechando sua reserva e ficou faltando pouquinho. Quer continuar? É rapidinho — me fala que eu já garanto sua mesa! 🙌`,
  nome => `Opa${nome ? ', ' + nome : ''}! 👋 Ficou no ar nossa reserva... ainda tá de pé? Se quiser, é só me responder que eu fecho pra você em segundos! ✨`,
  nome => `E aí${nome ? ', ' + nome : ''}! 🎉 Sua mesa quase saiu — quer que eu retome de onde paramos? Me diz que eu resolvo rapidinho!`,
];

export function horaSPAgora() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours();
}

// send: async (telefone, texto) => boolean — injetável pra teste
export async function rodarResgate({ send, agora = Date.now(), horaSP = horaSPAgora() } = {}) {
  const resultado = { avaliadas: 0, enviados: 0, pulados: [] };
  if (horaSP < HORA_INI || horaSP >= HORA_FIM) { resultado.pulados.push('fora do horário (' + horaSP + 'h)'); return resultado; }

  const convs = await listDocs('wa_atendimento');
  for (const c of convs) {
    resultado.avaliadas++;
    if ((c.Etapa || 'lead') !== 'negociacao') continue;
    if (c.status === 'humano') continue;
    if (!c.UltimaMsgCliente) continue;
    const idleH = (agora - new Date(c.UltimaMsgCliente).getTime()) / 3600e3;
    if (idleH < MIN_IDLE_H || idleH > MAX_IDLE_H) continue;
    if (c.NudgeEm) {
      const desdeNudgeD = (agora - new Date(c.NudgeEm).getTime()) / 86400e3;
      if (desdeNudgeD < COOLDOWN_D) continue;
      if (new Date(c.UltimaMsgCliente).getTime() <= new Date(c.NudgeEm).getTime()) continue; // não insiste sem resposta
    }

    // Desfecho "casa lotada → vem sem reserva" NÃO é abandono: cutucar com
    // "garanto sua mesa!" contradiz o que o bot acabou de dizer (bug 11/06).
    let ultimaBot = '';
    try {
      const ms = JSON.parse(c.HistoricoJson || '[]');
      for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'assistant') { ultimaBot = String(ms[i].content); break; }
    } catch (e) { /* histórico ilegível: segue avaliação normal */ }
    if (/sem reserva|fecharam|lotad/i.test(ultimaBot)) { resultado.pulados.push(c.id + ': desfecho lotado/walk-in'); continue; }

    const texto = TEXTOS[resultado.enviados % TEXTOS.length]((c.NomePerfil || '').split(' ')[0]);
    const ok = await send(c.id, texto);
    if (!ok) { resultado.pulados.push(c.id + ': envio falhou'); continue; }

    const conv = await loadConv(c.id);
    conv.messages.push({ role: 'assistant', content: texto + ' [resgate automático de abandono]' });
    conv.nudgeEm = new Date(agora).toISOString();
    await saveConv(conv);
    resultado.enviados++;
    console.log(`[resgate] nudge → ${c.id} (parado há ${idleH.toFixed(1)}h)`);
  }
  return resultado;
}
