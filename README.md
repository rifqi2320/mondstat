# Node Exporter Metrics Stack

This stack provides:
- `prometheus` scraping `node-exporter`
- `daily-exporter` exporting previous UTC day data and pushing to GitHub (`exports/YYYY-MM-DD--<source-slug>.json`)
- `backend` API exposing Prometheus data over HTTP on `localhost:13001`
- `frontend` Grafana-like dashboard on `localhost:13002`

## Services and ports

- Prometheus: `localhost:${PROMETHEUS_PORT:-19090}` (container still uses `9090`)
- Node Exporter: `localhost:9100`
- Backend API: `localhost:13001`
- Frontend: `localhost:13002`

## Environment

Copy `.env.example` to `.env` and fill required values:

- `GITHUB_REPO`
- `GITHUB_USERNAME`
- `GITHUB_TOKEN`
- `SOURCE_NAME` (human-readable host/source name, used in export filename slug)
- `FRONTEND_GITHUB_RAW_BASE_URL` (example: `https://raw.githubusercontent.com/<owner>/<repo>/main/exports`)

Optional:
- `PROMETHEUS_PORT` (defaults to `19090` to avoid `9090` conflicts)
- `FRONTEND_API_BASE_URL` (fallback default if host list is unavailable)

## Start

```bash
docker compose up -d --build
```

## Backend API endpoints

- `GET /api/health`
- `GET /api/metrics?prefix=node_&limit=1000`
- `GET /api/metrics/:metric/latest?lookback=30m`
- `GET /api/metrics/:metric/history?from=<ISO>&to=<ISO>&interval=30s`
- `GET /api/dashboard/node-latest?prefix=node_&limit=100&lookback=15m`
- `GET /api/dashboard/system?lookback=1h&interval=30s`

## CORS

Backend allows cross-origin requests from:
- `https://deployment-data-api.reefz.cc`
- `http://localhost:13002`
- any `*.github.io` origin (for GitHub Pages frontend)

Configure in compose via `ALLOWED_ORIGINS` and `ALLOWED_ORIGIN_SUFFIXES` if needed.

## Frontend behavior

- Host list is loaded from committed file: `frontend/hosts.json`
  - each host entry stores only: `name` and `apiUrl`
  - sidebar lets you switch active host/API in realtime
- Time range selector: `1h`, `5h`, `12h`, `24h`, `3d`, `7d`, `15d`, `30d`
- No metric search UI; dashboard is fixed to:
  - CPU usage %
  - Memory usage %
  - Disk I/O usage %
  - Network ingress bandwidth (Mbps)
  - Network egress bandwidth (Mbps)
- Realtime data is fetched from backend via `/api/dashboard/system` (source: Prometheus).
- Historical data is fetched from GitHub raw JSON exports.
  - for ranges above 24h, frontend fetches multiple daily export files and merges them.
  - frontend first looks for host-specific files: `YYYY-MM-DD--<host-slug>.json`
  - then falls back to legacy: `YYYY-MM-DD.json`
- If backend is inaccessible, UI shows `Server is down`.

## Add A Host

1. Add host entry to `frontend/hosts.json`:

```json
{
  "hosts": [
    {
      "name": "Reefz Server",
      "apiUrl": "https://deployment-data-api.reefz.cc"
    },
    {
      "name": "Singapore Node",
      "apiUrl": "https://deployment-data-api-sg.example.com"
    }
  ]
}
```

2. Each host stores only:
   - `name`: readable host name shown in sidebar
   - `apiUrl`: backend URL for that host
3. On that host deployment, set `SOURCE_NAME` to the same readable name.
4. `daily-exporter` will write files as:
   - `exports/YYYY-MM-DD--<source-slug>.json`
5. Slug rule:
   - lowercase, non-alphanumeric replaced by `-`, trimmed (`Reefz Server` -> `reefz-server`)

## GitHub Pages deployment

Frontend is automatically deployed to GitHub Pages via:
- [deploy-pages.yml](/home/rifqi/mondstat/.github/workflows/deploy-pages.yml)

Steps:
1. Push this repository to GitHub (branch `main`).
2. In GitHub repo settings, open `Pages`.
3. Set `Source` to `GitHub Actions`.
4. Push any change under `frontend/` or run the workflow manually.
5. Open `https://<your-user>.github.io/<repo>/`.

Notes:
- Frontend API default is `https://deployment-data-api.reefz.cc`.
- If `FRONTEND_GITHUB_RAW_BASE_URL` is empty, frontend auto-derives raw history URL from GitHub Pages URL.
