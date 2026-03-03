'use strict';

const cfg = window.APP_CONFIG || {};
const API_BASE = (cfg.apiBaseUrl || 'https://deployment-data-api.reefz.cc').replace(/\/$/, '');
const GITHUB_RAW_BASE = (cfg.githubRawBaseUrl || guessGithubRawBase() || '').replace(/\/$/, '');
const DEFAULT_PREFIX = cfg.defaultPrefix || 'node_';

const metricPrefixInput = document.getElementById('metricPrefix');
const metricListEl = document.getElementById('metricList');
const metricCountEl = document.getElementById('metricCount');
const selectedMetricEl = document.getElementById('selectedMetric');
const latestRowsEl = document.getElementById('latestRows');
const latestSummaryEl = document.getElementById('latestSummary');
const serverStatusEl = document.getElementById('serverStatus');
const lastRefreshEl = document.getElementById('lastRefresh');
const historyDateEl = document.getElementById('historyDate');
const historyMessageEl = document.getElementById('historyMessage');
const realtimeEmptyEl = document.getElementById('realtimeEmpty');

let realtimeChart;
let historyChart;
let selectedMetric = null;
let serverUp = false;
let refreshTimer;

document.getElementById('reloadMetrics').addEventListener('click', () => {
  loadMetrics().catch(() => {});
});

document.getElementById('loadHistory').addEventListener('click', () => {
  loadHistory().catch(() => {});
});

async function boot() {
  metricPrefixInput.value = DEFAULT_PREFIX;
  historyDateEl.value = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

  await pingBackend();
  await loadMetrics();

  refreshTimer = setInterval(async () => {
    await pingBackend();

    if (serverUp && selectedMetric) {
      await loadRealtime(selectedMetric);
    }
  }, 15000);
}

boot().catch((error) => {
  setServerDown(error.message);
});

async function pingBackend() {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { headers: { Accept: 'application/json' } });

    if (!res.ok) {
      throw new Error(`Health check failed (${res.status})`);
    }

    const payload = await res.json();
    if (payload.status !== 'ok') {
      throw new Error(payload.error || 'Backend unhealthy');
    }

    setServerUp();
  } catch (error) {
    setServerDown(error.message);
  }
}

async function loadMetrics() {
  const prefix = metricPrefixInput.value.trim() || DEFAULT_PREFIX;
  const payload = await apiGet(`/api/metrics?prefix=${encodeURIComponent(prefix)}&limit=1000`);
  const metrics = payload.metrics || [];

  metricCountEl.textContent = `${metrics.length} metrics`;
  renderMetricList(metrics);

  if (!selectedMetric && metrics.length > 0) {
    await selectMetric(metrics[0]);
  }
}

function renderMetricList(metrics) {
  metricListEl.innerHTML = '';

  if (!metrics.length) {
    metricListEl.innerHTML = '<div class="muted" style="padding:8px;">No metrics found.</div>';
    return;
  }

  for (const metric of metrics) {
    const btn = document.createElement('button');
    btn.className = `metric-item${selectedMetric === metric ? ' active' : ''}`;
    btn.textContent = metric;
    btn.addEventListener('click', () => {
      selectMetric(metric).catch(() => {});
    });
    metricListEl.appendChild(btn);
  }
}

async function selectMetric(metric) {
  selectedMetric = metric;
  selectedMetricEl.textContent = metric;

  const metricButtons = metricListEl.querySelectorAll('.metric-item');
  for (const el of metricButtons) {
    el.classList.toggle('active', el.textContent === metric);
  }

  await loadRealtime(metric);
  await loadHistory();
}

async function loadRealtime(metric) {
  if (!metric) {
    return;
  }

  const now = new Date();
  const from = new Date(now.getTime() - 60 * 60 * 1000);

  const [latest, history] = await Promise.all([
    apiGet(`/api/metrics/${encodeURIComponent(metric)}/latest?lookback=30m`),
    apiGet(
      `/api/metrics/${encodeURIComponent(metric)}/history?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(now.toISOString())}&interval=30s`
    )
  ]);

  renderLatest(latest.series || []);
  renderRealtimeChart(history.series || []);
  lastRefreshEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function renderLatest(series) {
  latestRowsEl.innerHTML = '';

  if (!series.length) {
    latestSummaryEl.textContent = 'No fresh values for this metric.';
    return;
  }

  latestSummaryEl.textContent = `${series.length} active series in the last lookback window.`;

  for (const entry of series) {
    const point = entry.points[0];
    if (!point) {
      continue;
    }

    const tr = document.createElement('tr');

    const tags = Object.entries(entry.tags || {})
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');

    tr.innerHTML = `
      <td>${escapeHtml(tags || '-') }</td>
      <td>${escapeHtml(String(point.value))}</td>
      <td>${new Date(point.time).toLocaleString()}</td>
    `;

    latestRowsEl.appendChild(tr);
  }
}

function renderRealtimeChart(series) {
  const datasets = chartSeriesFromInflux(series, 20);

  if (realtimeChart) {
    realtimeChart.destroy();
  }

  if (!datasets.length) {
    realtimeEmptyEl.classList.remove('hidden');
    return;
  }

  realtimeEmptyEl.classList.add('hidden');
  const ctx = document.getElementById('realtimeChart');

  realtimeChart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: chartOptions('Realtime')
  });
}

