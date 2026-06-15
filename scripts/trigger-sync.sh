#!/bin/bash
# Dispara o sync do Consumer POS via GitHub Actions (workflow_dispatch).
# Existe porque o agendador (cron) do GitHub Actions é best-effort e às vezes
# NÃO dispara os runs agendados — então o dado do dia anterior não entra e
# ninguém percebe (caso domingo 14/06/2026). O Mac do René fica ligado 24/7
# (roda o bot no pm2), então um LaunchAgent local chama este script de manhã,
# garantindo o gatilho independente da fila do GitHub.
#
# IMPORTANTE: a cópia OPERACIONAL roda de ~/.javari/trigger-sync.sh — o launchd
# NÃO consegue executar script dentro de ~/Downloads (TCC bloqueia). Esta cópia
# no repo é a canônica/versionada; ao editar, recopie:
#   cp "scripts/trigger-sync.sh" ~/.javari/trigger-sync.sh
# Instalado via ~/Library/LaunchAgents/com.javari.sync-consumer.plist.

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="reneacastro/javaripark-site"
LOG="$HOME/Library/Logs/javari-sync-trigger.log"
ts() { date "+%Y-%m-%d %H:%M:%S %Z"; }

echo "[$(ts)] disparando sync-consumer.yml ($REPO)..." >> "$LOG"
if out=$(gh workflow run sync-consumer.yml -R "$REPO" 2>&1); then
  echo "[$(ts)] OK ${out:-disparado}" >> "$LOG"
else
  echo "[$(ts)] FALHOU: $out" >> "$LOG"
  exit 1
fi
