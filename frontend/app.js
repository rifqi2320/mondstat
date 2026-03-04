'use strict';

const cfg = window.APP_CONFIG || {};
const DEFAULT_API_BASE = (cfg.apiBaseUrl || 'https://deployment-data-api.reefz.cc').replace(/\/$/, '');
const GITHUB_RAW_BASE = (cfg.githubRawBaseUrl || guessGithubRawBase() || '').replace(/\/$/, '');

const HOST_STORAGE_KEY = 'dashboard.selectedHostApi';
const RANGE_STORAGE_KEY = 'dashboard.selectedRange';
const POLL_MS = 15000;
const DEFAULT_RANGE = '1h';

const RANGE_TO_INTERVAL = {
  '1h': '30s',
  '5h': '1m',
  '12h': '2m',
  '24h': '5m',
  '3d': '15m',
  '7d': '30m',
  '15d': '1h',
  '30d': '2h'
};

const serverStatusEl = document.getElementById('serverStatus');
const lastRefreshEl = document.getElementById('lastRefresh');
const historyDateEl = document.getElementById('historyDate');
const historyMessageEl = document.getElementById('historyMessage');
const loadHistoryBtn = document.getElementById('loadHistory');
const hostListEl = document.getElementById('hostList');
const currentHostEl = document.getElementById('currentHost');
const timeRangeEl = document.getElementById('timeRange');

const cpuValueEl = document.getElementById('cpuValue');
const memoryValueEl = document.getElementById('memoryValue');
const diskValueEl = document.getElementById('diskValue');
const ingressValueEl = document.getElementById('ingressValue');
const egressValueEl = document.getElementById('egressValue');
const realtimePercentChartEl = document.getElementById('realtimePercentChart');
const realtimeBandwidthChartEl = document.getElementById('realtimeBandwidthChart');
const historyPercentChartEl = document.getElementById('historyPercentChart');
const historyBandwidthChartEl = document.getElementById('historyBandwidthChart');

let realtimePercentChart;
let realtimeBandwidthChart;
let historyPercentChart;
let historyBandwidthChart;
let hosts = [];
let currentHostIndex = -1;
let currentApiBase = DEFAULT_API_BASE;
let currentRange = DEFAULT_RANGE;
let pollingHandle;

const domOk = [
  serverStatusEl,
  lastRefreshEl,
  historyDateEl,
  historyMessageEl,
  loadHistoryBtn,
  hostListEl,
  currentHostEl,
  timeRangeEl,
  cpuValueEl,
  memoryValueEl,
  diskValueEl,
  ingressValueEl,
  egressValueEl,
  realtimePercentChartEl,
  realtimeBandwidthChartEl,
  historyPercentChartEl,
  historyBandwidthChartEl
].every(Boolean);

if (!domOk) {
  console.error('Dashboard DOM mismatch. Hard refresh the page to load matching assets.');
  if (serverStatusEl) {
    setServerDown('frontend assets are out of sync, hard refresh required');
  }
} else {
  loadHistoryBtn.addEventListener('click', () => {
    loadHistory().catch(() => {});
  });

  timeRangeEl.addEventListener('change', async () => {
    currentRange = normalizeRange(timeRangeEl.value);
    writeStoredRange(currentRange);
    await loadRealtime();
    await loadHistory();
  });

  boot().catch((error) => {
    setServerDown(error.message);
  });
}

async function boot() {
  historyDateEl.value = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  currentRange = normalizeRange(readStoredRange() || DEFAULT_RANGE);
  timeRangeEl.value = currentRange;

  initCharts();
  await initHosts();
  await loadRealtime();
  await loadHistory();

  pollingHandle = setInterval(async () => {
    await loadRealtime();
  }, POLL_MS);
}

function initCharts() {
  realtimePercentChart = createLineChart(realtimePercentChartEl, true);
  realtimeBandwidthChart = createLineChart(realtimeBandwidthChartEl, false);
  historyPercentChart = createLineChart(historyPercentChartEl, true);
  historyBandwidthChart = createLineChart(historyBandwidthChartEl, false);
}

function createLineChart(canvasEl, isPercent) {
  return new Chart(canvasEl, {
    type: 'line',
    data: { datasets: [] },
    options: chartOptions(isPercent)
  });
}

