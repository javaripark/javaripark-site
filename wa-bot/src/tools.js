// Ferramentas do atendente. Schemas compactos (tokens) + validações de
// negócio espelhadas do admin (seg/ter fechado, 1 reserva por setor/data).
// Cancelar/alterar só operam em reservas atreladas ao Whatsapp do remetente.
import { queryDocs, addDoc, setDoc, getDoc, deleteDoc } from './firestore.js';

const SETORES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const TOLERANCIA = { 3: 'até 20h', 4: 'até 20h', 5: 'até 20h', 6: 'até 16h', 0: 'até 14h' };
// Exceções por data (ex: jogo do Brasil na Copa) — manter alinhado com EXCECOES_DIA do prompt.js
const TOLERANCIA_EXCECAO = { '2026-06-24': 'até 18h30 (dia de jogo do Brasil — entrada R$10 fixa)' };
const tolerancia = (data, dow) => TOLERANCIA_EXCECAO[data] || TOLERANCIA[dow] || 'a combinar com a equipe (dia de evento especial)';
// seg/ter: sistema permite (eventos especiais/corporativo), mas o bot deve tratar como exceção
const AVISO_SEG_TER = 'casa normalmente FECHADA neste dia (seg/ter); só existe reserva em evento especial confirmado pela equipe — não registre por conta própria, use chamar_humano';
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

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
        setor: { type: 'string', description: 'Setor 1-9, ou "Extras" quando a casa estiver lotada' },
        observacoes: { type: 'string', description: 'Opcional: aniversário, preferências, bolo etc.' },
      },
      required: ['data', 'nome', 'sobrenome', 'pessoas', 'setor'],
    },
  },
  {
    name: 'consultar_agenda',
    description: 'Programação/atrações da casa (música ao vivo etc.) nos próximos dias. Use quando perguntarem o que vai rolar.',
    input_schema: {
      type: 'object',
      properties: {
        dataInicio: { type: 'string', description: 'YYYY-MM-DD; padrão hoje' },
        dias: { type: 'integer', description: 'Quantos dias olhar à frente (padrão 7, máx 14)' },
      },
    },
  },
  {
    name: 'buscar_reservas',
    description: 'Lista as reservas futuras atreladas ao WhatsApp deste cliente. Use antes de cancelar ou alterar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancelar_reserva',
    description: 'Cancela uma reserva do próprio cliente. Só chame APÓS confirmação explícita do cancelamento.',
    input_schema: {
      type: 'object',
      properties: { reservaId: { type: 'string', description: 'ID retornado por buscar_reservas' } },
      required: ['reservaId'],
    },
  },
  {
    name: 'alterar_reserva',
    description: 'Altera data, quantidade de pessoas, setor ou observações de uma reserva do próprio cliente. Só chame APÓS o cliente confirmar o eco da alteração.',
    input_schema: {
      type: 'object',
      properties: {
        reservaId: { type: 'string', description: 'ID retornado por buscar_reservas' },
        novaData: { type: 'string', description: 'Opcional, YYYY-MM-DD' },
        novasPessoas: { type: 'integer', description: 'Opcional' },
        novoSetor: { type: 'string', description: 'Opcional, setor 1-9' },
        novasObservacoes: { type: 'string', description: 'Opcional' },
      },
      required: ['reservaId'],
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
  const reservas = await queryDocs('reservas', [['Data', data]]);
  const ocupados = reservas.map(r => String(r.Setor)).filter(s => s !== 'Extras');
  const livres = SETORES.filter(s => !ocupados.includes(s));
  const out = { aberto: true, diaSemana: DIAS[dow], setoresLivres: livres, toleranciaChegada: tolerancia(data, dow) };
  if (dow === 1 || dow === 2) out.atencao = AVISO_SEG_TER;
  if (!livres.length) { out.lotado = true; out.dica = 'ofereça reserva extra (setor "Extras"); equipe acomoda no dia'; }
  return out;
}

async function consultarAgenda({ dataInicio, dias }) {
  const inicio = (dataInicio && /^\d{4}-\d{2}-\d{2}$/.test(dataInicio)) ? dataInicio : hojeISO();
  const n = Math.min(Math.max(parseInt(dias, 10) || 7, 1), 14);
  const base = new Date(inicio + 'T12:00:00-03:00');
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const doc = await getDoc(`agenda/${iso}`).catch(() => null);
    const events = (doc?.events || []).map(e => ({ atracao: e.name, hora: e.time || '', estilo: e.obs || '' }));
    if (events.length) out.push({ data: iso, atracoes: events });
  }
  return { programacao: out, aviso: out.length ? undefined : 'nada cadastrado na agenda nesse período' };
}