async function loadHistory() {
  if (!selectedMetric) {
    historyMessageEl.textContent = 'Select a metric first.';
    return;
  }

  const date = historyDateEl.value;
  if (!date) {
    historyMessageEl.textContent = 'Pick a date first.';
    return;
  }

  if (!GITHUB_RAW_BASE) {
    historyMessageEl.textContent = 'GitHub raw base URL is not configured.';
    if (historyChart) {
      historyChart.destroy();
    }
    return;
  }

  const url = `${GITHUB_RAW_BASE}/${date}.json`;

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`History file not found (${response.status})`);
    }

    const payload = await response.json();
    const result = payload?.payload?.data?.result || [];
    const filtered = result.filter((entry) => entry.metric && entry.metric.__name__ === selectedMetric);

    if (historyChart) {
      historyChart.destroy();
    }

    const datasets = filtered.slice(0, 20).map((entry, idx) => ({
      label: labelFromPromSeries(entry.metric),
      data: (entry.values || []).map((pair) => ({
        x: Number(pair[0]) * 1000,
        y: Number(pair[1])
      })),
      borderColor: palette(idx),
      backgroundColor: palette(idx),
      borderWidth: 1.8,
      tension: 0.2,
      pointRadius: 0
    }));

    if (!datasets.length) {
      historyMessageEl.textContent = `No historical data for ${selectedMetric} on ${date}.`;
      return;
    }

    historyMessageEl.textContent = `Loaded ${datasets.length} historical series from ${date}.`;

    historyChart = new Chart(document.getElementById('historyChart'), {
      type: 'line',
      data: { datasets },
      options: chartOptions('Historical')
    });
  } catch (error) {
    historyMessageEl.textContent = `History load failed: ${error.message}`;
    if (historyChart) {
      historyChart.destroy();
    }
  }
}

async function apiGet(path) {
  try {
    const response = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`API ${response.status}`);
    }

    const payload = await response.json();
    setServerUp();
    return payload;
  } catch (error) {
    setServerDown(error.message);
    throw error;
  }
}

function chartSeriesFromInflux(series, maxSeries) {
  return series.slice(0, maxSeries).map((entry, idx) => ({
    label: labelFromTags(entry.tags),
    data: (entry.points || []).map((point) => ({ x: Number(point.time), y: Number(point.value) })),
    borderColor: palette(idx),
    backgroundColor: palette(idx),
    borderWidth: 1.8,
    pointRadius: 0,
    tension: 0.2
  }));
}

function chartOptions(title) {
  return {
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
      legend: { display: true, position: 'bottom' },
      title: { display: false, text: title }
    },
    scales: {
      x: {
        type: 'linear',
        ticks: {
          color: '#526174',
          callback(value) {
            return new Date(Number(value)).toLocaleTimeString();
          }
        },
        grid: { color: '#eef2f7' }
      },
      y: {
        ticks: { color: '#526174' },
        grid: { color: '#eef2f7' }
      }
    }
  };
}

function labelFromTags(tags) {
  const entries = Object.entries(tags || {});
  if (!entries.length) {
    return 'series';
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

function labelFromPromSeries(metricLabels) {
  const cloned = { ...(metricLabels || {}) };
  delete cloned.__name__;
  return labelFromTags(cloned);
}

function setServerUp() {
  if (serverUp) {
    return;
  }

  serverUp = true;
  serverStatusEl.textContent = 'Server is up';
  serverStatusEl.classList.remove('down');
  serverStatusEl.classList.add('up');
}

function setServerDown(reason) {
  serverUp = false;
  serverStatusEl.textContent = `Server is down (${reason})`;
  serverStatusEl.classList.remove('up');
  serverStatusEl.classList.add('down');
}

function palette(i) {
  const colors = [
    '#006e8a',
    '#cc5803',
    '#2a9d8f',
    '#c1121f',
    '#7c6a0a',
    '#8a4fff',
    '#2f4858',
    '#bc5090',
    '#588157',
    '#ff7b00'
  ];

  return colors[i % colors.length];
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function guessGithubRawBase() {
  const host = window.location.hostname.toLowerCase();
  if (!host.endsWith('.github.io')) {
    return '';
  }

  const owner = host.replace(/\.github\.io$/, '');
  const segments = window.location.pathname.split('/').filter(Boolean);
  const repo = segments[0];

  if (!owner || !repo) {
    return '';
  }

  return `https://raw.githubusercontent.com/${owner}/${repo}/main/exports`;
}
