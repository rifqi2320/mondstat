'use strict';

const express = require('express');

const app = express();

const PORT = Number(process.env.PORT || 13001);
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL || 'http://prometheus:9090').replace(/\/$/, '');
const DEFAULT_PREFIX = process.env.DEFAULT_METRIC_PREFIX || 'node_';
const DEFAULT_LIMIT = clampInt(process.env.DEFAULT_METRIC_LIMIT, 500, 1, 5000);
const QUERY_CONCURRENCY = clampInt(process.env.QUERY_CONCURRENCY, 8, 1, 32);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://deployment-data-api.reefz.cc')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const ALLOWED_ORIGIN_SUFFIXES = (process.env.ALLOWED_ORIGIN_SUFFIXES || '.github.io')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

app.use(express.json({ limit: '1mb' }));
app.use(corsMiddleware);

app.get('/api/health', async (_req, res) => {
  try {
    await prometheusQuery('up');
    res.json({ status: 'ok', prometheus: 'up' });
  } catch (error) {
    res.status(503).json({
      status: 'down',
      prometheus: 'down',
      error: error.message
    });
  }
});

app.get('/api/metrics', async (req, res) => {
  try {
    const prefix = req.query.prefix === undefined ? DEFAULT_PREFIX : req.query.prefix.toString().trim();
    const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, 5000);

    if (!/^[a-zA-Z0-9_:]*$/.test(prefix)) {
      return res.status(400).json({ error: 'Invalid prefix. Allowed: letters, digits, _, :' });
    }

    const all = await listMetricNames();
    const metrics = all
      .filter((name) => (prefix ? name.startsWith(prefix) : true))
      .slice(0, limit)
      .sort();

    return res.json({ prefix, count: metrics.length, metrics });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/metrics/:metric/latest', async (req, res) => {
  try {
    const metric = req.params.metric;
    const lookback = (req.query.lookback || '15m').toString();

    validateMetric(metric);
    validateDuration(lookback, 'lookback');

    const query = `last_over_time(${metric}[${lookback}])`;
    const payload = await prometheusQuery(query);
    const series = extractSeriesFromInstant(payload);

    return res.json({ metric, lookback, series });
  } catch (error) {
    const status = /invalid/i.test(error.message) ? 400 : 500;
    return res.status(status).json({ error: error.message });
  }
});

app.get('/api/metrics/:metric/history', async (req, res) => {
  try {
    const metric = req.params.metric;
    const interval = (req.query.interval || '30s').toString();
    const to = req.query.to ? new Date(req.query.to.toString()) : new Date();
    const from = req.query.from ? new Date(req.query.from.toString()) : new Date(to.getTime() - 60 * 60 * 1000);

    validateMetric(metric);
    validateDuration(interval, 'interval');

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new Error('Invalid from/to timestamp (must be ISO date).');
    }
    if (from >= to) {
      throw new Error('Invalid range: from must be before to.');
    }

    const stepSeconds = Math.max(1, Math.floor(durationToMs(interval) / 1000));
    const payload = await prometheusQueryRange(metric, from.getTime(), to.getTime(), stepSeconds);
    const series = extractSeriesFromRange(payload);

    return res.json({ metric, from: from.toISOString(), to: to.toISOString(), interval, series });
  } catch (error) {
    const status = /invalid/i.test(error.message) ? 400 : 500;
    return res.status(status).json({ error: error.message });
  }
});

