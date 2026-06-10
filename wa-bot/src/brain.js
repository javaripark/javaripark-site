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
const CLAIM_RE = /reserva\s+(tá\s+|está\s+)?(confirmada|feita|registrada|alterada|cancelada|trocada|atualizada|remarcada)|alterei|cancelei|registrei|troquei|remarquei|atualizei/i;

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

  const system = [
    { type: 'text', text: SYSTEM_KB, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicContext() + (conv.nomePerfil ? ` Nome no perfil do WhatsApp do cliente: ${conv.nomePerfil}.` : '') },
  ];

  const ctx = { telefone: conv.telefone, nomePerfil: conv.nomePerfil, origem: conv.origem, convDoc: null };
  const usage = [];
  let handoff = false;
  let acted = false;        // alguma ferramenta de estado retornou ok:true neste turno
  let registrouData = null; // data da reserva criada neste turno → anexa bloco pós-reserva
  let corrected = false;    // rodada corretiva já usada
  let messages = conv.messages.map(m => ({ role: m.role, content: m.content }));

  const finish = reply => {
    if (registrouData) reply = reply + '\n\n' + posReserva(registrouData);
    conv.messages.push({ role: 'assistant', content: reply });
    if (handoff) conv.status = 'humano';
    return { reply, usage, handoff };
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
      // nunca deixar o cliente no vácuo (ex.: handoff sem texto)
      if (!reply) reply = handoff
        ? 'Já chamei alguém do time pra te ajudar por aqui — respondem rapidinho! 😉'
        : 'Opa, me perdi aqui 😅 Pode repetir, por favor?';
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
      if (block.name === 'chamar_humano') handoff = true;
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
  return { reply, usage, handoff: true };
}
