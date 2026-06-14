import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
export const cfg = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  model: MODEL,
  // effort só nos modelos que suportam (Sonnet/Opus/Fable); Haiku 4.5 dá 400 com effort.
  // 'low' + thinking desligado = respostas rápidas e baratas (sem tokens de raciocínio).
  // Fixo por modelo de propósito (NÃO lê env: o daemon do pm2 pode ter CLAUDE_EFFORT poluído).
  effort: /sonnet|opus|fable/i.test(MODEL) ? 'low' : '',
  metaToken: process.env.META_TOKEN || '',
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaVerifyToken: process.env.META_VERIFY_TOKEN || 'javari-webhook-2026',
  adminPhone: (process.env.ADMIN_PHONE || '').replace(/\D/g, ''),
  port: parseInt(process.env.PORT || '3200', 10),
  usdBrl: parseFloat(process.env.USD_BRL || '5.50'),
  fsBase: 'https://firestore.googleapis.com/v1/projects/central-de-reservas-jsp/databases/(default)/documents',
  fsDataPath: 'artifacts/central-de-reservas-jsp/public/data',
};

// Preço por MTok (USD) — Sonnet 4.6. Trocou de modelo? Ajuste aqui.
// Haiku 4.5: 1.0/5.0/1.25/0.10 · Sonnet 4.6: 3.0/15.0/3.75/0.30 · Opus 4.7-4.8: 5.0/25.0/6.25/0.50
export const PRICING = {
  input: 3.0,
  output: 15.0,
  cacheWrite: 3.75,
  cacheRead: 0.30,
};
