# Node Exporter Metrics Stack

This stack provides:
- `prometheus` scraping `node-exporter`
- `influxdb` storing Prometheus data via `remote_write`
- `daily-exporter` exporting previous UTC day data and pushing to GitHub (`exports/YYYY-MM-DD.json`)
- `backend` API exposing InfluxDB data over HTTP on `localhost:13001`
- `frontend` Grafana-like dashboard on `localhost:13002`

## Services and ports

- InfluxDB: `localhost:8086`
- Prometheus: `localhost:${PROMETHEUS_PORT:-19090}` (container still uses `9090`)
- Node Exporter: `localhost:9100`
- Backend API: `localhost:13001`
- Frontend: `localhost:13002`

## Environment

Copy `.env.example` to `.env` and fill required values:

- `GITHUB_REPO`
- `GITHUB_USERNAME`
- `GITHUB_TOKEN`
- `FRONTEND_GITHUB_RAW_BASE_URL` (example: `https://raw.githubusercontent.com/<owner>/<repo>/main/exports`)

Optional:
- `PROMETHEUS_PORT` (defaults to `19090` to avoid `9090` conflicts)
- `FRONTEND_API_BASE_URL` (defaults to `https://deployment-data-api.reefz.cc`; set `http://localhost:13001` for local-only use)

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

## CORS

Backend allows cross-origin requests from:
- `https://deployment-data-api.reefz.cc`
- `http://localhost:13002`
- any `*.github.io` origin (for GitHub Pages frontend)

Configure in compose via `ALLOWED_ORIGINS` and `ALLOWED_ORIGIN_SUFFIXES` if needed.

## Frontend behavior

- Realtime data is fetched from backend (which reads InfluxDB).
- Historical data is fetched directly from GitHub raw JSON exports.
- If backend is inaccessible, UI shows `Server is down`.

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
