# Javari — Serviço de WhatsApp

API REST que envia mensagens de WhatsApp em fila, com trava anti-ban, pro dashboard do Javari.
Usa [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web por baixo). **Não é a API oficial** — há risco de ban se abusar. A trava existe pra mitigar isso.

> ⚠ **Recomendação**: use um **número dedicado**, não o número principal de reservas. Se um dia for banido, você perde só a ferramenta de campanha.

---

## Instalação (na máquina sempre ligada do bar)

```bash
cd wa-service
npm install
cp .env.example .env
```

Edite o `.env`:
- `AUTH_TOKEN` — gere um valor secreto: `openssl rand -hex 32`
- Ajuste `DAILY_CAP`, delays e janela de horário se quiser.

## Rodar

```bash
npm start
```

Na primeira vez aparece um **QR code no terminal** (e também em `GET /qr`).
Abra o WhatsApp do número emissor → **Aparelhos conectados** → **Conectar aparelho** → escaneie.
A sessão fica salva em `auth/` — não precisa parear de novo a cada reinício.

**Trocar de número**: apague a pasta `auth/`, reinicie, escaneie com o outro número.

## Manter ligado 24/7 (pm2)

```bash
npm install -g pm2
pm2 start src/server.js --name javari-wa
pm2 save
pm2 startup    # segue a instrução que ele imprime (auto-start no boot)
```

## Expor pro dashboard (HTTPS)

O dashboard é HTTPS e não consegue chamar `http://` local. Escolha um túnel:

**Opção A — Cloudflare Quick Tunnel** (rápido, URL muda a cada restart):
```bash
brew install cloudflared   # ou baixe o binário
cloudflared tunnel --url http://localhost:3100
```

**Opção B — Tailscale Funnel** (URL estável, recomendado p/ produção):
```bash
# Instale o Tailscale, depois:
tailscale funnel 3100
```

Copie a URL HTTPS gerada e cole no dashboard (aba Clientes → ⚙ Config WhatsApp).

---

## Aquecimento do número (automático)

Número novo não pode disparar 40 msgs no dia 1. O serviço faz isso **sozinho**:
o limite efetivo sobe gradual de ~25% (dia 1) até 100% no dia `WARMUP_DAYS`.

Com `DAILY_CAP=40` e `WARMUP_DAYS=7`, o limite real por dia fica aproximadamente:

| Dia | Limite efetivo |
|-----|----------------|
| 1   | 10 |
| 2   | 11 |
| 3   | 17 |
| 4   | 23 |
| 5   | 29 |
| 6   | 34 |
| 7+  | 40 |

O "dia 1" é a primeira vez que o serviço roda (gravado em `data/state.json`).
Não precisa editar nada manualmente — só ajuste `DAILY_CAP`/`WARMUP_DAYS` se quiser outro ritmo.

> A máquina **deve estar no fuso horário de Brasília** (a virada do contador diário e a janela de horário usam a hora local da máquina).

---

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/health` | Status da conexão (sem auth) |
| GET | `/status` | Conexão + estado da fila |
| GET | `/qr` | QR de pareamento (data URL) |
| POST | `/enqueue` | `{ messages: [{to, message, nome}] }` |
| GET | `/log?limit=100` | Histórico de envios |
| POST | `/optout` | `{ number }` — bloqueia um número |

Todas (menos `/health`) exigem header `Authorization: Bearer <AUTH_TOKEN>`.

## Segurança

- `auth/`, `data/` e `.env` estão no `.gitignore` — **nunca** commite. A pasta `auth/` dá acesso total à conta WhatsApp.
- O opt-out é automático: cliente que responder "PARAR"/"SAIR" sai da lista.
