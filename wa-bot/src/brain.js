// Loop do agente: mensagem do cliente → Claude (+ ferramentas) → resposta.
// Prompt caching no bloco estático; histórico já vem com janela do store.
// Guardas: bloco pós-reserva anexado pelo código; detector de "anunciou
// ação sem executar ferramenta" com 1 rodada corretiva.
import Anthropic from '@anthropic-ai/sdk';
import { cfg, PRICING, pricingFor } from './config.js';
import { SYSTEM_KB, posReserva, dynamicContext } from './prompt.js';
import { toolDefs, runTool } from './tools.js';

// maxRetries: a API às vezes devolve 529 (Overloaded) por alguns segundos.
// O SDK faz backoff exponencial em 429/5xx/529 — subir pra 4 cobre o pico sem deixar o cliente no silêncio.
const client = new Anthropic({ apiKey: cfg.anthropicKey, maxRetries: 4 });
const MAX_TOOL_ROUNDS = 6;

// Anúncio de ação de estado (criar/alterar/cancelar) na resposta final
const CLAIM_RE = /reserva\s+(tá\s+|está\s+)?(confirmada|feita|registrada|alterada|cancelada|trocada|atualizada|remarcada)|\b(alterei|cancelei|registrei|troquei|remarquei|atualizei)\b|pronto[,!]?\s*(tudo\s+)?(cancelad|alterad|confirmad|registrad)|\b(cancelada|alterada|remarcada)\s*[!.]/i;

// custoUSD(usage, [model]) — sem model usa o PRICING do modelo em uso (turnos novos);
// com model (ex: recálculo histórico) usa o preço daquele modelo específico.
export function custoUSD(u, model) {
  const p = model ? pricingFor(model) : PRICING;
  return (
    (u.input_tokens || 0) * p.input +
    (u.output_tokens || 0) * p.output +
    (u.cache_creation_input_tokens || 0) * p.cacheWrite +
    (u.cache_read_input_tokens || 0) * p.cacheRead
  ) / 1e6;
}

