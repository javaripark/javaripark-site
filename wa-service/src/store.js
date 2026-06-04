// Persistência simples em arquivos JSON (sobrevive a reinício da máquina).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const OPTOUT_FILE = path.join(DATA_DIR, 'optout.json');
const LOG_FILE = path.join(DATA_DIR, 'sent-log.jsonl');

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function todayStr() {
  // Data local (a máquina deve estar no fuso BRT)
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Contador diário ──
export function getDailyState() {
  const s = readJson(STATE_FILE, { date: '', sent: 0 });
  if (s.date !== todayStr()) {
    // Vira o dia: zera contador
    const fresh = { date: todayStr(), sent: 0 };
    writeJson(STATE_FILE, fresh);
    return fresh;
  }
  return s;
}
export function incDailySent() {
  const s = getDailyState();
  s.sent += 1;
  writeJson(STATE_FILE, s);
  return s.sent;
}

// ── Fila ──
export function getQueue() { return readJson(QUEUE_FILE, []); }
export function setQueue(q) { writeJson(QUEUE_FILE, q); }
export function enqueue(items) {
  const q = getQueue();
  let added = 0;
  for (const it of items) {
    if (!it || !it.to || !it.message) continue;
    q.push({
      id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      to: String(it.to),
      message: String(it.message),
      nome: it.nome || '',
      addedAt: new Date().toISOString(),
    });
    added++;
  }
  setQueue(q);
  return added;
}
export function dequeue() {
  const q = getQueue();
  const item = q.shift();
  setQueue(q);
  return item || null;
}

// ── Opt-out ──
export function getOptOuts() { return readJson(OPTOUT_FILE, []); }
export function isOptedOut(numDigits) {
  return getOptOuts().includes(numDigits);
}
export function addOptOut(numDigits) {
  const list = getOptOuts();
  if (!list.includes(numDigits)) {
    list.push(numDigits);
    writeJson(OPTOUT_FILE, list);
    return true;
  }
  return false;
}

// ── Log de envios (append JSONL) ──
export function logSend(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n');
}
export function readLog(limit = 100) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}
