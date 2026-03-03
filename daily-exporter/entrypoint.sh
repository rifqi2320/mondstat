#!/usr/bin/env bash
set -euo pipefail

: "${EXPORT_CRON:=0 0 * * *}"
: "${RUN_ON_STARTUP:=true}"

mkdir -p /var/log/cron
printf '%s /app/export-and-push.sh >> /var/log/cron/cron.log 2>&1\n' "${EXPORT_CRON}" > /etc/crontabs/root

if [[ "${RUN_ON_STARTUP}" == "true" ]]; then
  /app/export-and-push.sh || true
fi

exec crond -f -l 8
