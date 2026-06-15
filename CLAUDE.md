# CLAUDE.md — JAVARI PARK

> Leia ANTES de mexer em qualquer coisa. Este arquivo existe pra que nenhuma sessão comece do zero
> nem repita erros já cometidos. As regras gerais de trabalho com o René estão no CLAUDE.md user-level
> (`~/.claude/CLAUDE.md`) — este aqui é o específico do projeto.

---

## 0. REGRA Nº 1 — FATOS DA EMPRESA NÃO SE INVENTAM. NUNCA.

O René já deu **um caminhão de informações** sobre a empresa. Está tudo registrado. Em empresa
não existe "deve ser assim" — existem os fatos, e os fatos **já foram dados**.

**Protocolo obrigatório quando precisar de um fato de negócio** (horário, preço, regra, política):

1. Procurar em `wa-bot/src/prompt.js` (SYSTEM_KB) → é o cânone dos fatos da casa.
2. Não achou? Procurar na memória do projeto e no histórico de conversas/transcripts.
3. Não achou MESMO? **PERGUNTAR ao René** — pergunta numerada, curta, fácil de responder.
4. **PROIBIDO**: espelhar de um caso "parecido", arredondar, deduzir, preencher com plausível.
   Plausível ≠ verdadeiro. Se o fato não foi dado, ele NÃO EXISTE até o René dizer.

O bot tem a mesma regra (REGRA DE OURO no prompt): o que não está literalmente no prompt nem
veio de ferramenta → `chamar_humano`. O assistente que edita o bot segue a regra equivalente:
o que o René não disse → pergunta pro René.

**Incidente que motivou esta regra (10/06/2026):** o assistente inventou "horários de retenção
de mesa em dia de jogo" (18h30 pro 13/6, 21h pro 19/6) espelhando uma exceção que o René tinha
dado só pro 24/6. **Não existe regra de retenção.** A regra real é só uma: horário-limite de
chegada (sáb 16h, dom 14h, qua–sex 20h); não chegou ao menos 1 pessoa até lá → perde a mesa,
ponto. Não tem outra variável. O René teve que pegar o erro na mão.

---

## 1. O que é este projeto

**Javari StrEat Park** — bar e quintal de eventos na Mooca/SP (Rua Javari, 112). Público
majoritariamente feminino, vibe de celebração. Instagram @javaripark · javaripark.com.br.

| Pasta | O que é | Como publica |
|---|---|---|
| `public/` | Site estático + painel admin (`public/admin/*.html`) | `git push` → GitHub Pages (workflow `deploy.yml`, gera `version.json`) |
| `wa-bot/` | **Cérebro** do atendente WhatsApp (Claude Haiku 4.5 + tool use) | roda local, importado pelo wa-service; live = `pm2 restart` |
| `wa-service/` | **Transporte** WhatsApp (Baileys, caminho NÃO-oficial) + fila de envio ativo + bot reativo | pm2 (`javari-wa`) no Mac do René |
| `functions/` | Cloud Functions **LEGADAS** — `wabot` e `resgate` foram DELETADAS da nuvem | não usar |

**Firebase**: projeto `central-de-reservas-jsp`. Firestore com base path
`artifacts/central-de-reservas-jsp/public/data/{collection}`. Rules fechadas: só
`admin@javaripark.com.br` escreve. O bot local autentica com `ADMIN_EMAIL`+`ADMIN_PASSWORD`
(em `wa-bot/.env`).

---

## 2. O atendente WhatsApp (estado: LIVE)

**Live desde 10/06/2026 no número oficial 551120811544**, via **Baileys (não-oficial)** —
decisão consciente do René: grátis, mantém o app + 4 anos de histórico, aceitando risco de ban
com trava anti-ban (fila com delay aleatório, cap diário, janela de horário, aquecimento).
O caminho oficial (Cloud API) foi descartado: coexistência exige BSP pago e reconfirmação
ativa cairia em template de marketing (~US$0,50/msg).

### Anatomia