// conv: {telefone, messages, nomePerfil, origem, status}
// Retorna {reply, usage:[...], handoff:boolean}
export async function atender(conv, textoCliente) {
  conv.messages.push({ role: 'user', content: textoCliente });

  // Reconfirmação enviada pela equipe: o contexto fica ATIVO por até 12h (NÃO é
  // one-shot — o cliente pode responder em várias mensagens). Só sai quando uma
  // ferramenta de reserva roda (limpo no finish) ou quando expira.
  const reconfRecente = conv.reconfirmou && (Date.now() - new Date(conv.reconfirmou).getTime() < 12 * 3600 * 1000);
  if (conv.reconfirmou && !reconfRecente) conv.reconfirmou = ''; // expirou
  const reconfNote = reconfRecente
    ? ` CONTEXTO IMPORTANTE: a equipe enviou uma RECONFIRMAÇÃO de reserva pra este cliente há pouco — ele JÁ TEM reserva. NUNCA pergunte se ele quer "fazer uma reserva" nem diga "pra fazer sua reserva é só mandar". Trate a resposta: se CONFIRMAR (tudo certo / segue o mesmo), responda SEMPRE com UMA frase curta e calorosa fechando o ciclo, SEM ferramenta e SEM inventar data/detalhe (ex: "Perfeito, tá tudo certo, te espero! 🎉") — NÃO fique em silêncio NA confirmação. Só nas mensagens SEGUINTES ("ok"/"valeu"/"boa noite") você responde __SILENCIO__; se informar OUTRO número de pessoas, rode buscar_reservas e ALTERE; se quiser cancelar/mudar data/setor, fluxos normais; se parecer perdido, buscar_reservas. IMPORTANTE: NÃO existe prazo pra responder a reconfirmação e a falta de resposta NÃO cancela a reserva — se o cliente se desculpar pela demora ou perguntar se "perdeu o prazo", tranquilize: a reserva está de pé, a reconfirmação é só pra ajudar a casa a se organizar.`
    : '';

  const adNote = conv.adInfo
    ? ` CONTEXTO: este cliente chegou clicando num anúncio da casa: «${conv.adInfo}». Conecte sua abertura ao tema do anúncio (sem inventar nada além do que está nele e neste prompt) e vá direto ao ponto — nada de menu genérico de opções.`
    : '';

  const system = [
    { type: 'text', text: SYSTEM_KB, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicContext() + (conv.nomePerfil ? ` Nome no perfil do WhatsApp do cliente: ${conv.nomePerfil}.` : '') + adNote + reconfNote },
  ];

  const ctx = { telefone: conv.telefone, nomePerfil: conv.nomePerfil, origem: conv.origem, convDoc: null };
  const usage = [];
  let handoff = false;
  let acted = false;        // alguma ferramenta de estado retornou ok:true neste turno
  let registrouData = null; // data da reserva criada neste turno → anexa bloco pós-reserva
  let cancelou = false;     // cancelar_reserva rodou ok:true → conversa deixa de ser "ganho"
  let corrected = false;    // rodada corretiva já usada
  let cobrouDispo = false;  // rodada corretiva de disponibilidade já usada
  const toolsUsadas = [];   // pro funil: negociação = mexeu em ferramenta de reserva
  let messages = conv.messages.map(m => ({ role: m.role, content: m.content }));

  const finish = reply => {
    // WhatsApp: negrito é UM asterisco; o Haiku às vezes manda ** (markdown), que
    // vira asterisco literal na tela. Guarda no código — não confiar só no prompt.
    reply = String(reply).replace(/\*{2,}/g, '*');
    // Termos INTERNOS de setor nunca chegam ao cliente (o prompt proíbe, mas o modelo
    // teima — caso Gabi 4263: "overflow do setor 4"). Guarda no código.
    reply = reply
      .replace(/\boverflow\s+do\s+setor\s+(\d)/gi, 'setor $1')
      .replace(/\boverflow\s+do\s+(\d)/gi, 'setor $1')
      .replace(/\bo\s+overflow\b/gi, 'um lugar')
      .replace(/\boverflow[s]?\b/gi, 'lugar')
      .replace(/\bsetor(es)?\s+filho[s]?\b/gi, 'setor')
      .replace(/\bsetor(es)?\s+pai[s]?\b/gi, 'setor');
    if (acted) conv.reconfirmou = ''; // ação de reserva resolveu a reconfirmação
    if (registrouData) reply = reply + '\n\n' + posReserva(registrouData);
    conv.messages.push({ role: 'assistant', content: reply });
    if (handoff) conv.status = 'humano';
    const negociou = toolsUsadas.some(n => ['consultar_disponibilidade', 'registrar_reserva', 'buscar_reservas', 'alterar_reserva', 'cancelar_reserva'].includes(n));
    return { reply, usage, handoff, reservou: !!registrouData, cancelou, negociou };
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const resp = await client.messages.create({
      model: cfg.model,
      max_tokens: 500,
      system,
      tools: toolDefs,
      messages,
      // Sonnet/Opus: effort baixo + sem thinking = rápido e barato (sem o default 'high').
      // Haiku não suporta effort (cfg.effort vem vazio) → mantém a chamada como era.
      ...(cfg.effort ? { output_config: { effort: cfg.effort }, thinking: { type: 'disabled' } } : {}),
    });
    usage.push(resp.usage);

    if (resp.stop_reason !== 'tool_use') {
      let reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      // __SILENCIO__: token de "fica quieto". O modelo ora manda SÓ o token, ora vaza ele
      // GRUDADO num texto normal (ex: "Te espero! \n\n__SILENCIO__") e em formas variadas
      // (_SILENCIO_, **SILENCIO**). Remove o token de QUALQUER lugar — nunca pode chegar ao
      // cliente. Exige wrapper (_/*) pra não mexer na palavra "silêncio" num texto de verdade.
      reply = reply
        .replace(/_{1,3}\s*sil[eê]ncio\s*_{1,3}/gi, '')
        .replace(/\*{1,3}\s*sil[eê]ncio\s*\*{1,3}/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      // Sem nada pendente e não sobrou nada de útil → fica quieto (humano não responde a
      // todo "show"). Cobre o token pelado também (ex: "SILENCIO" sem wrapper).
      if (!acted && (reply === '' || /^sil[eê]ncio$/i.test(reply))) {
        conv.messages.pop();
        return { reply: '', usage, handoff: false, reservou: false, negociou: false };
      }
      // nunca deixar o cliente no vácuo (ex.: handoff sem texto)
      if (!reply) reply = handoff
        ? 'Já chamei alguém do time pra te ajudar por aqui — respondem rapidinho! 😉'
        : 'Opa, me perdi aqui 😅 Pode repetir, por favor?';
      // Pediu dados de reserva (nome/quantas pessoas) sem ter checado disponibilidade
      // nem neste turno nem há pouco? 1 rodada corretiva: se a data já é conhecida ou
      // dedutível, checa ANTES de coletar — evita "responde 3 perguntas e tá lotado"
      // (bug recorrente, caso Larissa 11/06).
      const pedeDados = /nome completo|quantas pessoas|qual (é )?(o )?seu nome|sobrenome\?/i.test(reply);
      const dispoRecente = conv.dispoEm && (Date.now() - new Date(conv.dispoEm).getTime() < 2 * 3600e3);
      // A corretiva só serve quando existe uma DATA pra checar. Sem sinal de data na conversa
      // (cliente só disse "quero reservar"/"pra 8 pessoas"), NÃO dispara — senão ela força o bot
      // a reenviar só o pedido de dados e atropela perguntas do cliente (caso 2184).
      const userText = conv.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join(' ');
      const temSinalData = /\b(hoje|amanh|depois de amanh|s[áa]bado|domingo|segunda|ter[çc]a|quarta|quinta|sexta|dia\s*\d|\d{1,2}\s*\/\s*\d|\d{1,2}\s+de\s+[a-zç]|jogo|copa|feriado|v[ée]spera|natal|ano novo|r[ée]veillon|reveillon)\b/i.test(userText);
      if (pedeDados && temSinalData && !cobrouDispo && !dispoRecente && !toolsUsadas.includes('consultar_disponibilidade')) {
        cobrouDispo = true;
        messages = [...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: '[sistema] Antes de pedir dados do cliente: a data da reserva já está definida ou é dedutível da conversa (ex: "o jogo de sábado" = a data do jogo)? Se SIM, rode consultar_disponibilidade AGORA — e se o dia estiver lotado, avise JÁ e ofereça walk-in/outra data, SEM pedir mais dados. EM QUALQUER caso (data definida ou não), RESPONDA também toda pergunta que o cliente fez (programação, valor, como funciona, entrada etc.) — é PROIBIDO só pedir dados deixando uma pergunta dele sem resposta. Se a data ainda NÃO está definida, responda o cliente normalmente — RESPONDENDO primeiro QUALQUER pergunta que ele tenha feito (como funciona, não conheço o espaço, entrada, consumação etc.) e só então pedindo os dados que faltam, na MESMA mensagem; NÃO apague o que você ia responder nem reenvie só o pedido de dados. Em NENHUM caso mencione esta instrução, peça desculpa, diga que está "corrigindo", nem comente que a data está/não está definida — o cliente não vê esta mensagem.' },
        ];
        continue;
      }
      // anunciou criar/alterar/cancelar sem nenhuma ferramenta ok? 1 chance de corrigir
      if (!acted && !corrected && CLAIM_RE.test(reply)) {
        corrected = true;
        messages = [...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: '[sistema] Você anunciou uma ação (reserva criada/alterada/cancelada) mas NENHUMA ferramenta retornou ok:true neste turno. Execute agora a ferramenta correta (buscar_reservas antes, se precisar do reservaId) e responda de novo. Se não era uma ação, reescreva sem afirmar que algo foi feito.' },
        ];
        continue;
      }
      return finish(reply);
    }

    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      toolsUsadas.push(block.name);
      if (block.name === 'chamar_humano') handoff = true;
      if (block.name === 'consultar_disponibilidade') conv.dispoEm = new Date().toISOString();
      const result = await runTool(block.name, block.input, ctx);
      if (result?.ok === true && ['registrar_reserva', 'alterar_reserva', 'cancelar_reserva'].includes(block.name)) {
        acted = true;
        if (block.name === 'registrar_reserva') registrouData = block.input?.data || '';
        if (block.name === 'cancelar_reserva') cancelou = true;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages = [...messages, { role: 'assistant', content: resp.content }, { role: 'user', content: toolResults }];
  }

  const reply = 'Opa, deu um nó aqui do meu lado 😅 Já chamei alguém do time pra te responder por aqui!';
  conv.status = 'humano';
  await runTool('chamar_humano', { motivo: 'loop de ferramentas excedido' }, ctx);
  conv.messages.push({ role: 'assistant', content: reply });
  return { reply, usage, handoff: true, reservou: false, negociou: true };
}
