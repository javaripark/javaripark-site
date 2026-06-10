// Firestore via REST, AUTENTICADO (rules fechadas desde a blindagem):
// - Na nuvem (Functions): OAuth da service account via metadata server
//   (identidade IAM ignora as rules — é o "admin SDK" do bot).
// - Local (bateria/simulador/fala): login Firebase do admin via .env
//   (ADMIN_EMAIL/ADMIN_PASSWORD) — passa pelas rules como admin.
import { cfg } from './config.js';

const API_KEY = 'AIzaSyBPsAFkMBXtmlv6UvavXGdD86nWz9b__18';
let tokCache = { token: '', exp: 0 };

async function authHeader() {
  if (Date.now() < tokCache.exp - 60e3) return { Authorization: 'Bearer ' + tokCache.token };
  if (process.env.K_SERVICE) {
    // Cloud Functions/Run: token da identidade da função
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
    const d = await r.json();
    tokCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
    return { Authorization: 'Bearer ' + tokCache.token };
  }
  const email = process.env.ADMIN_EMAIL, senha = process.env.ADMIN_PASSWORD;
  if (email && senha) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: senha, returnSecureToken: true }),
    });
    const d = await r.json();
    if (!d.idToken) throw new Error('login admin falhou: ' + JSON.stringify(d.error || d).slice(0, 120));
    tokCache = { token: d.idToken, exp: Date.now() + parseInt(d.expiresIn || '3600', 10) * 1000 };
    return { Authorization: 'Bearer ' + tokCache.token };
  }
  return {}; // sem credencial: só funciona com rules abertas
}

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') return { mapValue: { fields: encFields(v) } };
  return { stringValue: String(v) };
}
const encFields = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)]));

function dec(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(dec);
  if (v.mapValue) return decFields(v.mapValue.fields || {});
  if (v.timestampValue !== undefined) return v.timestampValue;
  return null;
}
const decFields = fields => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, dec(v)]));

async function fsFetch(url, opts = {}) {
  const auth = await authHeader();
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...auth, ...(opts.headers || {}) } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Firestore ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

export async function getDoc(relPath) {
  const auth = await authHeader();
  const r = await fetch(`${cfg.fsBase}/${cfg.fsDataPath}/${relPath}`, { headers: auth });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore get ${r.status}`);
  const d = await r.json();
  return { id: d.name.split('/').pop(), ...decFields(d.fields) };
}

export async function setDoc(relPath, data) {
  await fsFetch(`${cfg.fsBase}/${cfg.fsDataPath}/${relPath}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: encFields(data) }),
  });
}

export async function addDoc(collection, data) {
  const d = await fsFetch(`${cfg.fsBase}/${cfg.fsDataPath}/${collection}`, {
    method: 'POST',
    body: JSON.stringify({ fields: encFields(data) }),
  });
  return d.name.split('/').pop();
}

export async function deleteDoc(relPath) {
  await fsFetch(`${cfg.fsBase}/${cfg.fsDataPath}/${relPath}`, { method: 'DELETE' });
}

// Lista todos os docs de uma coleção (paginado) — pro resgate varrer conversas
export async function listDocs(collection) {
  const out = [];
  let pageToken = '';
  do {
    const url = `${cfg.fsBase}/${cfg.fsDataPath}/${collection}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const d = await fsFetch(url);
    for (const doc of d.documents || []) out.push({ id: doc.name.split('/').pop(), ...decFields(doc.fields) });
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return out;
}

// runQuery com filtros de igualdade: where = [['Campo','valor'], ...]
export async function queryDocs(collection, where) {
  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: where.map(([field, value]) => ({
          fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: enc(value) },
        })),
      },
    },
  };
  const parent = `${cfg.fsBase}/${cfg.fsDataPath}`;
  const rows = await fsFetch(`${parent}:runQuery`, {
    method: 'POST',
    body: JSON.stringify({ structuredQuery }),
  });
  return rows.filter(r => r.document).map(r => ({ id: r.document.name.split('/').pop(), ...decFields(r.document.fields) }));
}
