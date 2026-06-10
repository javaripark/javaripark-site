// Estado de conversa por telefone em wa_atendimento/{telefone}.
// Histórico vira string JSON (simples de codificar via REST); janela de 24h
// idle reseta o contexto; janela de 20 mensagens controla tokens.
import { getDoc, setDoc } from './firestore.js';

const MAX_MSGS = 20;
const IDLE_RESET_MS = 24 * 60 * 60 * 1000;

export async function loadConv(telefone) {
  const doc = await getDoc(`wa_atendimento/${telefone}`);
  if (!doc) return { telefone, status: 'bot', messages: [], nomePerfil: '', origem: 'organico' };
  let messages = [];
  try { messages = JSON.parse(doc.HistoricoJson || '[]'); } catch (e) { messages = []; }
  const idle = doc.updatedAt ? Date.now() - new Date(doc.updatedAt).getTime() : Infinity;
  if (idle > IDLE_RESET_MS) {
    messages = [];
    if (doc.status === 'humano') doc.status = 'bot'; // humano expira junto com a janela
  }
  return {
    telefone,
    status: doc.status || 'bot',
    messages,
    nomePerfil: doc.NomePerfil || '',
    origem: doc.Origem || 'organico',
    // funil
    etapa: doc.Etapa || 'lead',
    primeiroContato: doc.PrimeiroContato || '',
    ultimaMsgCliente: doc.UltimaMsgCliente || '',
    msgsCliente: doc.MsgsCliente || 0,
    reservouEm: doc.ReservouEm || '',
  };
}

export async function saveConv(conv) {
  const trimmed = conv.messages.slice(-MAX_MSGS);
  await setDoc(`wa_atendimento/${conv.telefone}`, {
    status: conv.status,
    HistoricoJson: JSON.stringify(trimmed),
    NomePerfil: conv.nomePerfil || '',
    Origem: conv.origem || 'organico',
    Etapa: conv.etapa || 'lead',
    PrimeiroContato: conv.primeiroContato || '',
    UltimaMsgCliente: conv.ultimaMsgCliente || '',
    MsgsCliente: conv.msgsCliente || 0,
    ReservouEm: conv.reservouEm || '',
    updatedAt: new Date().toISOString(),
  });
}
