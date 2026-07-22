// Ferramentas do atendente. Schemas compactos (tokens) + validações de
// negócio espelhadas do admin (seg/ter fechado, 1 reserva por setor/data).
// Cancelar/alterar só operam em reservas atreladas ao Whatsapp do remetente.
import { queryDocs, addDoc, setDoc, getDoc, deleteDoc, listDocs } from './firestore.js';

// Setores: fonte única é a collection 'setores' (capacidade, pai, ativoBot).
// Cache leve (5min) + fallback defensivo se o fetch falhar.
const SETORES_FALLBACK = (() => {
  const a = [];
  for (let i = 1; i <= 9; i++) {
    a.push({ label: String(i), tipo: 'principal', pai: null, ativoBot: true, capacidadeSentados: 20 });
    a.push({ label: i + 'B', tipo: 'filho', pai: String(i), ativoBot: true, capacidadeSentados: 20 });
  }
  a.push({ label: 'Bus Lounge', tipo: 'bus', pai: null, ativoBot: true });
  return a;
})();
let _setCache = { at: 0, data: null };
async function getSetoresCfg() {
  if (_setCache.data && Date.now() - _setCache.at < 300000) return _setCache.data;
  try {
    const docs = await listDocs('setores', 100);
    if (docs && docs.length) { _setCache = { at: Date.now(), data: docs }; return docs; }
  } catch (e) { /* cai no fallback */ }
  return _setCache.data || SETORES_FALLBACK;
}
// Deriva listas úteis: principais (1-9), mapa pai→filho, conjunto de válidos.
async function setorMapa() {
  const cfg = await getSetoresCfg();
  const ativos = cfg.filter(s => s.ativoBot !== false);
  const principais = ativos.filter(s => s.tipo === 'principal').map(s => s.label).sort((a, b) => a - b);
  const filhoDe = {};
  ativos.filter(s => s.tipo === 'filho').forEach(s => { filhoDe[s.pai] = s.label; });
  const validos = new Set(ativos.map(s => s.label));
  return { principais, filhoDe, validos };
}
const ehFilho = s => /^[1-9]B$/.test(String(s));

// Telefone chega em formatos diferentes: o painel grava "(11) 94310-4425" (mascarado,
// sem 55) e o WhatsApp entrega "5511943104425". Match exato NÃO funciona — 55 das 58
// reservas futuras eram invisíveis pro bot (bug de 11/06). Compara DDD + últimos 8
// dígitos (ignora máscara, código do país e o 9º dígito).
function phoneKey(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return d; // curto/estrangeiro: compara o que tem
  return d.slice(0, 2) + d.slice(-8);
}
const samePhone = (a, b) => { const k = phoneKey(a); return !!k && k === phoneKey(b); };
const TOLERANCIA = { 3: 'até 20h', 4: 'até 20h', 5: 'até 20h', 6: 'até 16h', 0: 'até 14h' };
// Exceções por data (ex: jogo do Brasil/evento especial) — manter alinhado com EXCECOES_DIA do prompt.js. (sem datas no momento)
const TOLERANCIA_EXCECAO = {};
// Datas normalmente FECHADAS (seg/ter) que ABREM por evento especial confirmado pelo René —
// nestas o bot reserva normal (sem o aviso de seg/ter). Manter alinhado com o prompt.js. (sem datas no momento)
const ABERTO_EXCECAO = {};
// Hora de abertura por DATA (sobrepõe ABERTURA por dia da semana) — usado no cutoff same-day. (sem datas no momento)
const ABERTURA_EXCECAO = {};
const tolerancia = (data, dow) => TOLERANCIA_EXCECAO[data] || TOLERANCIA[dow] || 'a combinar com a equipe (dia de evento especial)';
// seg/ter: sistema permite (eventos especiais/corporativo), mas o bot deve tratar como exceção
const AVISO_SEG_TER = 'esta data cai em SEGUNDA ou TERÇA: casa FECHADA ao público. EXPLIQUE isso ao cliente em linguagem simples (ex: "o dia X cai numa terça e a casa fecha ao público seg/ter") e ofereça quarta a domingo; se for grupo grande/evento querendo um dia fechado, é evento especial → chamar_humano DEPOIS de explicar. NUNCA registre por conta própria';
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
    description: 'Grava a reserva no sistema. Chame DIRETO assim que tiver data + pessoas + nome completo + setor — NÃO peça confirmação extra ao cliente.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'YYYY-MM-DD' },
        nome: { type: 'string', description: 'Primeiro nome' },
        sobrenome: { type: 'string', description: 'Sobrenome' },
        pessoas: { type: 'integer', description: 'Quantidade de pessoas' },
        setor: { type: 'string', description: 'Setor principal 1-9, filho de overflow 1B-9B (só quando o pai 1-9 está ocupado) ou "Bus Lounge" (10-40 pessoas). NÃO use "Extras" — quando tudo encher, use chamar_humano.' },
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
    description: 'Altera data, quantidade de pessoas, setor, nome ou observações de uma reserva do próprio cliente. Chame DIRETO quando o cliente pedir a mudança — sem pedir confirmação extra.',
    input_schema: {
      type: 'object',
      properties: {
        reservaId: { type: 'string', description: 'ID retornado por buscar_reservas' },
        novaData: { type: 'string', description: 'Opcional, YYYY-MM-DD' },
        novasPessoas: { type: 'integer', description: 'Opcional' },
        novoSetor: { type: 'string', description: 'Opcional: setor 1-9, filho 1B-9B (overflow, só com o pai ocupado) ou "Bus Lounge"' },
        novoNome: { type: 'string', description: 'Opcional: novo primeiro nome (correção ou troca de quem vai)' },
        novoSobrenome: { type: 'string', description: 'Opcional: novo sobrenome' },
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
const horaSP = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours();
// hora decimal (com minutos) pro cutoff de 30 min antes da abertura
const horaSPdec = () => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); return d.getHours() + d.getMinutes() / 60; };

