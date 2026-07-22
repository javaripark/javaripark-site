import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
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
// PREÇO POR MODELO (US$ por 1M tokens: input / output / cacheWrite(5min=1.25x) / cacheRead(0.1x)).
// ⚠ Sonnet 5 está em preço INTRODUTÓRIO US$2/US$10 até 31/08/2026 — DEPOIS volta a US$3/US$15
//   (atualizar a linha 'claude-sonnet-5' pra 3/15/3.75/0.30 após essa data).
export const PRICING_BY_MODEL = {
  'claude-sonnet-5':            { input: 2.0, output: 10.0, cacheWrite: 2.50, cacheRead: 0.20 },
  'claude-sonnet-4-6':          { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5-20251001':  { input: 1.0, output: 5.0,  cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-haiku-4-5':           { input: 1.0, output: 5.0,  cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-opus-4-8':            { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.50 },
};
const FALLBACK_PRICING = { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 };
// Preço do modelo em uso (pro cálculo dos turnos novos) + lookup por modelo (pro recálculo histórico).
export const PRICING = PRICING_BY_MODEL[MODEL] || FALLBACK_PRICING;
export const pricingFor = (model) => PRICING_BY_MODEL[model] || FALLBACK_PRICING;
