'use strict';

const express = require('express');

const app = express();

const PORT = Number(process.env.PORT || 13001);
const INFLUX_URL = (process.env.INFLUX_URL || 'http://influxdb:8086').replace(/\/$/, '');
const INFLUX_DB = process.env.INFLUX_DB || 'prometheus';
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
    await influxQuery('SHOW DATABASES');
    res.json({ status: 'ok', influx: 'up' });
  } catch (error) {
    res.status(503).json({
      status: 'down',
      influx: 'down',
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

    const metrics = await listMeasurements(prefix, limit);
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

    const q = `SELECT LAST("value") AS value FROM ${quoteIdent(metric)} WHERE time > now() - ${lookback} GROUP BY *`;
    const result = await influxQuery(q);
    const series = extractSeries(result);

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

    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const q = [
      `SELECT MEAN("value") AS value FROM ${quoteIdent(metric)}`,
      `WHERE time >= '${fromIso}' AND time <= '${toIso}'`,
      `GROUP BY time(${interval}), * fill(none)`
    ].join(' ');

    const result = await influxQuery(q);
    const series = extractSeries(result);

    return res.json({ metric, from: fromIso, to: toIso, interval, series });
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

    const metrics = await listMeasurements(prefix, limit);
    const cards = await mapWithConcurrency(metrics, QUERY_CONCURRENCY, async (metric) => {
      const q = `SELECT LAST("value") AS value FROM ${quoteIdent(metric)} WHERE time > now() - ${lookback}`;
      const result = await influxQuery(q);
      const series = extractSeries(result);
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
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(toMs).toISOString();

    const cpuQuery = [
      'SELECT (100 - (MEAN("idle_rate") * 100)) AS value',
      'FROM (',
      'SELECT NON_NEGATIVE_DERIVATIVE(MEAN("value"), 1s) AS idle_rate',
      'FROM "node_cpu_seconds_total"',
      `WHERE "mode"='idle' AND time >= '${fromIso}' AND time <= '${toIso}'`,
      `GROUP BY time(${interval}), "instance", "cpu" fill(none)`,
      ')',
      `GROUP BY time(${interval}) fill(none)`
    ].join(' ');

    const networkRxQuery = [
      'SELECT SUM("rate") AS value',
      'FROM (',
      'SELECT NON_NEGATIVE_DERIVATIVE(MEAN("value"), 1s) AS rate',
      'FROM "node_network_receive_bytes_total"',
      `WHERE "device" !~ /^(lo|veth.*|docker.*|br-.*|cni.*)$/ AND time >= '${fromIso}' AND time <= '${toIso}'`,
      `GROUP BY time(${interval}), "instance", "device" fill(none)`,
      ')',
      `GROUP BY time(${interval}) fill(none)`
    ].join(' ');

    const networkTxQuery = [
      'SELECT SUM("rate") AS value',
      'FROM (',
      'SELECT NON_NEGATIVE_DERIVATIVE(MEAN("value"), 1s) AS rate',
      'FROM "node_network_transmit_bytes_total"',
      `WHERE "device" !~ /^(lo|veth.*|docker.*|br-.*|cni.*)$/ AND time >= '${fromIso}' AND time <= '${toIso}'`,
      `GROUP BY time(${interval}), "instance", "device" fill(none)`,
      ')',
      `GROUP BY time(${interval}) fill(none)`
    ].join(' ');

    const memTotalQuery = [
      'SELECT SUM("value") AS value',
      'FROM "node_memory_MemTotal_bytes"',
      `WHERE time >= '${fromIso}' AND time <= '${toIso}'`,
      `GROUP BY time(${interval}) fill(none)`
    ].join(' ');

    const memAvailQuery = [
      'SELECT SUM("value") AS value',
      'FROM "node_memory_MemAvailable_bytes"',
      `WHERE time >= '${fromIso}' AND time <= '${toIso}'`,
      `GROUP BY time(${interval}) fill(none)`
    ].join(' ');

    const diskSizeQuery = [
      'SELECT SUM("value") AS value',
      'FROM "node_filesystem_size_bytes"',
      `WHERE "fstype" !~ /^(tmpfs|overlay|squashfs|ramfs|nsfs)$/`,
      `AND "mountpoint" !~ /^\\/(sys|proc|dev|run)($|\\/)/`,
      `AND time >= '${fromIso}' AND time <= '${toIso}'`,
      `GROUP BY time(${interval}) fill(none)`
    ].join(' ');

    const diskAvailQuery = [
      'SELECT SUM("value") AS value',
      'FROM "node_filesystem_avail_bytes"',
      `WHERE "fstype" !~ /^(tmpfs|overlay|squashfs|ramfs|nsfs)$/`,
      `AND "mountpoint" !~ /^\\/(sys|proc|dev|run)($|\\/)/`,
      `AND time >= '${fromIso}' AND time <= '${toIso}'`,
      `GROUP BY time(${interval}) fill(none)`
    ].join(' ');

    const [cpuRaw, netInRaw, netOutRaw, memTotalRaw, memAvailRaw, diskSizeRaw, diskAvailRaw] = await Promise.all([
      queryValueSeries(cpuQuery),
      queryValueSeries(networkRxQuery),
      queryValueSeries(networkTxQuery),
      queryValueSeries(memTotalQuery),
      queryValueSeries(memAvailQuery),
      queryValueSeries(diskSizeQuery),
      queryValueSeries(diskAvailQuery)
    ]);

    const cpuMap = mapFromPoints(cpuRaw, (value) => clampNumber(value, 0, 100));
    const memTotalMap = mapFromPoints(memTotalRaw);
    const memAvailMap = mapFromPoints(memAvailRaw);
    const diskSizeMap = mapFromPoints(diskSizeRaw);
    const diskAvailMap = mapFromPoints(diskAvailRaw);
    const netInMbpsMap = mapFromPoints(netInRaw, (value) => (value * 8) / 1_000_000);
    const netOutMbpsMap = mapFromPoints(netOutRaw, (value) => (value * 8) / 1_000_000);

    const memUsageMap = ratioUsageMap(memTotalMap, memAvailMap);
    const diskUsageMap = ratioUsageMap(diskSizeMap, diskAvailMap);

    const times = sortedTimeUnion([cpuMap, memUsageMap, diskUsageMap, netInMbpsMap, netOutMbpsMap]);
    const series = times.map((time) => ({
      time,
      cpu_percent: numOrNull(cpuMap.get(time)),
      memory_percent: numOrNull(memUsageMap.get(time)),
      disk_percent: numOrNull(diskUsageMap.get(time)),
      network_ingress_mbps: numOrNull(netInMbpsMap.get(time)),
      network_egress_mbps: numOrNull(netOutMbpsMap.get(time))
    }));

    const latest = {
      cpu_percent: latestValue(cpuMap),
      memory_percent: latestValue(memUsageMap),
      disk_percent: latestValue(diskUsageMap),
      network_ingress_mbps: latestValue(netInMbpsMap),
      network_egress_mbps: latestValue(netOutMbpsMap),
      updated_at: latestTimestampIso([cpuMap, memUsageMap, diskUsageMap, netInMbpsMap, netOutMbpsMap])
    };

    return res.json({
      from: fromIso,
      to: toIso,
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

async function listMeasurements(prefix, limit) {
  const q = prefix
    ? `SHOW MEASUREMENTS WITH MEASUREMENT =~ /^${escapeRegex(prefix)}.*/ LIMIT ${limit}`
    : `SHOW MEASUREMENTS LIMIT ${limit}`;

  const result = await influxQuery(q);
  const values = result?.results?.[0]?.series?.[0]?.values || [];
  return values.map((row) => row[0]).filter(Boolean).sort();
}

function extractSeries(result) {
  const rawSeries = result?.results?.[0]?.series || [];

  return rawSeries.map((series) => {
    const timeIndex = series.columns.indexOf('time');
    const valueIndex = series.columns.indexOf('value');

    const points = (series.values || [])
      .map((row) => ({
        time: timeIndex >= 0 ? row[timeIndex] : null,
        value: valueIndex >= 0 ? row[valueIndex] : null
      }))
      .filter((point) => point.time !== null && point.value !== null);

    return {
      tags: series.tags || {},
      points
    };
  });
}

async function influxQuery(query) {
  const url = `${INFLUX_URL}/query?db=${encodeURIComponent(INFLUX_DB)}&epoch=ms&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`InfluxDB request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const resultError = payload?.results?.find((item) => item.error)?.error;

  if (resultError) {
    throw new Error(`InfluxDB query error: ${resultError}`);
  }

  return payload;
}

async function queryValueSeries(query) {
  const result = await influxQuery(query);
  const rawSeries = result?.results?.[0]?.series || [];
  const byTime = new Map();

  for (const series of rawSeries) {
    const timeIndex = series.columns.indexOf('time');
    const valueIndex = series.columns.indexOf('value');
    if (timeIndex < 0 || valueIndex < 0) {
      continue;
    }

    for (const row of series.values || []) {
      const time = Number(row[timeIndex]);
      const value = Number(row[valueIndex]);
      if (!Number.isFinite(time) || !Number.isFinite(value)) {
        continue;
      }
      byTime.set(time, value);
    }
  }

  return Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
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
    throw new Error(`Invalid ${label}. Expected Influx duration like 30s, 5m, 1h.`);
  }
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function mapFromPoints(points, mapper = (value) => value) {
  const map = new Map();
  for (const point of points) {
    const value = mapper(point.value);
    if (Number.isFinite(value)) {
      map.set(point.time, value);
    }
  }
  return map;
}

function ratioUsageMap(totalMap, availableMap) {
  const out = new Map();
  for (const [time, total] of totalMap.entries()) {
    const available = availableMap.get(time);
    if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) {
      continue;
    }
    out.set(time, clampNumber((1 - available / total) * 100, 0, 100));
  }
  return out;
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
  let time = null;
  let value = null;
  for (const [candidateTime, candidateValue] of map.entries()) {
    if (time === null || candidateTime > time) {
      time = candidateTime;
      value = candidateValue;
    }
  }
  return numOrNull(value);
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

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