- `wa-bot/src/prompt.js` — **SYSTEM_KB** (fatos da casa, cacheado) + `dynamicContext()` (data/calendário
  SP injetado — o LLM NUNCA calcula data) + `posReserva(dataISO)` (bloco fixo pós-reserva; dias com
  exceção em `EXCECOES_DIA` trocam o bloco de chegada genérico pelo aviso do dia).
- `wa-bot/src/brain.js` — loop do agente (`atender`). Guardas no CÓDIGO (não confiar só no prompt):
  - `CLAIM_RE`: anunciou criar/alterar/cancelar sem `ok:true` → 1 rodada corretiva forçada.
  - `__SILENCIO__`: cliente manda fechamento ("show", "ok", "boa noite") sem nada pendente → o bot
    responde o token e o código **não envia nada** (silêncio = comportamento humano).
  - Reconfirmação: `conv.reconfirmou` (timestamp) mantém contexto por **12h** — cliente que recebeu
    reconfirmação JÁ TEM reserva; nunca oferecer "fazer uma reserva". Limpa ao expirar ou quando
    uma ferramenta de reserva roda.
- `wa-bot/src/tools.js` — 7 ferramentas. Validações de negócio espelhadas do admin (seg/ter fechado,
  1 reserva/setor/data, 1 reserva/número/dia, filho 1B-9B só com pai ocupado, Extras = só humano,
  Bus 10-40 pessoas, cutoff de reserva same-day = 2h antes de abrir). Setores: collection `setores`
  (cache 5min + fallback hardcoded). `TOLERANCIA_EXCECAO` deve ficar **alinhada com `EXCECOES_DIA`**
  do prompt.js — são dois espelhos do mesmo fato.
- `wa-service/src/agent.js` — recebe do Baileys, resolve **LID** (`remoteJidAlt` → `getPNForLID`),
  debounce 4s pra mensagens picadas, **modo recuperação** (backlog offline: responde espaçado 25s
  com "desculpa a demora", ignora >12h e sync de histórico), trava `BOT_MODE` (test = só responde
  `TEST_NUMBERS`), handoff avisa o admin (`ADMIN_PHONE`) via mensagem.
- `wa-service/src/queue.js` — fila de envio ATIVO (reconfirmação/campanha): delay 45-120s, cap diário
  40 c/ aquecimento 7d, janela 11-22h, opt-out por palavra. Item com `reconfirm:true` marca
  `conv.reconfirmou` ao enviar (fecha o ciclo com o brain).
- Painel admin → wa-service local via **Tailscale Funnel**
  (`https://macbook-pro-de-rene.tailf78ede.ts.net` → `localhost:3100`). PIN de envio: ver `.env`.

### Princípios de produto (decisões do René — não "melhorar" sem ele)

- **Nunca negar cliente.** Casa lotada → convida a vir sem reserva ("a equipe SEMPRE dá um jeito").
  Lotação NUNCA vira humano.
- Reserva garante **até 20 sentados**, sempre. Grupo maior: registra o número real (pra equipe
  dimensionar), promete 20 sentados, resto em pé — é a vibe da casa. **Não existe teto de negócio**
  pro tamanho do grupo (o 500 em tools.js é só guarda técnica anti-typo). Confirmado pelo René 11/06.
- Cozinha trabalha no mesmo horário da casa. Não existe couvert (só entrada, não consumível).
  Tolerância de chegada do Bus = mesma das mesas. Nome de reserva é alterável pelo bot. (René, 11/06)
- **Horário de chegada NÃO é dado de reserva.** Nunca perguntar "que horas você chega". Basta 1
  pessoa do grupo dentro da tolerância. Não existe regra especial de dia de jogo (ver Incidentes).
- Setor: o bot **escolhe pela vibe e reserva direto**, avisando que dá pra trocar (Mapa de Assentos
  em /regras). Tentamos "sempre perguntar" → Haiku ficou instável; o híbrido é decisão validada.
- Encaminhamentos (banda/artista → beacons.ai/javaripark · fornecedor → oi@javaripark.com.br) são
  **autoatendimento**: o bot responde com o link, NÃO chama humano.
- Reservar pro mesmo dia: até 2h antes de abrir. Seg/ter: fechado (só evento especial via humano).

---

## 3. Onde cada fato mora (fontes de verdade)

