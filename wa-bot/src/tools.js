// Ferramentas do atendente. Schemas compactos (tokens) + validações de
// negócio espelhadas do admin (seg/ter fechado, 1 reserva por setor/data).
import { queryDocs, addDoc, setDoc } from './firestore.js';

const SETORES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const TOLERANCIA = { 3: 'até 20h', 4: 'até 20h', 5: 'até 20h', 6: 'até 16h', 0: 'até 14h' };

export const toolDefs = [
  {
    name: 'consultar_disponibilidade',
    description: 'Consulta se a casa abre na data e quais setores estão livres. Use antes de prometer qualquer reserva.',
    input_schema: {
      type: 'object',
      properties: { data: { type: 'string', description: 'Data no formato YYYY-MM-DD' } },
      required: ['data'],
    },
  },
  {
    name: 'registrar_reserva',
    description: 'Grava a reserva no sistema. Só chame APÓS o cliente confirmar o eco com todos os dados.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'YYYY-MM-DD' },
        nome: { type: 'string', description: 'Primeiro nome' },
        sobrenome: { type: 'string', description: 'Sobrenome' },
        pessoas: { type: 'integer', description: 'Quantidade de pessoas' },
        setor: { type: 'string', description: 'Setor 1-9' },
        observacoes: { type: 'string', description: 'Opcional: aniversário, preferências, bolo etc.' },
      },
      required: ['data', 'nome', 'sobrenome', 'pessoas', 'setor'],
    },
  },
  {
    name: 'chamar_humano',
    description: 'Transfere a conversa pra equipe humana. O bot para de responder até a equipe assumir.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Resumo curto do que o cliente precisa' } },
      required: ['motivo'],
    },
  },
];

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const d = new Date(s + 'T12:00:00-03:00');
  return isNaN(d) ? null : d;
}
const hojeISO = () => {
  const sp = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  return `${sp.getFullYear()}-${String(sp.getMonth() + 1).padStart(2, '0')}-${String(sp.getDate()).padStart(2, '0')}`;
};

async function consultarDisponibilidade({ data }) {
  const d = validDate(data);
  if (!d) return { erro: 'data inválida, use YYYY-MM-DD' };
  if (data < hojeISO()) return { aberto: false, motivo: 'data no passado' };
  const dow = d.getDay();
  if (dow === 1 || dow === 2) return { aberto: false, motivo: 'fechado às segundas e terças' };
  const reservas = await queryDocs('reservas', [['Data', data]]);
  const ocupados = reservas.map(r => String(r.Setor)).filter(s => s !== 'Extras');
  const livres = SETORES.filter(s => !ocupados.includes(s));
  return { aberto: true, setoresLivres: livres, toleranciaChegada: TOLERANCIA[dow] };
}

async function registrarReserva(input, ctx) {
  const { data, nome, sobrenome, pessoas, setor, observacoes } = input;
  const d = validDate(data);
  if (!d) return { ok: false, erro: 'data inválida' };
  if (data < hojeISO()) return { ok: false, erro: 'data no passado' };
  const dow = d.getDay();
  if (dow === 1 || dow === 2) return { ok: false, erro: 'fechado às segundas e terças' };
  if (!SETORES.includes(String(setor))) return { ok: false, erro: 'setor inválido (1-9); Bus Lounge é via equipe humana' };
  if (!nome?.trim() || !sobrenome?.trim()) return { ok: false, erro: 'nome e sobrenome obrigatórios' };
  const n = parseInt(pessoas, 10);
  if (!n || n < 1 || n > 60) return { ok: false, erro: 'quantidade de pessoas inválida (1-60)' };

  // Re-checa conflito na hora da gravação (outro cliente pode ter pego o setor)
  const conflito = await queryDocs('reservas', [['Data', data], ['Setor', String(setor)]]);
  if (conflito.length) {
    const todas = await queryDocs('reservas', [['Data', data]]);
    const ocupados = todas.map(r => String(r.Setor));
    return { ok: false, erro: `setor ${setor} acabou de ser ocupado`, setoresLivres: SETORES.filter(s => !ocupados.includes(s)) };
  }

  const id = await addDoc('reservas', {
    Data: data,
    Setor: String(setor),
    Nome: nome.trim(),
    Sobrenome: sobrenome.trim(),
    'Quantidade de Pessoas': n,
    Whatsapp: ctx.telefone || '',
    Observacoes: (observacoes || '').trim(),
    Origem: ctx.origem || 'organico',
    ViaBot: true,
    CriadoEm: new Date().toISOString(),
  });
  return { ok: true, reservaId: id, toleranciaChegada: TOLERANCIA[dow] };
}

async function chamarHumano({ motivo }, ctx) {
  await addDoc('wa_alertas', {
    Telefone: ctx.telefone || '',
    Nome: ctx.nomePerfil || '',
    Motivo: motivo || '',
    CriadoEm: new Date().toISOString(),
    Resolvido: false,
  });
  if (ctx.telefone) {
    await setDoc(`wa_atendimento/${ctx.telefone}`, { ...(ctx.convDoc || {}), status: 'humano', updatedAt: new Date().toISOString() });
  }
  return { ok: true, aviso: 'equipe notificada; bot pausado nesta conversa' };
}

export async function runTool(name, input, ctx) {
  try {
    if (name === 'consultar_disponibilidade') return await consultarDisponibilidade(input);
    if (name === 'registrar_reserva') return await registrarReserva(input, ctx);
    if (name === 'chamar_humano') return await chamarHumano(input, ctx);
    return { erro: 'ferramenta desconhecida' };
  } catch (e) {
    return { erro: 'falha interna: ' + e.message.slice(0, 120) };
  }
}
