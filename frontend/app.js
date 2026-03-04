'use strict';

const cfg = window.APP_CONFIG || {};
const DEFAULT_API_BASE = (cfg.apiBaseUrl || 'https://deployment-data-api.reefz.cc').replace(/\/$/, '');
const GITHUB_RAW_BASE = (cfg.githubRawBaseUrl || guessGithubRawBase() || '').replace(/\/$/, '');
const HOST_STORAGE_KEY = 'dashboard.selectedHostApi';

const serverStatusEl = document.getElementById('serverStatus');
const lastRefreshEl = document.getElementById('lastRefresh');
const historyDateEl = document.getElementById('historyDate');
const historyMessageEl = document.getElementById('historyMessage');
const loadHistoryBtn = document.getElementById('loadHistory');
const hostListEl = document.getElementById('hostList');
const currentHostEl = document.getElementById('currentHost');

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
let serverUp = false;
let hosts = [];
let currentHostIndex = -1;
let currentApiBase = DEFAULT_API_BASE;

const POLL_MS = 15000;

const domOk = [
  serverStatusEl,
  lastRefreshEl,
  historyDateEl,
  historyMessageEl,
  loadHistoryBtn,
  hostListEl,
  currentHostEl,
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

  boot().catch((error) => {
    setServerDown(error.message);
  });
}

async function boot() {
  historyDateEl.value = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

  await initHosts();
  await loadRealtime();
  await loadHistory();

  setInterval(async () => {
    await loadRealtime();
  }, POLL_MS);
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

    if (!name || !apiUrl) {
      continue;
    }

    if (!isValidHttpUrl(apiUrl)) {
      continue;
    }

    if (seen.has(apiUrl)) {
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
  currentHostEl.textContent = `${hosts[index].name}`;

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
    const payload = await apiGet('/api/dashboard/system?lookback=1h&interval=30s');
    setServerUp();

    renderLatestCards(payload.latest || {});
    renderRealtimeCharts(payload.series || []);
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

  if (realtimePercentChart) {
    realtimePercentChart.destroy();
  }
  if (realtimeBandwidthChart) {
    realtimeBandwidthChart.destroy();
  }

  realtimePercentChart = new Chart(realtimePercentChartEl, {
    type: 'line',
    data: { datasets: percentData },
    options: chartOptions(true)
  });

  realtimeBandwidthChart = new Chart(realtimeBandwidthChartEl, {
    type: 'line',
    data: { datasets: bandwidthData },
    options: chartOptions(false)
  });
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

  const url = `${GITHUB_RAW_BASE}/${date}.json`;

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`History file not found (${response.status})`);
    }

    const payload = await response.json();
    const rawResult = payload?.payload?.data?.result || [];
    const derived = deriveSystemMetricsFromProm(rawResult);

    if (!derived.series.length) {
      historyMessageEl.textContent = `No usable historical data for ${date}.`;
      return;
    }

    historyMessageEl.textContent = `Loaded ${derived.series.length} historical points from ${date}.`;
    renderHistoryCharts(derived.series);
  } catch (error) {
    historyMessageEl.textContent = `History load failed: ${error.message}`;
  }
}

function renderHistoryCharts(series) {
  const percentData = buildPercentDatasets(series);
  const bandwidthData = buildBandwidthDatasets(series);

  if (historyPercentChart) {
    historyPercentChart.destroy();
  }
  if (historyBandwidthChart) {
    historyBandwidthChart.destroy();
  }

  historyPercentChart = new Chart(historyPercentChartEl, {
    type: 'line',
    data: { datasets: percentData },
    options: chartOptions(true)
  });

  historyBandwidthChart = new Chart(historyBandwidthChartEl, {
    type: 'line',
    data: { datasets: bandwidthData },
    options: chartOptions(false)
  });
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
    plugins: {
      legend: { display: true, position: 'bottom' }
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
  if (serverUp) {
    return;
  }

  serverUp = true;
  serverStatusEl.textContent = `Server is up (${activeHostName()})`;
  serverStatusEl.classList.remove('down');
  serverStatusEl.classList.add('up');
}

function setServerDown(reason) {
  serverUp = false;
  serverStatusEl.textContent = `Server is down (${activeHostName()}: ${reason})`;
  serverStatusEl.classList.remove('up');
  serverStatusEl.classList.add('down');
}

function activeHostName() {
  return currentHostIndex >= 0 && hosts[currentHostIndex] ? hosts[currentHostIndex].name : 'unknown host';
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
