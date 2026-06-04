import dotenv from 'dotenv';
dotenv.config();

function num(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

export const config = {
  port: num('PORT', 3100),
  authToken: process.env.AUTH_TOKEN || '',
  dailyCap: num('DAILY_CAP', 40),
  minDelaySec: num('MIN_DELAY_SEC', 45),
  maxDelaySec: num('MAX_DELAY_SEC', 120),
  windowStart: num('SEND_WINDOW_START', 11),
  windowEnd: num('SEND_WINDOW_END', 21),
  warmupDays: num('WARMUP_DAYS', 7),
  optoutKeywords: (process.env.OPTOUT_KEYWORDS || 'PARAR,SAIR,CANCELAR,REMOVER,STOP')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
};

if (!config.authToken || config.authToken.startsWith('troque-isto')) {
  console.warn('⚠  AUTH_TOKEN não configurado no .env — o serviço está SEM proteção. Configure antes de expor publicamente.');
}