| Fato | Fonte ÚNICA | Cuidado |
|---|---|---|
| Horários, preços, regras da casa | `wa-bot/src/prompt.js` (SYSTEM_KB) | NÃO duplicar em outro lugar (deriva) |
| Exceções por data (ex: 24/6 jogo) | `EXCECOES_DIA` (prompt.js) **e** `TOLERANCIA_EXCECAO` (tools.js) | editar os DOIS juntos |
| Setores, capacidade, pai/filho | collection `setores` | fallback em tools.js só pra pane |
| Programação/atrações | collection `agenda` | bot lê via consultar_agenda; nunca inventa |
| Reservas | collection `reservas` | campos: `Data, Setor, Nome, Sobrenome, 'Quantidade de Pessoas', Whatsapp, Observacoes, Origem, ViaBot, CriadoEm` |
| Conversas do bot | `wa_atendimento/{telefone}` | thread inteiro em `HistoricoJson` |
| Custo de API | `wa_usage` (1 doc/turno) + `CreditoUSD` manual em `wa_config/main` | saldo OFICIAL = console.anthropic.com |
| Alertas de handoff | `wa_alertas` | botão "Resolver" só marca `Resolvido:true` (não apaga) |
| Cancelamentos | `wa_cancelamentos` (cópia antes de deletar) | |
| Segredos | `wa-bot/.env`, `wa-service/.env` (gitignorados) | NUNCA imprimir em chat/commit |

---

## 4. Runbook (operação)

```bash
# o bot vive no pm2 — QUALQUER edit em wa-bot/src ou wa-service/src exige restart:
cd "/Users/rene/Downloads/JAVARI PARK/wa-service" && pm2 restart javari-wa

pm2 logs javari-wa            # logs ao vivo
pm2 stop javari-wa            # DESLIGA o bot (para de responder na hora)
curl -s localhost:3100/health # {ok, connected, me:"551120811544"} = saudável
```

- `ecosystem.config.cjs` existe por causa do espaço em "JAVARI PARK" (pm2 com path puro quebra).
- Auto-start no boot via launchd. O Mac precisa ficar **ligado e sem dormir** (lock screen ok).
- `BOT_MODE` em `wa-service/.env`: `live` (atual) ou `test` (só responde `TEST_NUMBERS`).
  A trava vale também pro envio ativo da fila.
- Bot responde 24/7; só envio ATIVO tem janela (fila 11-22h).
- Painel (GitHub Pages) muda com `git push`; o bot local NÃO — são deploys independentes.

### Sync do Consumer POS (dado do dashboard)

- O dado vem do backup Firebird no Google Drive (`<dia-da-semana>.fbconsumer`, ex: `domingo.fbconsumer`),
  extraído por `scripts/sync-consumer.py` no GitHub Actions (`sync-consumer.yml`) → commita `public/data/*.json`.
- **O cron do GitHub Actions é best-effort e às vezes NÃO dispara** (dropou os 2 runs de 15/06/2026 →
  domingo 14/06 não entrou). Por isso há um **gatilho local confiável** no Mac (sempre ligado):
  - LaunchAgent `~/Library/LaunchAgents/com.javari.sync-consumer.plist` roda **08:00 BRT** todo dia.
  - Chama `~/.javari/trigger-sync.sh` (cópia operacional — o launchd **não** executa script dentro de
    `~/Downloads`, TCC bloqueia). A cópia **canônica/versionada** é `scripts/trigger-sync.sh`; ao editar,
    `cp scripts/trigger-sync.sh ~/.javari/trigger-sync.sh`.
  - Log: `~/Library/Logs/javari-sync-trigger.log`. Disparo manual: `gh workflow run sync-consumer.yml`.
  - Recarregar agent: `launchctl bootout gui/$(id -u)/com.javari.sync-consumer; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.javari.sync-consumer.plist`.
  - Os 2 crons do GitHub (04h/06h BRT) continuam como redundância secundária.

---

## 5. Testes — disciplina obrigatória

1. **Todo teste via `atender()` gasta API real** (chave do René) e **NÃO aparece** no painel
   (pula a camada que grava `wa_usage`). Então: somar `custoUSD(usage)`, **avisar o René do valor**
   e lançar doc de ajuste em `wa_usage` (`Telefone:'AJUSTE-TESTES-CLAUDE'`, `Via:'ajuste-manual'`).
