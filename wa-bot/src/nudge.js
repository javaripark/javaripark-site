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
// O bot estava ATIVAMENTE coletando um dado de reserva (nome/data/pessoas) e o
// cliente sumiu → abandono real. Genérico "quer fazer uma reserva?" NÃO conta.
const COLETANDO_RE = /(nome completo|qual.{0,15}\bnome\b|quantas pessoas|quantos? (adultos|v[ãa]o)|qual.{0,10}(o dia|a data)|que dia (voc|v[ãa]o|seria|querem)|me (passa|diz|fala|manda).{0,30}(nome|sobrenome|data|dia|quantas)|sobrenome|s[óo] (falta|preciso).{0,20}(nome|data|dia|pessoas)|fechamos)/i;
const norm9 = s => String(s || '').replace(/\D/g, '').slice(-9);

export async function rodarResgate({ send, agora = Date.now(), horaSP = horaSPAgora() } = {}) {
  const resultado = { avaliadas: 0, enviados: 0, pulados: [] };
  if (horaSP < HORA_INI || horaSP >= HORA_FIM) { resultado.pulados.push('fora do horário (' + horaSP + 'h)'); return resultado; }

  const convs = await listDocs('wa_atendimento');
  // Quem TEM reserva (qualquer data, ViaBot ou não) NUNCA é "abandono" — não cutuca.
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).toISOString().slice(0, 10);
  let comReserva = new Set();
  try {
    const reservas = await listDocs('reservas', 2000);
    comReserva = new Set(reservas.filter(r => (r.Data || '') >= hoje).map(r => norm9(r.Whatsapp)));
  } catch (e) { /* sem reservas: segue (o filtro de conteúdo ainda protege) */ }

  for (const c of convs) {
    resultado.avaliadas++;
    if ((c.Etapa || 'lead') !== 'negociacao') continue;
    if (c.status === 'humano') continue;
    if (!c.UltimaMsgCliente) continue;
    if (comReserva.has(norm9(c.id))) { resultado.pulados.push(c.id + ': já tem reserva'); continue; }
    const idleH = (agora - new Date(c.UltimaMsgCliente).getTime()) / 3600e3;
    if (idleH < MIN_IDLE_H || idleH > MAX_IDLE_H) continue;
    if (c.NudgeEm) {
      const desdeNudgeD = (agora - new Date(c.NudgeEm).getTime()) / 86400e3;
      if (desdeNudgeD < COOLDOWN_D) continue;
      if (new Date(c.UltimaMsgCliente).getTime() <= new Date(c.NudgeEm).getTime()) continue; // não insiste sem resposta
    }

    let ultimaBot = '';
    try {
      const ms = JSON.parse(c.HistoricoJson || '[]');
      for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'assistant') { ultimaBot = String(ms[i].content); break; }
    } catch (e) { /* histórico ilegível: segue avaliação normal */ }
    // Desfecho "casa lotada → vem sem reserva"/cancelamento NÃO é abandono.
    if (/sem reserva|fecharam|lotad|cancel/i.test(ultimaBot)) { resultado.pulados.push(c.id + ': desfecho lotado/walk-in/cancel'); continue; }
    // Só cutuca se o bot estava REALMENTE no meio de coletar a reserva (não FAQ, não confirmação).
    if (!COLETANDO_RE.test(ultimaBot)) { resultado.pulados.push(c.id + ': não estava coletando reserva (FAQ/encerrado)'); continue; }

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
