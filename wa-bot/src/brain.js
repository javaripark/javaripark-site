// Loop do agente: mensagem do cliente → Claude (+ ferramentas) → resposta.
// Prompt caching no bloco estático; histórico já vem com janela do store.
import Anthropic from '@anthropic-ai/sdk';
import { cfg, PRICING } from './config.js';
import { SYSTEM_KB, dynamicContext } from './prompt.js';
import { toolDefs, runTool } from './tools.js';

const client = new Anthropic({ apiKey: cfg.anthropicKey });
const MAX_TOOL_ROUNDS = 5;

export function custoUSD(u) {
  return (
    (u.input_tokens || 0) * PRICING.input +
    (u.output_tokens || 0) * PRICING.output +
    (u.cache_creation_input_tokens || 0) * PRICING.cacheWrite +
    (u.cache_read_input_tokens || 0) * PRICING.cacheRead
  ) / 1e6;
}

// conv: {telefone, messages, nomePerfil, origem, status, convDoc?}
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
  let messages = conv.messages.map(m => ({ role: m.role, content: m.content }));

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
      const reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      conv.messages.push({ role: 'assistant', content: reply });
      if (handoff) conv.status = 'humano';
      return { reply, usage, handoff };
    }

    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'chamar_humano') handoff = true;
      const result = await runTool(block.name, block.input, ctx);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages = [...messages, { role: 'assistant', content: resp.content }, { role: 'user', content: toolResults }];
  }

  const reply = 'Opa, deu um nó aqui do meu lado 😅 Já chamei alguém do time pra te responder por aqui!';
  conv.messages.push({ role: 'assistant', content: reply });
  conv.status = 'humano';
  await runTool('chamar_humano', { motivo: 'loop de ferramentas excedido' }, ctx);
  return { reply, usage, handoff: true };
}
