#!/usr/bin/env bash
set -euo pipefail

required_vars=(GITHUB_REPO GITHUB_USERNAME GITHUB_TOKEN PROMETHEUS_URL)
for var in "${required_vars[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing required environment variable: ${var}" >&2
    exit 1
  fi
done

: "${PROM_QUERY:={job=\"node-exporter\"}}"
: "${EXPORT_STEP:=5m}"
: "${WORK_DIR:=/data/repo}"
: "${OUTPUT_DIR:=exports}"
: "${EXPORT_BRANCH:=main}"
: "${SOURCE_NAME:=unknown-source}"
: "${GIT_AUTHOR_NAME:=prometheus-bot}"
: "${GIT_AUTHOR_EMAIL:=prometheus-bot@example.com}"

export_day="$(date -u -d 'yesterday' +%F)"
start_time="${export_day}T00:00:00Z"
end_time="${export_day}T23:59:59Z"

encoded_query="$(jq -rn --arg q "${PROM_QUERY}" '$q|@uri')"
api_url="${PROMETHEUS_URL%/}/api/v1/query_range?query=${encoded_query}&start=${start_time}&end=${end_time}&step=${EXPORT_STEP}"

tmp_result="$(mktemp)"
curl -fsS "${api_url}" -o "${tmp_result}"

if [[ "$(jq -r '.status' "${tmp_result}")" != "success" ]]; then
  echo "Prometheus API did not return success" >&2
  jq '.' "${tmp_result}" >&2
  exit 1
fi

case "${GITHUB_REPO}" in
  https://github.com/*)
    auth_repo_url="https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@${GITHUB_REPO#https://}"
    ;;
  git@github.com:*)
    repo_path="${GITHUB_REPO#git@github.com:}"
    auth_repo_url="https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${repo_path}"
    ;;
  github.com/*)
    auth_repo_url="https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@${GITHUB_REPO}"
    ;;
  *)
    auth_repo_url="${GITHUB_REPO}"
    ;;
esac

if [[ ! -d "${WORK_DIR}/.git" ]]; then
  rm -rf "${WORK_DIR}"
  git clone --branch "${EXPORT_BRANCH}" "${auth_repo_url}" "${WORK_DIR}"
else
  git -C "${WORK_DIR}" remote set-url origin "${auth_repo_url}"
  git -C "${WORK_DIR}" fetch origin "${EXPORT_BRANCH}"
  git -C "${WORK_DIR}" checkout "${EXPORT_BRANCH}"
  git -C "${WORK_DIR}" pull --ff-only origin "${EXPORT_BRANCH}"
fi

mkdir -p "${WORK_DIR}/${OUTPUT_DIR}"
source_slug="$(printf '%s' "${SOURCE_NAME}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
if [[ -z "${source_slug}" ]]; then
  source_slug="unknown-source"
fi

output_name="${export_day}--${source_slug}.json"
output_file="${WORK_DIR}/${OUTPUT_DIR}/${output_name}"

jq -n \
  --arg date "${export_day}" \
  --arg source_name "${SOURCE_NAME}" \
  --arg source_slug "${source_slug}" \
  --arg query "${PROM_QUERY}" \
  --arg start "${start_time}" \
  --arg end "${end_time}" \
  --slurpfile payload "${tmp_result}" \
  '{date: $date, source_name: $source_name, source_slug: $source_slug, query: $query, start: $start, end: $end, payload: $payload[0]}' > "${output_file}"

rm -f "${tmp_result}"

git -C "${WORK_DIR}" config user.name "${GIT_AUTHOR_NAME}"
git -C "${WORK_DIR}" config user.email "${GIT_AUTHOR_EMAIL}"

git -C "${WORK_DIR}" add "${OUTPUT_DIR}/${output_name}"

if git -C "${WORK_DIR}" diff --cached --quiet; then
  echo "No changes detected for ${export_day}; skipping commit."
  exit 0
fi

git -C "${WORK_DIR}" commit -m "chore: export prometheus data for ${export_day}"
git -C "${WORK_DIR}" push origin "${EXPORT_BRANCH}"
