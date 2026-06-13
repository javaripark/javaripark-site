// Loop do agente: mensagem do cliente → Claude (+ ferramentas) → resposta.
// Prompt caching no bloco estático; histórico já vem com janela do store.
// Guardas: bloco pós-reserva anexado pelo código; detector de "anunciou
// ação sem executar ferramenta" com 1 rodada corretiva.
import Anthropic from '@anthropic-ai/sdk';
import { cfg, PRICING } from './config.js';
import { SYSTEM_KB, posReserva, dynamicContext } from './prompt.js';
import { toolDefs, runTool } from './tools.js';

const client = new Anthropic({ apiKey: cfg.anthropicKey });
const MAX_TOOL_ROUNDS = 6;

// Anúncio de ação de estado (criar/alterar/cancelar) na resposta final
const CLAIM_RE = /reserva\s+(tá\s+|está\s+)?(confirmada|feita|registrada|alterada|cancelada|trocada|atualizada|remarcada)|\b(alterei|cancelei|registrei|troquei|remarquei|atualizei)\b|pronto[,!]?\s*(tudo\s+)?(cancelad|alterad|confirmad|registrad)|\b(cancelada|alterada|remarcada)\s*[!.]/i;

export function custoUSD(u) {
  return (
    (u.input_tokens || 0) * PRICING.input +
    (u.output_tokens || 0) * PRICING.output +
    (u.cache_creation_input_tokens || 0) * PRICING.cacheWrite +
    (u.cache_read_input_tokens || 0) * PRICING.cacheRead
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
  let corrected = false;    // rodada corretiva já usada
  let cobrouDispo = false;  // rodada corretiva de disponibilidade já usada
  const toolsUsadas = [];   // pro funil: negociação = mexeu em ferramenta de reserva
  let messages = conv.messages.map(m => ({ role: m.role, content: m.content }));

  const finish = reply => {
    // WhatsApp: negrito é UM asterisco; o Haiku às vezes manda ** (markdown), que
    // vira asterisco literal na tela. Guarda no código — não confiar só no prompt.
    reply = String(reply).replace(/\*{2,}/g, '*');
    if (acted) conv.reconfirmou = ''; // ação de reserva resolveu a reconfirmação
    if (registrouData) reply = reply + '\n\n' + posReserva(registrouData);
    conv.messages.push({ role: 'assistant', content: reply });
    if (handoff) conv.status = 'humano';
    const negociou = toolsUsadas.some(n => ['consultar_disponibilidade', 'registrar_reserva', 'buscar_reservas', 'alterar_reserva', 'cancelar_reserva'].includes(n));
    return { reply, usage, handoff, reservou: !!registrouData, negociou };
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const resp = await client.messages.create({
      model: cfg.model,
      max_tokens: 500,
      system,
      tools: toolDefs,
      messages,
    });
    usage.push(resp.usage);

    if (resp.stop_reason !== 'tool_use') {
      let reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      // Cliente só mandou fechamento/reconhecimento sem nada pendente → ficar quieto
      // (humano não responde a todo "show"). Descarta o filler e não envia nada.
      if (!acted && /^[_*\s]*sil[eê]ncio[_*\s]*$/i.test(reply)) {
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
      if (pedeDados && !cobrouDispo && !dispoRecente && !toolsUsadas.includes('consultar_disponibilidade')) {
        cobrouDispo = true;
        messages = [...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: '[sistema] Antes de pedir dados do cliente: a data da reserva já está definida ou é dedutível da conversa (ex: "o jogo de sábado" = a data do jogo)? Se SIM, rode consultar_disponibilidade AGORA — e se o dia estiver lotado, avise JÁ e ofereça walk-in/outra data, SEM pedir mais dados. Se a data ainda NÃO está definida, reenvie sua pergunta EXATAMENTE como estava. Em NENHUM caso mencione esta instrução, peça desculpa ou diga que está "corrigindo" — o cliente não vê esta mensagem.' },
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