async function initHosts() {
  const fromFile = await loadHostsFromFile();
  hosts = normalizeHosts(fromFile);

  if (!hosts.length) {
    hosts = [{ name: 'Default', apiUrl: DEFAULT_API_BASE }];
  }

  const stored = readStoredHostApi();
  const preferred = stored || DEFAULT_API_BASE;
  const selected = findHostIndex(preferred);

  await selectHost(selected >= 0 ? selected : 0, false);
}

async function loadHostsFromFile() {
  try {
    const response = await fetch('hosts.json', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    if (Array.isArray(payload)) {
      return payload;
    }
    if (Array.isArray(payload?.hosts)) {
      return payload.hosts;
    }
    return [];
  } catch (_error) {
    return [];
  }
}

function normalizeHosts(items) {
  const out = [];
  const seen = new Set();

  for (const item of items || []) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const apiUrl = typeof item?.apiUrl === 'string' ? item.apiUrl.trim().replace(/\/$/, '') : '';

    if (!name || !apiUrl || !isValidHttpUrl(apiUrl) || seen.has(apiUrl)) {
      continue;
    }

    seen.add(apiUrl);
    out.push({ name, apiUrl });
  }

  return out;
}

function findHostIndex(apiUrl) {
  return hosts.findIndex((host) => host.apiUrl === apiUrl);
}

async function selectHost(index, shouldRefresh = true) {
  if (index < 0 || index >= hosts.length) {
    return;
  }

  currentHostIndex = index;
  currentApiBase = hosts[index].apiUrl;
  writeStoredHostApi(currentApiBase);

  renderHostList();
  currentHostEl.textContent = hosts[index].name;

  if (shouldRefresh) {
    await loadRealtime();
  }
}

function renderHostList() {
  hostListEl.innerHTML = '';

  for (let i = 0; i < hosts.length; i += 1) {
    const host = hosts[i];
    const button = document.createElement('button');
    button.className = `host-item${i === currentHostIndex ? ' active' : ''}`;
    button.innerHTML = `<span class="host-name">${escapeHtml(host.name)}</span><span class="host-url">${escapeHtml(host.apiUrl)}</span>`;
    button.addEventListener('click', () => {
      selectHost(i).catch((error) => {
        setServerDown(error.message);
      });
    });
    hostListEl.appendChild(button);
  }
}

async function loadRealtime() {
  try {
    const interval = intervalForRange(currentRange);
    const payload = await apiGet(`/api/dashboard/system?lookback=${encodeURIComponent(currentRange)}&interval=${encodeURIComponent(interval)}`);

    renderLatestCards(payload.latest || {});
    renderRealtimeCharts(payload.series || []);
    setServerUp();
    lastRefreshEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    setServerDown(error.message);
  }
}

function renderLatestCards(latest) {
  cpuValueEl.textContent = formatPercent(latest.cpu_percent);
  memoryValueEl.textContent = formatPercent(latest.memory_percent);
  diskValueEl.textContent = formatPercent(latest.disk_percent);
  ingressValueEl.textContent = formatMbps(latest.network_ingress_mbps);
  egressValueEl.textContent = formatMbps(latest.network_egress_mbps);
}

function renderRealtimeCharts(series) {
  const percentData = buildPercentDatasets(series);
  const bandwidthData = buildBandwidthDatasets(series);

  updateChartDatasets(realtimePercentChart, percentData);
  updateChartDatasets(realtimeBandwidthChart, bandwidthData);
}