async function registrarReserva(input, ctx) {
  const { data, nome, sobrenome, pessoas, setor, observacoes } = input;
  const d = validDate(data);
  if (!d) return { ok: false, erro: 'data inválida' };
  if (data < hojeISO()) return { ok: false, erro: 'data no passado' };
  const dow = d.getDay();
  if (dow === 1 || dow === 2) console.log('[reserva] seg/ter registrada (evento especial)');
  const isExtras = String(setor) === 'Extras';
  if (!isExtras && !SETORES.includes(String(setor))) return { ok: false, erro: 'setor inválido (1-9 ou Extras); Bus Lounge é via equipe humana' };
  if (!nome?.trim() || !sobrenome?.trim()) return { ok: false, erro: 'nome e sobrenome obrigatórios' };
  const n = parseInt(pessoas, 10);
  if (!n || n < 1 || n > 60) return { ok: false, erro: 'quantidade de pessoas inválida (1-60)' };

  // Re-checa conflito na hora da gravação (Extras não tem trava, como no admin)
  if (!isExtras) {
    const conflito = await queryDocs('reservas', [['Data', data], ['Setor', String(setor)]]);
    if (conflito.length) {
      const todas = await queryDocs('reservas', [['Data', data]]);
      const ocupados = todas.map(r => String(r.Setor));
      return { ok: false, erro: `setor ${setor} acabou de ser ocupado`, setoresLivres: SETORES.filter(s => !ocupados.includes(s)) };
    }
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
  return { ok: true, reservaId: id, diaSemana: DIAS[dow], toleranciaChegada: tolerancia(data, dow) };
}

// Acha a reserva e garante que pertence ao telefone do remetente
async function reservaDoCliente(reservaId, ctx) {
  if (!reservaId || /[\/.]/.test(reservaId)) return { erro: 'reservaId inválido' };
  const doc = await getDoc(`reservas/${reservaId}`);
  if (!doc) return { erro: 'reserva não encontrada' };
  if (!ctx.telefone || doc.Whatsapp !== ctx.telefone) {
    return { erro: 'reserva não pertence a este WhatsApp — use chamar_humano' };
  }
  return { doc };
}

async function buscarReservas(_input, ctx) {
  if (!ctx.telefone) return { reservas: [] };
  const todas = await queryDocs('reservas', [['Whatsapp', ctx.telefone]]);
  const hoje = hojeISO();
  const futuras = todas
    .filter(r => (r.Data || '') >= hoje)
    .sort((a, b) => (a.Data || '').localeCompare(b.Data || ''))
    .map(r => ({ reservaId: r.id, data: r.Data, setor: String(r.Setor), pessoas: r['Quantidade de Pessoas'], nome: `${r.Nome || ''} ${r.Sobrenome || ''}`.trim() }));
  return { reservas: futuras, aviso: futuras.length ? undefined : 'nenhuma reserva futura neste número; se foi feita por outro telefone ou Instagram, use chamar_humano' };
}

async function cancelarReserva({ reservaId }, ctx) {
  const r = await reservaDoCliente(reservaId, ctx);
  if (r.erro) return { ok: false, erro: r.erro };
  const { id, ...dados } = r.doc;
  await addDoc('wa_cancelamentos', { ...dados, ReservaId: reservaId, CanceladoEm: new Date().toISOString(), CanceladoVia: 'bot' });
  await deleteDoc(`reservas/${reservaId}`);
  return { ok: true, cancelada: { data: dados.Data, setor: String(dados.Setor), pessoas: dados['Quantidade de Pessoas'] } };
}

async function alterarReserva({ reservaId, novaData, novasPessoas, novoSetor, novasObservacoes }, ctx) {
  const r = await reservaDoCliente(reservaId, ctx);
  if (r.erro) return { ok: false, erro: r.erro };
  const atual = r.doc;

  const data = novaData || atual.Data;
  const setor = String(novoSetor || atual.Setor);
  const pessoas = novasPessoas != null ? parseInt(novasPessoas, 10) : atual['Quantidade de Pessoas'];

  const d = validDate(data);
  if (!d) return { ok: false, erro: 'data inválida' };
  if (data < hojeISO()) return { ok: false, erro: 'data no passado' };
  const dow = d.getDay();
  if (dow === 1 || dow === 2) console.log('[reserva] seg/ter registrada (evento especial)');
  if (!SETORES.includes(setor)) return { ok: false, erro: 'setor inválido (1-9); Bus Lounge é via equipe humana' };
  if (!pessoas || pessoas < 1 || pessoas > 60) return { ok: false, erro: 'quantidade de pessoas inválida (1-60)' };

  // Conflito no destino (data+setor), ignorando a própria reserva
  if (data !== atual.Data || setor !== String(atual.Setor)) {
    const conflito = (await queryDocs('reservas', [['Data', data], ['Setor', setor]])).filter(c => c.id !== reservaId);
    if (conflito.length) {
      const todas = await queryDocs('reservas', [['Data', data]]);
      const ocupados = todas.filter(c => c.id !== reservaId).map(c => String(c.Setor));
      return { ok: false, erro: `setor ${setor} ocupado em ${data}`, setoresLivres: SETORES.filter(s => !ocupados.includes(s)) };
    }
  }

  const { id, ...dados } = atual;
  await setDoc(`reservas/${reservaId}`, {
    ...dados,
    Data: data,
    Setor: setor,
    'Quantidade de Pessoas': pessoas,
    Observacoes: novasObservacoes != null ? novasObservacoes.trim() : (dados.Observacoes || ''),
    AlteradoEm: new Date().toISOString(),
    AlteradoVia: 'bot',
  });
  return { ok: true, reserva: { data, setor, pessoas }, diaSemana: DIAS[dow], toleranciaChegada: tolerancia(data, dow) };
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
    if (name === 'consultar_agenda') return await consultarAgenda(input);
    if (name === 'registrar_reserva') return await registrarReserva(input, ctx);
    if (name === 'buscar_reservas') return await buscarReservas(input, ctx);
    if (name === 'cancelar_reserva') return await cancelarReserva(input, ctx);
    if (name === 'alterar_reserva') return await alterarReserva(input, ctx);
    if (name === 'chamar_humano') return await chamarHumano(input, ctx);
    return { erro: 'ferramenta desconhecida' };
  } catch (e) {
    return { erro: 'falha interna: ' + e.message.slice(0, 120) };
  }
}
