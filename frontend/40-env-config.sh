#!/bin/sh
set -eu

: "${FRONTEND_API_BASE_URL:=https://deployment-data-api.reefz.cc}"
: "${FRONTEND_GITHUB_RAW_BASE_URL:=}"
: "${FRONTEND_DEFAULT_PREFIX:=node_}"

envsubst '${FRONTEND_API_BASE_URL} ${FRONTEND_GITHUB_RAW_BASE_URL} ${FRONTEND_DEFAULT_PREFIX}' \
  < /usr/share/nginx/html/config.template.js \
  > /usr/share/nginx/html/config.js
