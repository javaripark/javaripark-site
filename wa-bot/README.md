# Javari — Atendente Virtual de WhatsApp (wa-bot)

Atendimento autônomo no WhatsApp oficial via **Cloud API da Meta** (API oficial, sem risco de ban) + **Claude** (Haiku). Tira dúvidas com base nas regras da casa, estimula e **registra reservas direto no Firestore** (aparecem ao vivo na Central de Reservas).

- Origem automática: conversa vinda de anúncio (CTWA) entra com `Origem: 'anuncio'` — sem flag manual.
- Reservas gravadas com `ViaBot: true` e as mesmas validações do admin (seg/ter fechado, 1 setor por data, re-checagem de conflito na gravação).
- Cliente também **cancela e altera** a própria reserva pelo chat (o bot localiza pelas reservas do número do WhatsApp; só mexe nas do próprio remetente). Cancelamentos ficam auditados em `wa_cancelamentos`; alterações marcam `AlteradoVia: 'bot'`.
- Handoff: assuntos fora do escopo (Bus Lounge, orçamentos, cancelamentos, reclamações) pausam o bot na conversa (`status: humano`) e geram alerta em `wa_alertas`. Você responde normal **pelo app do celular** (coexistência). O modo humano expira sozinho após 24h sem mensagens.

## 1. Maturar o prompt (sem WhatsApp)

```bash
cd wa-bot
npm install
cp .env.example .env       # preencha ANTHROPIC_API_KEY
npm run chat
```

Simulador no terminal: você faz o papel do cliente, vê custo/tokens por turno (`/tokens` mostra o acumulado). O prompt vive em `src/prompt.js` (`SYSTEM_KB`) — edite e rode de novo. A conversa de teste usa o telefone fake `5500999990000` no Firestore; reservas de teste criadas por ela devem ser apagadas na Central.

## 2. Configuração na Meta (uma vez)

Pré-requisito: **verificação do negócio** concluída no Business Manager (Central de segurança → Verificado).

1. **Criar app**: developers.facebook.com → Criar app → tipo **Business** → adicionar produto **WhatsApp**.
2. **Conectar o número com coexistência**: no produto WhatsApp → Configuração da API → adicionar número → escolher **usar número existente do app WhatsApp Business** → escanear o QR com o app do celular (igual parear aparelho). O app continua funcionando.
3. **Token permanente**: Business Manager → Usuários do sistema → (o mesmo system user dos ads serve) → Gerar token com permissões `whatsapp_business_messaging` + `whatsapp_business_management`, atribuindo o app e a WABA aos ativos dele. Cole em `META_TOKEN`.
4. **IDs e segredo**: no painel do app → WhatsApp → Configuração da API → copie o **Phone number ID** (`META_PHONE_NUMBER_ID`). Em Configurações → Básico → **Chave Secreta do Aplicativo** (`META_APP_SECRET`).
5. **Webhook**: suba o serviço (passo 3), exponha a porta 3200 por HTTPS (Tailscale Funnel ou cloudflared, igual ao wa-service) e cadastre no painel: Webhooks → WhatsApp Business Account → URL `https://SEU-TUNEL/webhook` + o token de `META_VERIFY_TOKEN` → assinar o campo **messages**.

## 3. Produção: Firebase Functions (sem máquina ligada)

O serviço roda como Function no projeto `central-de-reservas-jsp` (plano Blaze, free tier cobre o volume):

```bash
firebase deploy --only functions --force
```

- **URL do webhook (fixa)**: `https://wabot-n7wdbwvdga-uc.a.run.app/webhook`
- Variáveis vêm do `wa-bot/.env` (aplicadas no deploy). `PORT` não pode existir no .env (reservada na nuvem).
- Invoker público de propósito: a segurança do webhook é a assinatura HMAC da Meta.
- Logs: `firebase functions:log` ou console do GCP.

(Modo local `npm start` continua existindo pra desenvolvimento, com túnel.)

## Custos

- Meta: **R$ 0** (categoria serviço — respostas na janela de 24h não são cobradas).
- Claude (Haiku 4.5, com prompt caching): ~R$ 0,01–0,03 por conversa típica. Configure um limite de gasto no console.anthropic.com.

## Decisões de arquitetura (token economy)

- Bloco estático do prompt com **prompt caching** (90% de desconto nas leituras).
- Histórico com janela de 20 mensagens; só o texto final de cada turno é persistido (tool calls intermediárias não inflam o histórico).
- `max_tokens: 500` — resposta de WhatsApp é curta por design.
- Schemas de ferramenta enxutos; resultados de ferramenta em JSON compacto.