2. Número fake para testes: **5500000000099**. JAMAIS número real.
3. **Limpar depois**: `reservas`, `wa_atendimento`, `wa_alertas` do número fake. Teste que cria
   alerta de handoff suja a fila da equipe.
4. Custo típico/turno: US$0,003–0,011 (o caro é o cache-write do system, ~US$0,01, 1× por processo).
5. Suites prontas: `npm run audit` (21 cenários, ~R$0,80 — **avisar antes de rodar**),
   `npm run chat` (REPL local), `test/fala.mjs` (persona avulsa).
6. Mudou prompt/brain → testar os cenários AFETADOS de verdade (atender real) antes de declarar
   pronto, e **lembrar do pm2 restart** — sem restart o live continua com o código velho.

---

## 6. Git

- Commits em pt-BR, prefixo da área: `wa-bot:`, `wa-service:`, `reservas:`, `site:`.
- Terminar com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (ou modelo vigente).
- Se o René estiver usando o GitHub em outro projeto: **stage e segurar o push** até ele liberar.
- NUNCA commitar: `.env`, `wa-service/auth/` (sessão Baileys!), `wa-service/data/`, backups com
  PII, CSVs de anúncio, certificados `.crt/.key`.

---

## 7. Como trabalhar com o René (específico deste projeto)

- Ele dá os fatos **uma vez** e espera que virem registro permanente (prompt/memória/este arquivo).
  Fazer ele repetir o beabá = falha grave.
- Ele quer **solução robusta**, não remendo. Antes de corrigir sintoma, achar a causa (ex: bot
  pedia confirmação à toa → a causa era a descrição da ferramenta contradizendo o prompt).
- Reportar com **evidência real** (transcript do teste, output, custo), nunca "funcionou".
- Quando ele aponta 1 bug, auditar o REDOR (a mesma classe de erro em outros lugares).
- Ele deleta mensagem ruim do bot no WhatsApp na mão — cada resposta ruim em produção tem custo
  real de imagem. Em dúvida entre responder mal e chamar humano, o bot chama humano.
- Bugs em produção: ler a conversa REAL no Firestore (`wa_atendimento`, campo `HistoricoJson`)
  antes de corrigir qualquer coisa — corrigir no chute é proibido.

---

## 8. Histórico de incidentes (lições queimadas — não repetir)

| Data | O que houve | Lição/fix |
|---|---|---|
| 10/06 | Bot disse "entrada grátis até 16h" no sábado (real: 14h30; 16h já é R$25) | Janelas grátis explícitas no prompt (linha ⚠). Bot comprimia os 3 níveis de preço |
| 10/06 | **Assistente INVENTOU horários de retenção em dia de jogo** | Ver Regra Nº1. Não existe retenção; só o corte de chegada normal |
| 10/06 | Bot perguntava "que horas você quer chegar" na reserva | Proibido no FLUXO; horário de chegada não é dado de reserva |
| 10/06 | Bot respondia parágrafo a todo "show"/"boa noite" | Mecanismo `__SILENCIO__` (prompt + brain) |
| 10/06 | Cliente de reconfirmação recebeu "quer fazer uma reserva?" | `conv.reconfirmou` agora dura 12h e proíbe oferta de reserva nova |
| 10/06 | Banda pedindo pra tocar → bot chamou humano em vez do link | Encaminhamentos = autoatendimento explícito (beacons.ai/javaripark) |
| 10/06 | Resumo do bot dizia "mesa guardada até 20h" contradizendo o bloco automático | Proibido listar horário de chegada no resumo (bloco automático cuida) |
| (antes) | "Sempre perguntar setor" deixou o Haiku instável (~50% flaky) | Híbrido validado: bot escolhe, reserva, avisa que dá pra trocar |
| (antes) | pm2 quebrou com espaço no path "JAVARI PARK" | `ecosystem.config.cjs` |
| (antes) | Mensagens chegavam como `@lid` e eram ignoradas | `resolvePhone` (remoteJidAlt → getPNForLID) |
