// Worker da fila: processa um envio por vez, respeitando a trava anti-ban.
import { config } from './config.js';
import { getQueue, dequeue, requeue, getDailyState, incDailySent, logSend, daysSinceStart } from './store.js';
import { sendText, getWaState } from './wa.js';
import { loadConv, saveConv } from '../../wa-bot/src/store.js';

const MAX_RETRIES = 3; // tentativas por mensagem antes de desistir

// Marca na conversa que a equipe enviou uma reconfirmação — assim o bot reativo
// entende a resposta do cliente (confirmar / mudar nº de pessoas / cancelar).
async function marcarReconfirmacao(jid) {
  try {
    const tel = String(jid || '').replace(/@.*/, '').replace(/\D/g, '');
    if (!tel) return;
    const conv = await loadConv(tel);
    conv.reconfirmou = new Date().toISOString();
    await saveConv(conv);
  } catch (e) { console.error('[reconfirm-flag]', e?.message); }
}

let running = false;
let nextSendAt = 0; // timestamp do próximo envio liberado

function nowHour() { return new Date().getHours(); }

function withinWindow() {
  const h = nowHour();
  return h >= config.windowStart && h < config.windowEnd;
}

// Limite do dia com aquecimento gradual REAL:
// dia 1 = ~25% do cap, sobe linear até 100% no dia WARMUP_DAYS.
export function effectiveDailyCap() {
  const cap = config.dailyCap;
  const warmup = config.warmupDays;
  if (warmup <= 1) return cap;
  const day = daysSinceStart();              // 1, 2, 3...
  if (day >= warmup) return cap;
  const factor = Math.max(0.25, day / warmup);
  return Math.max(1, Math.round(cap * factor));
}

function randDelayMs() {
  const min = config.minDelaySec, max = config.maxDelaySec;
  return (min + Math.random() * (max - min)) * 1000;
}

export function queueStatus() {
  const daily = getDailyState();
  return {
    pendentes: getQueue().length,
    enviadosHoje: daily.sent,
    limiteDia: effectiveDailyCap(),
    restanteHoje: Math.max(0, effectiveDailyCap() - daily.sent),
    dentroDaJanela: withinWindow(),
    janela: `${config.windowStart}h-${config.windowEnd}h`,
    proximoEnvioEm: nextSendAt > Date.now() ? Math.ceil((nextSendAt - Date.now()) / 1000) : 0,
  };
}

async function tick() {
  if (!running) return;
  // try/catch garante que NENHUM erro mate o loop permanentemente.
  try {
    const q = getQueue();
    if (q.length === 0) { scheduleNext(5000); return; }

    if (!getWaState().connected) { scheduleNext(5000); return; }
    if (!withinWindow()) { scheduleNext(60000); return; } // fora do horário: checa de novo em 1min

    const daily = getDailyState();
    if (daily.sent >= effectiveDailyCap()) { scheduleNext(60000); return; } // bateu o limite: espera virar o dia

    if (Date.now() < nextSendAt) { scheduleNext(nextSendAt - Date.now()); return; }

    // Envia o próximo
    const item = dequeue();
    if (!item) { scheduleNext(2000); return; }

    // 🔒 TRAVA: em modo teste, envio ATIVO (reconfirmação/campanha) só vai pros números
    // autorizados — protege clientes reais durante os testes. Compara os últimos 8 dígitos.
    const toDigits = String(item.to).replace(/\D/g, '');
    if (config.botMode !== 'live' && !config.testNumbers.some(t => t.slice(-8) === toDigits.slice(-8))) {
      logSend({ to: item.to, nome: item.nome, status: 'pulado', motivo: 'modo_teste' });
      console.log(`[modo-teste] envio ativo pulado (fora da allowlist): ${item.to}`);
      scheduleNext(500);
      return;
    }

    const res = await sendText(item.to, item.message);
    if (res.ok) {
      incDailySent();
      logSend({ to: item.to, nome: item.nome, status: 'enviado', jid: res.jid });
      console.log(`✉  Enviado para ${item.nome || item.to}`);
      if (item.reconfirm) await marcarReconfirmacao(res.jid); // bot saberá tratar a resposta
    } else if (res.reason === 'opt_out' || res.reason === 'sem_whatsapp' || res.reason === 'numero_invalido') {
      // Destinatário inválido/bloqueado: não conta no limite, descarta e segue rápido
      logSend({ to: item.to, nome: item.nome, status: 'pulado', motivo: res.reason });
      console.log(`⤳ Pulado (${res.reason}): ${item.nome || item.to}`);
      scheduleNext(500);
      return;
    } else {
      // Erro transitório (desconexão, falha de rede): re-enfileira no FIM até MAX_RETRIES
      const retries = item.retries || 0;
      if (retries < MAX_RETRIES) {
        requeue(item);
        logSend({ to: item.to, nome: item.nome, status: 'retry', tentativa: retries + 1, motivo: res.reason });
        console.log(`↻ Retry ${retries + 1}/${MAX_RETRIES} (${res.reason}): ${item.nome || item.to}`);
      } else {
        logSend({ to: item.to, nome: item.nome, status: 'falhou', motivo: res.reason, detail: res.detail });
        console.log(`✗ Desistiu após ${MAX_RETRIES} tentativas: ${item.nome || item.to}`);
      }
    }

    // Próximo envio só depois do delay aleatório
    nextSendAt = Date.now() + randDelayMs();
    scheduleNext(nextSendAt - Date.now());
  } catch (e) {
    console.error('Erro no tick da fila (loop continua):', e?.message || e);
    scheduleNext(5000);
  }
}

let timer = null;
function scheduleNext(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, Math.max(500, ms));
}

export function startQueue() {
  if (running) return;
  running = true;
  console.log('▶  Fila iniciada.');
  scheduleNext(2000);
}
export function stopQueue() { running = false; clearTimeout(timer); }