async function loadHistory() {
  const date = historyDateEl.value;
  if (!date) {
    historyMessageEl.textContent = 'Pick a date first.';
    return;
  }

  if (!GITHUB_RAW_BASE) {
    historyMessageEl.textContent = 'GitHub raw URL is not configured.';
    return;
  }

  const rangeMs = durationToMs(currentRange);
  const endMs = Date.parse(`${date}T23:59:59Z`);
  const startMs = endMs - rangeMs + 1000;

  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) {
    historyMessageEl.textContent = 'Invalid date or range.';
    return;
  }

  try {
    const dates = listDateStringsUtc(startMs, endMs);
    const files = await Promise.all(dates.map((day) => loadHistoryFile(day)));
    const available = files.filter(Boolean);

    if (!available.length) {
      historyMessageEl.textContent = 'No historical export files found for selected range.';
      updateChartDatasets(historyPercentChart, []);
      updateChartDatasets(historyBandwidthChart, []);
      return;
    }

    const merged = mergePromResults(
      available.map((entry) => entry.result),
      Math.floor(startMs / 1000),
      Math.floor(endMs / 1000)
    );

    const derived = deriveSystemMetricsFromProm(merged);
    if (!derived.series.length) {
      historyMessageEl.textContent = 'No usable historical points in selected range.';
      updateChartDatasets(historyPercentChart, []);
      updateChartDatasets(historyBandwidthChart, []);
      return;
    }

    historyMessageEl.textContent = `Loaded ${derived.series.length} points from ${available.length}/${dates.length} day file(s).`;
    renderHistoryCharts(derived.series);
  } catch (error) {
    historyMessageEl.textContent = `History load failed: ${error.message}`;
  }
}

async function loadHistoryFile(day) {
  const url = `${GITHUB_RAW_BASE}/${day}.json`;

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const result = payload?.payload?.data?.result;
    if (!Array.isArray(result)) {
      return null;
    }

    return { day, result };
  } catch (_error) {
    return null;
  }
}

function mergePromResults(resultArrays, minTsSec, maxTsSec) {
  const map = new Map();

  for (const result of resultArrays) {
    for (const series of result || []) {
      const metric = series.metric || {};
      const key = stableMetricKey(metric);

      if (!map.has(key)) {
        map.set(key, { metric, values: new Map() });
      }

      const bucket = map.get(key);
      for (const pair of series.values || []) {
        const ts = Number(pair[0]);
        const value = String(pair[1]);

        if (!Number.isFinite(ts) || ts < minTsSec || ts > maxTsSec) {
          continue;
        }

        bucket.values.set(ts, value);
      }
    }
  }

  return Array.from(map.values()).map((entry) => ({
    metric: entry.metric,
    values: Array.from(entry.values.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([ts, value]) => [ts, value])
  }));
}

function stableMetricKey(metric) {
  return Object.keys(metric)
    .sort()
    .map((key) => `${key}=${metric[key]}`)
    .join('|');
}

function renderHistoryCharts(series) {
  const percentData = buildPercentDatasets(series);
  const bandwidthData = buildBandwidthDatasets(series);

  updateChartDatasets(historyPercentChart, percentData);
  updateChartDatasets(historyBandwidthChart, bandwidthData);
}

function updateChartDatasets(chart, datasets) {
  chart.data.datasets = datasets;
  chart.update('none');
}

function buildPercentDatasets(series) {
  return [
    createDataset('CPU %', '#0077b6', series, 'cpu_percent'),
    createDataset('Memory %', '#ef476f', series, 'memory_percent'),
    createDataset('Disk %', '#ff9f1c', series, 'disk_percent')
  ];
}

function buildBandwidthDatasets(series) {
  return [
    createDataset('Ingress Mbps', '#2a9d8f', series, 'network_ingress_mbps'),
    createDataset('Egress Mbps', '#9b5de5', series, 'network_egress_mbps')
  ];
}

function createDataset(label, color, series, key) {
  return {
    label,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    tension: 0.2,
    pointRadius: 0,
    data: series
      .filter((row) => Number.isFinite(row[key]))
      .map((row) => ({ x: Number(row.time), y: Number(row[key]) }))
  };
}

function chartOptions(isPercent) {
  return {
    responsive: true,
    maintainAspectRatio: true,
    animation: false,
    plugins: {
      legend: { display: true, position: 'bottom' }
    },
    scales: {
      x: {
        type: 'linear',
        ticks: {
          color: '#526174',
          callback(value) {
            return formatAxisTime(Number(value));
          }
        },
        grid: { color: '#edf2f7' }
      },
      y: {
        min: 0,
        max: isPercent ? 100 : undefined,
        ticks: {
          color: '#526174',
          callback(value) {
            return isPercent ? `${value}%` : value;
          }
        },
        grid: { color: '#edf2f7' }
      }
    }
  };
}

