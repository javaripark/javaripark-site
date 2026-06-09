import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

export const cfg = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
  metaToken: process.env.META_TOKEN || '',
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaVerifyToken: process.env.META_VERIFY_TOKEN || 'javari-webhook-2026',
  port: parseInt(process.env.PORT || '3200', 10),
  usdBrl: parseFloat(process.env.USD_BRL || '5.50'),
  fsBase: 'https://firestore.googleapis.com/v1/projects/central-de-reservas-jsp/databases/(default)/documents',
  fsDataPath: 'artifacts/central-de-reservas-jsp/public/data',
};

// Preço por MTok (USD) — Haiku 4.5. Ajustar se trocar de modelo.
export const PRICING = {
  input: 1.0,
  output: 5.0,
  cacheWrite: 1.25,
  cacheRead: 0.10,
};