// Reserva pro próprio dia: só até 30 min antes da casa abrir (regra do René, jul/2026)
const ABERTURA = { 3: 18, 4: 18, 5: 18, 6: 14, 0: 12 };
function reservaHojeEncerrada(data, dow) {
  if (data !== hojeISO()) return null;
  const abre = ABERTURA_EXCECAO[data] || ABERTURA[dow];
  if (!abre) return null; // seg/ter: evento especial, sem regra de cutoff
  if (horaSPdec() >= abre - 0.5) return `reservas para hoje encerraram (aceitamos até 30 min antes da abertura, ou seja, até ${abre - 1}h30); ofereça outro dia`;
  return null;
}

async function consultarDisponibilidade({ data }) {
  const d = validDate(data);
  if (!d) return { erro: 'data inválida, use YYYY-MM-DD' };
  if (data < hojeISO()) return { aberto: false, motivo: 'data no passado' };
  const dow = d.getDay();
  const reservas = await queryDocs('reservas', [['Data', data]]);
  const ocupados = new Set(reservas.map(r => String(r.Setor)));
  const { principais, filhoDe } = await setorMapa();
  const livres = principais.filter(s => !ocupados.has(s));
  // Overflow: filho só entra quando o PAI está ocupado e o próprio filho está livre.
  const overflowLivres = [];
  for (const pai of principais) {
    const f = filhoDe[pai];
    if (f && ocupados.has(pai) && !ocupados.has(f)) overflowLivres.push(f);
  }
  const busLivre = !ocupados.has('Bus Lounge');
  const out = { aberto: true, diaSemana: DIAS[dow], setoresLivres: livres, overflowLivres, busLivre, toleranciaChegada: tolerancia(data, dow) };
  const cutoff = reservaHojeEncerrada(data, dow);
  if (cutoff) out.avisoHoje = cutoff;
  if ((dow === 1 || dow === 2) && !ABERTO_EXCECAO[data]) out.atencao = AVISO_SEG_TER;
  if (!livres.length) {
    out.lotado = livres.length === 0 && overflowLivres.length === 0;
    out.dica = livres.length === 0
      ? (overflowLivres.length ? `sem setor principal livre; reserve POR DENTRO um overflow disponível (${overflowLivres.join(', ')}) sem narrar ocupação ao cliente`
        : (busLivre ? 'sem setor de mesa livre; ofereça o Bus Lounge se servir ao grupo; se não servir, NÃO diga "lotado" — passe pra um humano (chamar_humano), a casa resolve a acomodação'
          : 'sem nenhum lugar livre (setores, overflow e Bus reservados) — NÃO diga "lotado" nem invente acomodação: passe pra um humano (chamar_humano) com carinho, a casa decide'))
      : undefined;
  }
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
  const cutoff = reservaHojeEncerrada(data, dow);
  if (cutoff) return { ok: false, erro: cutoff };
  const setorStr = String(setor);
  const { principais, filhoDe, validos } = await setorMapa();
  if (setorStr === 'Extras') return { ok: false, erro: 'Extras é reserva manual da equipe, não reservável pelo bot — quando o catalogado esgotar, use chamar_humano' };
  const isBus = setorStr === 'Bus Lounge';
  if (!validos.has(setorStr)) return { ok: false, erro: 'setor inválido (1-9, filhos 1B-9B ou "Bus Lounge")' };
  if (!nome?.trim() || !sobrenome?.trim()) return { ok: false, erro: 'nome e sobrenome obrigatórios' };
  const n = parseInt(pessoas, 10);
  if (isBus && (n < 10 || n > 40)) return { ok: false, erro: 'Bus Lounge é para 10 a 40 pessoas' };
  // Sem limite de negócio pra grupo grande (garante-se 20 sentados, resto a equipe acomoda).
  // O teto 500 é só guarda técnica contra typo/abuso.
  if (!n || n < 1 || n > 500) return { ok: false, erro: 'quantidade de pessoas inválida' };
  // Filho (overflow) só pode ser reservado quando o PAI já está ocupado nessa data.
  if (ehFilho(setorStr)) {
    const pai = setorStr[0];
    const paiOcup = await queryDocs('reservas', [['Data', data], ['Setor', pai]]);
    if (!paiOcup.length) return { ok: false, erro: `o setor ${pai} ainda está livre — reserve o ${pai} primeiro; o ${setorStr} só vale como overflow quando o ${pai} está ocupado`, setorSugerido: pai };
  }

  // Trava anti-abuso: 1 reserva por número de WhatsApp por dia (match tolerante:
  // pega também reserva manual do painel gravada com número mascarado)
  if (ctx.telefone) {
    const doDia = await queryDocs('reservas', [['Data', data]]);
    const doNumero = doDia.filter(r => samePhone(r.Whatsapp, ctx.telefone));
    if (doNumero.length) {
      const ex = doNumero[0];
      return { ok: false, erro: 'este número já tem reserva nesse dia (limite: 1 por dia)', reservaExistente: { reservaId: ex.id, setor: String(ex.Setor), pessoas: ex['Quantidade de Pessoas'] }, dica: 'ofereça alterar a reserva existente (pessoas/setor) em vez de criar outra' };
    }
  }

  // Re-checa conflito na hora da gravação (vale também pros filhos, que agora têm trava)
  {
    const conflito = await queryDocs('reservas', [['Data', data], ['Setor', setorStr]]);
    if (conflito.length) {
      const todas = await queryDocs('reservas', [['Data', data]]);
      const ocupados = new Set(todas.map(r => String(r.Setor)));
      return { ok: false, erro: `setor ${setorStr} acabou de ser ocupado`, setoresLivres: principais.filter(s => !ocupados.has(s)) };
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
  // NÃO devolver toleranciaChegada aqui: o bloco pós-reserva automático já informa a
  // chegada (incl. exceções de dia), e o modelo papagueia qualquer horário que receber.
  return { ok: true, reservaId: id, diaSemana: DIAS[dow], setor: setorCliente(setor, observacoes), setorCliente: setorCliente(setor, observacoes) };
}

// Acha a reserva e garante que pertence ao telefone do remetente
async function reservaDoCliente(reservaId, ctx) {
  if (!reservaId || /[\/.]/.test(reservaId)) return { erro: 'reservaId inválido' };
  const doc = await getDoc(`reservas/${reservaId}`);
  if (!doc) return { erro: 'reserva não encontrada' };
  if (!ctx.telefone || !samePhone(doc.Whatsapp, ctx.telefone)) {
    return { erro: 'reserva não pertence a este WhatsApp — use chamar_humano' };
  }
  return { doc };
}

// Rótulo do setor PARA O CLIENTE — nunca expõe rótulo interno (regra do René, 13/06):
// overflow "6B"/"1B".."9B" -> "6" (só o número); "Extras" -> número que está na observação
// (ex: "6C" -> "6"); 1-9 e "Bus Lounge" ficam iguais. Se não der pra saber o número
// (Extras sem pista na obs), retorna '' -> o bot não cita setor específico.
function setorCliente(setor, obs) {
  const s = String(setor || '').trim();
  const mB = s.match(/^([1-9])B$/i);
  if (mB) return mB[1];
  if (/^extras$/i.test(s)) {
    const o = String(obs || '');
    // prioridade: "6C"/"6 C" (número+nível) → "setor 6" → dígito 1-9 isolado (não pega "10")
    const mo = o.match(/\b([1-9])\s*[A-Ca-c]\b/) || o.match(/setor\s*([1-9])\b/i) || o.match(/\b([1-9])\b(?!\d)/);
    return mo ? mo[1] : '';
  }
  return s;
}

async function buscarReservas(_input, ctx) {
  if (!ctx.telefone) return { reservas: [] };
  // Scan + match tolerante: reservas manuais do painel têm o número mascarado
  // ("(11) 9...") — query por igualdade nunca acha. Banco pequeno, scan ok.
  const todas = await listDocs('reservas', 2000);
  const hoje = hojeISO();
  const futuras = todas
    .filter(r => (r.Data || '') >= hoje && samePhone(r.Whatsapp, ctx.telefone))
    .sort((a, b) => (a.Data || '').localeCompare(b.Data || ''))
    .map(r => ({ reservaId: r.id, data: r.Data, setor: setorCliente(r.Setor, r.Observacoes), pessoas: r['Quantidade de Pessoas'], nome: `${r.Nome || ''} ${r.Sobrenome || ''}`.trim() }));
  return { reservas: futuras, aviso: futuras.length ? undefined : 'nenhuma reserva futura neste número; se foi feita por outro telefone ou Instagram, use chamar_humano' };
}

async function cancelarReserva({ reservaId }, ctx) {
  const r = await reservaDoCliente(reservaId, ctx);
  if (r.erro) return { ok: false, erro: r.erro };
  const { id, ...dados } = r.doc;
  await addDoc('wa_cancelamentos', { ...dados, ReservaId: reservaId, CanceladoEm: new Date().toISOString(), CanceladoVia: 'bot' });
  await deleteDoc(`reservas/${reservaId}`);
  return { ok: true, cancelada: { data: dados.Data, setor: setorCliente(dados.Setor, dados.Observacoes), pessoas: dados['Quantidade de Pessoas'] } };
}

async function alterarReserva({ reservaId, novaData, novasPessoas, novoSetor, novoNome, novoSobrenome, novasObservacoes }, ctx) {
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
  const cutoffAlt = data !== atual.Data ? reservaHojeEncerrada(data, dow) : null;
  if (cutoffAlt) return { ok: false, erro: cutoffAlt };
  const { principais, validos } = await setorMapa();
  if (setor === 'Extras') return { ok: false, erro: 'Extras é manual da equipe — use chamar_humano' };
  const busAlvo = setor === 'Bus Lounge';
  if (!validos.has(setor)) return { ok: false, erro: 'setor inválido (1-9, filhos 1B-9B ou "Bus Lounge")' };
  if (busAlvo && (pessoas < 10 || pessoas > 40)) return { ok: false, erro: 'Bus Lounge é para 10 a 40 pessoas' };
  if (!pessoas || pessoas < 1 || pessoas > 500) return { ok: false, erro: 'quantidade de pessoas inválida' };
  // Filho só vale como overflow quando o pai está ocupado nessa data (ignora a própria reserva)
  if (ehFilho(setor)) {
    const pai = setor[0];
    const paiOcup = (await queryDocs('reservas', [['Data', data], ['Setor', pai]])).filter(c => c.id !== reservaId);
    if (!paiOcup.length) return { ok: false, erro: `o setor ${pai} está livre — mova pro ${pai}; ${setor} só vale como overflow com o ${pai} ocupado` };
  }

  // Trava anti-abuso também na mudança de data: 1 reserva por número por dia
  if (data !== atual.Data && ctx.telefone) {
    const doNumero = (await queryDocs('reservas', [['Data', data]]))
      .filter(c => c.id !== reservaId && samePhone(c.Whatsapp, ctx.telefone));
    if (doNumero.length) return { ok: false, erro: 'este número já tem outra reserva nesse dia (limite: 1 por dia)' };
  }

  // Conflito no destino (data+setor), ignorando a própria reserva
  if (data !== atual.Data || setor !== String(atual.Setor)) {
    const conflito = (await queryDocs('reservas', [['Data', data], ['Setor', setor]])).filter(c => c.id !== reservaId);
    if (conflito.length) {
      const todas = await queryDocs('reservas', [['Data', data]]);
      const ocupados = todas.filter(c => c.id !== reservaId).map(c => String(c.Setor));
      return { ok: false, erro: `setor ${setor} ocupado em ${data}`, setoresLivres: principais.filter(s => !ocupados.includes(s)) };
    }
  }

  const { id, ...dados } = atual;
  const nome = novoNome?.trim() || dados.Nome;
  const sobrenome = novoSobrenome?.trim() || dados.Sobrenome;
  await setDoc(`reservas/${reservaId}`, {
    ...dados,
    Data: data,
    Setor: setor,
    Nome: nome,
    Sobrenome: sobrenome,
    'Quantidade de Pessoas': pessoas,
    Observacoes: novasObservacoes != null ? novasObservacoes.trim() : (dados.Observacoes || ''),
    AlteradoEm: new Date().toISOString(),
    AlteradoVia: 'bot',
  });
  const obsFinal = novasObservacoes != null ? novasObservacoes : (dados.Observacoes || '');
  return { ok: true, reserva: { data, setor: setorCliente(setor, obsFinal), pessoas, nome: `${nome} ${sobrenome}`.trim() }, diaSemana: DIAS[dow], toleranciaChegada: tolerancia(data, dow) };
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