app.get('/api/dashboard/node-latest', async (req, res) => {
  try {
    const prefix = req.query.prefix === undefined ? DEFAULT_PREFIX : req.query.prefix.toString().trim();
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const lookback = (req.query.lookback || '15m').toString();

    if (!/^[a-zA-Z0-9_:]*$/.test(prefix)) {
      return res.status(400).json({ error: 'Invalid prefix. Allowed: letters, digits, _, :' });
    }
    validateDuration(lookback, 'lookback');

    const metrics = (await listMetricNames())
      .filter((name) => (prefix ? name.startsWith(prefix) : true))
      .slice(0, limit)
      .sort();

    const cards = await mapWithConcurrency(metrics, QUERY_CONCURRENCY, async (metric) => {
      const payload = await prometheusQuery(`last_over_time(${metric}[${lookback}])`);
      const series = extractSeriesFromInstant(payload);
      const first = series[0] && series[0].points[0] ? series[0].points[0] : null;

      return {
        metric,
        value: first ? first.value : null,
        time: first ? first.time : null
      };
    });

    return res.json({ prefix, lookback, count: cards.length, cards });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/dashboard/system', async (req, res) => {
  try {
    const lookback = (req.query.lookback || '1h').toString();
    const interval = (req.query.interval || '30s').toString();

    validateDuration(lookback, 'lookback');
    validateDuration(interval, 'interval');

    const lookbackMs = durationToMs(lookback);
    if (lookbackMs <= 0) {
      throw new Error('Invalid lookback duration.');
    }

    const toMs = Date.now();
    const fromMs = toMs - lookbackMs;
    const stepSeconds = Math.max(1, Math.floor(durationToMs(interval) / 1000));

    const queries = {
      cpu_percent: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[1m])))',
      memory_percent: '100 * (1 - (sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)))',
      disk_percent:
        '100 * max(rate(node_disk_io_time_seconds_total{device!~"^(loop|ram|fd|sr|dm-|md).*"}[1m]))',
      network_ingress_mbps:
        '(sum(rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*|cni.*"}[1m])) * 8) / 1e6',
      network_egress_mbps:
        '(sum(rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*|cni.*"}[1m])) * 8) / 1e6'
    };

    const entries = await Promise.all(
      Object.entries(queries).map(async ([key, query]) => {
        const payload = await prometheusQueryRange(query, fromMs, toMs, stepSeconds);
        return [key, mapFromRangePayload(payload)];
      })
    );

    const maps = Object.fromEntries(entries);
    const times = sortedTimeUnion(Object.values(maps));

    const series = times.map((time) => ({
      time,
      cpu_percent: numOrNull(maps.cpu_percent.get(time)),
      memory_percent: numOrNull(maps.memory_percent.get(time)),
      disk_percent: numOrNull(maps.disk_percent.get(time)),
      network_ingress_mbps: numOrNull(maps.network_ingress_mbps.get(time)),
      network_egress_mbps: numOrNull(maps.network_egress_mbps.get(time))
    }));

    const latest = {
      cpu_percent: latestValue(maps.cpu_percent),
      memory_percent: latestValue(maps.memory_percent),
      disk_percent: latestValue(maps.disk_percent),
      network_ingress_mbps: latestValue(maps.network_ingress_mbps),
      network_egress_mbps: latestValue(maps.network_egress_mbps),
      updated_at: latestTimestampIso(Object.values(maps))
    };

    return res.json({
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      lookback,
      interval,
      latest,
      series
    });
  } catch (error) {
    const status = /invalid/i.test(error.message) ? 400 : 500;
    return res.status(status).json({ error: error.message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Metrics backend listening on ${PORT}`);
});

async function listMetricNames() {
  const payload = await prometheusGet('/api/v1/label/__name__/values');
  const values = payload?.data || [];
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

function extractSeriesFromInstant(payload) {
  const result = payload?.data?.result || [];
  return result.map((entry) => {
    const [timeSec, valueText] = entry.value || [];
    const time = Number(timeSec) * 1000;
    const value = Number(valueText);

    return {
      tags: entry.metric || {},
      points: Number.isFinite(time) && Number.isFinite(value) ? [{ time, value }] : []
    };
  });
}

function extractSeriesFromRange(payload) {
  const result = payload?.data?.result || [];
  return result.map((entry) => ({
    tags: entry.metric || {},
    points: (entry.values || [])
      .map(([timeSec, valueText]) => ({
        time: Number(timeSec) * 1000,
        value: Number(valueText)
      }))
      .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value))
  }));
}

function mapFromRangePayload(payload) {
  const result = payload?.data?.result || [];
  const map = new Map();

  for (const series of result) {
    for (const [timeSec, valueText] of series.values || []) {
      const time = Number(timeSec) * 1000;
      const value = Number(valueText);
      if (!Number.isFinite(time) || !Number.isFinite(value)) {
        continue;
      }
      map.set(time, (map.get(time) || 0) + value);
    }
  }

  return map;
}

async function prometheusQuery(query, timeMs) {
  const params = { query };
  if (timeMs !== undefined) {
    params.time = (timeMs / 1000).toString();
  }
  return prometheusGet('/api/v1/query', params);
}

async function prometheusQueryRange(query, fromMs, toMs, stepSeconds) {
  return prometheusGet('/api/v1/query_range', {
    query,
    start: (fromMs / 1000).toString(),
    end: (toMs / 1000).toString(),
    step: stepSeconds.toString()
  });
}

async function prometheusGet(path, params = {}) {
  const url = new URL(`${PROMETHEUS_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Prometheus request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (payload?.status !== 'success') {
    throw new Error(payload?.error || 'Prometheus API error');
  }

  return payload;
}

function corsMiddleware(req, res, next) {
  const requestOrigin = req.headers.origin;

  if (!requestOrigin) {
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    return next();
  }

  if (isOriginAllowed(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
}

function validateMetric(metric) {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric)) {
    throw new Error('Invalid metric name.');
  }
}

function validateDuration(value, label) {
  if (!/^\d+(ms|s|m|h|d|w)$/.test(value)) {
    throw new Error(`Invalid ${label}. Expected duration like 30s, 5m, 1h.`);
  }
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

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function sortedTimeUnion(maps) {
  const set = new Set();
  for (const map of maps) {
    for (const time of map.keys()) {
      set.add(time);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

function latestValue(map) {
  let bestTime = null;
  let bestValue = null;
  for (const [time, value] of map.entries()) {
    if (bestTime === null || time > bestTime) {
      bestTime = time;
      bestValue = value;
    }
  }
  return numOrNull(bestValue);
}

function latestTimestampIso(maps) {
  let latest = null;
  for (const map of maps) {
    for (const time of map.keys()) {
      if (latest === null || time > latest) {
        latest = time;
      }
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function numOrNull(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(3));
}

function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    return true;
  }

  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch (_error) {
    return false;
  }

  return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => {
    const normalized = suffix.replace(/^\./, '');
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!items.length) {
    return [];
  }

  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const size = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: size }, () => runWorker()));
  return results;
}