function formatAxisTime(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  const rangeMs = durationToMs(currentRange);
  if (rangeMs > durationToMs('24h')) {
    return `${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:00`;
  }

  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function deriveSystemMetricsFromProm(result) {
  const idleCpu = filterPromSeries(result, 'node_cpu_seconds_total', (labels) => labels.mode === 'idle');
  const memTotal = filterPromSeries(result, 'node_memory_MemTotal_bytes');
  const memAvail = filterPromSeries(result, 'node_memory_MemAvailable_bytes');

  const fsFilter = (labels) => {
    const fstype = labels.fstype || '';
    const mountpoint = labels.mountpoint || '';
    if (/^(tmpfs|overlay|squashfs|ramfs|nsfs)$/.test(fstype)) {
      return false;
    }
    return !/^\/(sys|proc|dev|run)(\/|$)/.test(mountpoint);
  };

  const diskSize = filterPromSeries(result, 'node_filesystem_size_bytes', fsFilter);
  const diskAvail = filterPromSeries(result, 'node_filesystem_avail_bytes', fsFilter);

  const netFilter = (labels) => !/^(lo|veth.*|docker.*|br-.*|cni.*)$/.test(labels.device || '');
  const netIn = filterPromSeries(result, 'node_network_receive_bytes_total', netFilter);
  const netOut = filterPromSeries(result, 'node_network_transmit_bytes_total', netFilter);

  const cpuIdleRateAvg = counterRateAverageByTime(idleCpu);
  const cpuMap = mapValues(cpuIdleRateAvg, (rate) => clamp((1 - rate) * 100, 0, 100));

  const memTotalMap = gaugeSumByTime(memTotal);
  const memAvailMap = gaugeSumByTime(memAvail);
  const memUsageMap = ratioUsageMap(memTotalMap, memAvailMap);

  const diskSizeMap = gaugeSumByTime(diskSize);
  const diskAvailMap = gaugeSumByTime(diskAvail);
  const diskUsageMap = ratioUsageMap(diskSizeMap, diskAvailMap);

  const netInBps = counterRateSumByTime(netIn);
  const netOutBps = counterRateSumByTime(netOut);
  const netInMbps = mapValues(netInBps, (bps) => (bps * 8) / 1_000_000);
  const netOutMbps = mapValues(netOutBps, (bps) => (bps * 8) / 1_000_000);

  const times = unionSortedTimes([cpuMap, memUsageMap, diskUsageMap, netInMbps, netOutMbps]);
  const series = times.map((time) => ({
    time,
    cpu_percent: numOrNull(cpuMap.get(time)),
    memory_percent: numOrNull(memUsageMap.get(time)),
    disk_percent: numOrNull(diskUsageMap.get(time)),
    network_ingress_mbps: numOrNull(netInMbps.get(time)),
    network_egress_mbps: numOrNull(netOutMbps.get(time))
  }));

  return { series };
}

function filterPromSeries(result, metricName, predicate = () => true) {
  return result.filter((entry) => {
    const labels = entry.metric || {};
    return labels.__name__ === metricName && predicate(labels);
  });
}

function gaugeSumByTime(seriesList) {
  const out = new Map();
  for (const entry of seriesList) {
    for (const pair of entry.values || []) {
      const time = Number(pair[0]) * 1000;
      const value = Number(pair[1]);
      if (!Number.isFinite(time) || !Number.isFinite(value)) {
        continue;
      }
      out.set(time, (out.get(time) || 0) + value);
    }
  }
  return out;
}

function counterRateSumByTime(seriesList) {
  const out = new Map();

  for (const entry of seriesList) {
    const values = entry.values || [];
    for (let i = 1; i < values.length; i += 1) {
      const prevTime = Number(values[i - 1][0]);
      const currTime = Number(values[i][0]);
      const prevValue = Number(values[i - 1][1]);
      const currValue = Number(values[i][1]);

      const deltaT = currTime - prevTime;
      const deltaV = currValue - prevValue;

      if (deltaT <= 0 || deltaV < 0) {
        continue;
      }

      const rate = deltaV / deltaT;
      const timeMs = currTime * 1000;
      out.set(timeMs, (out.get(timeMs) || 0) + rate);
    }
  }

  return out;
}

function counterRateAverageByTime(seriesList) {
  const accum = new Map();

  for (const entry of seriesList) {
    const values = entry.values || [];
    for (let i = 1; i < values.length; i += 1) {
      const prevTime = Number(values[i - 1][0]);
      const currTime = Number(values[i][0]);
      const prevValue = Number(values[i - 1][1]);
      const currValue = Number(values[i][1]);

      const deltaT = currTime - prevTime;
      const deltaV = currValue - prevValue;

      if (deltaT <= 0 || deltaV < 0) {
        continue;
      }

      const rate = deltaV / deltaT;
      const timeMs = currTime * 1000;
      const cell = accum.get(timeMs) || { sum: 0, count: 0 };
      cell.sum += rate;
      cell.count += 1;
      accum.set(timeMs, cell);
    }
  }

  const out = new Map();
  for (const [time, value] of accum.entries()) {
    out.set(time, value.count > 0 ? value.sum / value.count : NaN);
  }
  return out;
}

function ratioUsageMap(totalMap, availMap) {
  const out = new Map();
  for (const [time, total] of totalMap.entries()) {
    const avail = availMap.get(time);
    if (!Number.isFinite(total) || !Number.isFinite(avail) || total <= 0) {
      continue;
    }
    out.set(time, clamp((1 - avail / total) * 100, 0, 100));
  }
  return out;
}

function mapValues(input, fn) {
  const out = new Map();
  for (const [time, value] of input.entries()) {
    const next = fn(value);
    if (Number.isFinite(next)) {
      out.set(time, next);
    }
  }
  return out;
}

function unionSortedTimes(maps) {
  const all = new Set();
  for (const map of maps) {
    for (const time of map.keys()) {
      all.add(time);
    }
  }
  return Array.from(all).sort((a, b) => a - b);
}

async function apiGet(path) {
  if (!currentApiBase) {
    throw new Error('no selected API host');
  }

  const response = await fetch(`${currentApiBase}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`API ${response.status}`);
  }
  return response.json();
}

function setServerUp() {
  serverStatusEl.textContent = `Server is up (${activeHostName()})`;
  serverStatusEl.classList.remove('down');
  serverStatusEl.classList.add('up');
}

function setServerDown(reason) {
  serverStatusEl.textContent = `Server is down (${activeHostName()}: ${reason})`;
  serverStatusEl.classList.remove('up');
  serverStatusEl.classList.add('down');
}

function activeHostName() {
  return currentHostIndex >= 0 && hosts[currentHostIndex] ? hosts[currentHostIndex].name : 'unknown host';
}

function normalizeRange(value) {
  return Object.prototype.hasOwnProperty.call(RANGE_TO_INTERVAL, value) ? value : DEFAULT_RANGE;
}

function intervalForRange(range) {
  return RANGE_TO_INTERVAL[normalizeRange(range)];
}

function durationToMs(value) {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(String(value));
  if (!match) {
    return 0;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };

  return amount * multipliers[unit];
}

function listDateStringsUtc(startMs, endMs) {
  const start = new Date(startMs);
  const end = new Date(endMs);

  const cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

  const out = [];
  for (let day = cursor; day <= endDay; day += 24 * 60 * 60 * 1000) {
    out.push(formatDate(new Date(day)));
  }
  return out;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return '--%';
  }
  return `${value.toFixed(2)}%`;
}

function formatMbps(value) {
  if (!Number.isFinite(value)) {
    return '-- Mbps';
  }
  return `${value.toFixed(3)} Mbps`;
}

function numOrNull(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function pad2(value) {
  return `${value}`.padStart(2, '0');
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

function isValidHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function readStoredHostApi() {
  try {
    return localStorage.getItem(HOST_STORAGE_KEY);
  } catch (_error) {
    return null;
  }
}

function writeStoredHostApi(apiUrl) {
  try {
    localStorage.setItem(HOST_STORAGE_KEY, apiUrl);
  } catch (_error) {
    // ignore
  }
}

function readStoredRange() {
  try {
    return localStorage.getItem(RANGE_STORAGE_KEY);
  } catch (_error) {
    return null;
  }
}

function writeStoredRange(range) {
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, range);
  } catch (_error) {
    // ignore
  }
}
