// Modo local/pm2: responde 200 imediato e processa em background.
import { cfg } from './config.js';
import { createApp } from './app.js';

createApp({ awaitProcessing: false })
  .listen(cfg.port, () => console.log(`javari-wa-bot na porta ${cfg.port} · modelo ${cfg.model}`));
