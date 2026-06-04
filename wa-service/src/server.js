// API REST do serviço de WhatsApp.
import express from 'express';
import { config } from './config.js';
import { startWA, getWaState, getQrDataUrl } from './wa.js';
import { startQueue, queueStatus } from './queue.js';
import { enqueue, readLog, addOptOut, getOptOuts } from './store.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS — permite o dashboard (HTTPS) chamar o serviço
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-send-pin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Allowlist de origem (defesa extra; só bloqueia navegador de origem não-listada)
app.use((req, res, next) => {
  if (config.allowedOrigins.length === 0) return next();
  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'origem_nao_permitida' });
  }
  next();
});

// Health check — sem auth
app.get('/health', (req, res) => res.json({ ok: true, ...getWaState() }));

// Auth middleware (Bearer token) para o resto
app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!config.authToken || token !== config.authToken) {
    return res.status(401).json({ error: 'nao_autorizado' });
  }
  next();
});

// Status geral: conexão + fila
app.get('/status', (req, res) => {
  res.json({ wa: getWaState(), fila: queueStatus() });
});

// QR de pareamento (PNG data URL) — escaneie pra conectar/trocar o número
app.get('/qr', (req, res) => {
  const qr = getQrDataUrl();
  if (!qr) return res.json({ qr: null, message: getWaState().connected ? 'já conectado' : 'aguardando geração do QR' });
  res.json({ qr });
});

// Enfileira mensagens: { messages: [{ to, message, nome }] }
// Exige o PIN de envio (se configurado) — protege o disparo mesmo com token vazado.
app.post('/enqueue', (req, res) => {
  if (config.sendPin && req.headers['x-send-pin'] !== config.sendPin) {
    return res.status(401).json({ error: 'pin_invalido' });
  }
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (messages.length === 0) return res.status(400).json({ error: 'sem_mensagens' });
  const added = enqueue(messages);
  res.json({ ok: true, enfileiradas: added, fila: queueStatus() });
});

// Exige o PIN (além do token) nas rotas com dados sensíveis / mutações.
function requirePin(req, res, next) {
  if (config.sendPin && req.headers['x-send-pin'] !== config.sendPin) {
    return res.status(401).json({ error: 'pin_invalido' });
  }
  next();
}

// Log de envios (contém nomes/telefones — protegido por PIN)
app.get('/log', requirePin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  res.json({ log: readLog(limit) });
});

// Opt-out manual (mutação — protegido por PIN)
app.post('/optout', requirePin, (req, res) => {
  const num = String(req.body?.number || '').replace(/\D/g, '');
  if (!num) return res.status(400).json({ error: 'numero_invalido' });
  const added = addOptOut(num);
  res.json({ ok: true, added, total: getOptOuts().length });
});

async function main() {
  await startWA();
  startQueue();
  app.listen(config.port, () => {
    console.log(`🚀 Serviço WhatsApp rodando na porta ${config.port}`);
    console.log(`   Health: http://localhost:${config.port}/health`);
  });
}
main().catch(e => { console.error('Falha ao iniciar:', e); process.exit(1); });
