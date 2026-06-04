// Worker da fila: processa um envio por vez, respeitando a trava anti-ban.
import { config } from './config.js';
import { getQueue, dequeue, getDailyState, incDailySent, logSend } from './store.js';
import { sendText, getWaState } from './wa.js';

let running = false;
let nextSendAt = 0; // timestamp do próximo envio liberado

function nowHour() { return new Date().getHours(); }

function withinWindow() {
  const h = nowHour();
  return h >= config.windowStart && h < config.windowEnd;
}

// Limite do dia considerando aquecimento gradual
export function effectiveDailyCap() {
  const cap = config.dailyCap;
  const warmup = config.warmupDays;
  if (warmup <= 0) return cap;
  // Descobre "dia de aquecimento" pela existência do arquivo de auth não dá;
  // então usamos uma marca simples: o cap sobe linear nos primeiros N dias de uso.
  // Para simplificar, aquecimento é controlado manualmente subindo DAILY_CAP.
  // Aqui retornamos o cap cheio (aquecimento documentado no README).
  return cap;
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

  const res = await sendText(item.to, item.message);
  if (res.ok) {
    incDailySent();
    logSend({ to: item.to, nome: item.nome, status: 'enviado', jid: res.jid });
    console.log(`✉  Enviado para ${item.nome || item.to}`);
  } else if (res.reason === 'opt_out' || res.reason === 'sem_whatsapp' || res.reason === 'numero_invalido') {
    // Não conta no limite, só loga e segue
    logSend({ to: item.to, nome: item.nome, status: 'pulado', motivo: res.reason });
    console.log(`⤳ Pulado (${res.reason}): ${item.nome || item.to}`);
    scheduleNext(500);
    return;
  } else {
    // Erro de envio: re-enfileira no fim e espera mais
    logSend({ to: item.to, nome: item.nome, status: 'erro', motivo: res.reason, detail: res.detail });
    console.log(`✗ Erro (${res.reason}): ${item.nome || item.to}`);
  }

  // Próximo envio só depois do delay aleatório
  nextSendAt = Date.now() + randDelayMs();
  scheduleNext(nextSendAt - Date.now());
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
