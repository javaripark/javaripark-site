// Entrada do Firebase Functions (v2). Webhook em:
// https://us-central1-central-de-reservas-jsp.cloudfunctions.net/wabot/webhook
import { onRequest } from 'firebase-functions/v2/https';
import { createApp } from './src/app.js';

const app = createApp({ awaitProcessing: true });

export const wabot = onRequest(
  { region: 'us-central1', maxInstances: 1, timeoutSeconds: 120, memory: '256MiB' },
  app,
);
