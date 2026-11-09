/**
 * CORPORATION 001 — market server.
 * SSE push, one loop, four controls. No dependencies.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { freshMarket, runRound, setDepth, ASSET } from './market.mjs';
import { parseOHLCV, describe, makeSurrogate, synthSeries, pathCorrelation, returnsOf, seriesFromReturns } from './ohlcv.mjs';
import { juliaSurrogates } from './julia-surrogates.mjs';
import { replaySeries, DEFAULTS } from './replay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4362);
const HOST = process.env.HOST || '127.0.0.1';
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || '').trim();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

let market = freshMarket();
let running = false;
let busy = false;
let speed = 'normal';
let timer = null;
const clients = new Set();

const delay = () => (speed === 'turbo' ? 0 : speed === 'slow' ? 1400 : 350);

/**
 * Optional shared-secret gate for /api/*. Without ACCESS_TOKEN the API is open,
 * which is fine on localhost and dangerous on a public host: every round spends
 * your TypeSafe credits.
 */
function authorised(req, url) {
  if (!ACCESS_TOKEN) return true;
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const supplied = bearer || String(req.headers['x-access-token'] || '') || url.searchParams.get('token') || '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(ACCESS_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.write(frame); } catch { clients.delete(c); }
  }
}

/** The one payload the UI renders. Keep it small — it ships every round. */
function snapshot() {
  return {
    asset: ASSET,
    round: market.round,
    mid: market.mid,
    fair: market.fair,
    bid: market.bid,
    ask: market.ask,
    spreadBps: market.spreadBps,
    book: market.book,
    levels: market.levels,
    tape: market.tape.slice(-14),
    news: market.news.slice(-4),
    history: market.history.slice(-180),
    sessionOpen: market.history[0]?.mid ?? market.mid,
    stats: market.stats,
    bill: market.bill,
    lastRoundMs: market.lastRoundMs,
    agents: market.agents.map((a) => ({
      id: a.id, name: a.name, role: a.role, kind: a.kind, blurb: a.blurb,
      position: a.position, cash: Math.round(a.cash), pnl: a.pnl,
      fills: a.fills, last: a.last,
    })),
    running,
    busy,
    speed,
  };
}

async function step({ broadcastThinking = true } = {}) {
  if (busy) return;
  busy = true;
  if (broadcastThinking) broadcast('thinking', { round: market.round + 1 });
  try {
    await runRound(market);
    broadcast('round', snapshot());
  } catch (err) {
    broadcast('error', { message: err.message });
  } finally {
    busy = false;
  }
}

function loop() {
  if (!running) return;
  step().finally(() => {
    if (running) timer = setTimeout(loop, delay());
  });
}

function start() {
  if (running) return;
  running = true;
  broadcast('control', { running, speed });
  loop();
}

function pause() {
  running = false;
  clearTimeout(timer);
  broadcast('control', { running, speed });
}

/* ------------------------------------------------------------ replay jobs */

const jobs = new Map();
const barMeta = (bars) => ({
  n: bars.length,
  from: bars[0].t,
  to: bars[bars.length - 1].t,
  first: bars[0].c,
  last: bars[bars.length - 1].c,
});

const readBodyLimited = (req, limit) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

function emit(job, type, data) {
  job.events.push({ type, data });
  if (type === 'done') job.outcome = data;
  if (type === 'meta') job.meta = data;
  if (type === 'error') job.failure = data.message;
  for (const res of job.subscribers) {
    try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { job.subscribers.delete(res); }
  }
}

/**
 * A run is a job, not a request: it streams one event per bar so the browser can
 * draw the path while the agents are still thinking, and it can be cancelled
 * halfway without leaving a half-written response behind.
 */
async function runJob(job, params) {
  const source = params.source === 'csv' ? 'csv' : 'synth';
  const parsed = source === 'csv' ? parseOHLCV(params.csv) : null;
  const bars = parsed ? parsed.bars : synthSeries({ n: 160, seed: Number(params.seed) || DEFAULTS.seed });
  const timeframe = parsed ? parsed.timeframe : { ms: 86400000, label: '1 day', intraday: false };

  const stats = describe(bars);
  const wantSurrogates = source === 'csv' ? Math.max(0, Math.min(8, Number(params.surrogates) || 0)) : 0;
  const cfg = {
    maxBars: Math.min(Number(params.bars) || DEFAULTS.maxBars, bars.length - 1),
    costBps: Number(params.costBps) || DEFAULTS.costBps,
  };

  emit(job, 'meta', {
    source,
    bars: barMeta(bars),
    timeframe,
    // describe the window the agents will actually trade, so the original row in the
    // surrogate table is measured over exactly the same bars as every surrogate
    stats: describe(bars.slice(0, cfg.maxBars + 1)),
    statsFull: stats,
    surrogates: wantSurrogates,
    method: params.method || DEFAULTS.method,
    costBps: cfg.costBps,
    maxBars: cfg.maxBars,
  });

  const base = await replaySeries(bars, cfg, {
    shouldCancel: () => job.cancel,
    onBar: (bar, decisions) => emit(job, 'bar', { phase: 'original', bar, decisions }),
    onProgress: (p) => emit(job, 'progress', { phase: 'original', ...p }),
  });

  emit(job, 'original', { result: base });
  if (job.cancel) { emit(job, 'done', { cancelled: true }); return; }

  // --- surrogates: TimeseriesSurrogates.jl when available, built-in FT otherwise
  let surrogateSeries = [];
  let engine = 'built-in phase randomiser';
  if (wantSurrogates) {
    emit(job, 'progress', { phase: 'generating surrogates', i: 0, maxBars: wantSurrogates });
    try {
      const out = await juliaSurrogates(returnsOf(bars), {
        count: wantSurrogates,
        method: params.method || DEFAULTS.method,
        seed: Number(params.seed) || DEFAULTS.seed,
        block: Number(params.block) || DEFAULTS.block,
      });
      surrogateSeries = out.series.map((r) => seriesFromReturns(bars, r));
      engine = `${out.engine} · ${out.method.toUpperCase()}`;
    } catch (err) {
      engine = `built-in phase randomiser (julia unavailable: ${err.message})`;
      for (let k = 1; k <= wantSurrogates; k++) {
        surrogateSeries.push(makeSurrogate(bars, {
          method: params.method || DEFAULTS.method,
          seed: Number(params.seed) || DEFAULTS.seed,
          block: Number(params.block) || DEFAULTS.block,
          index: k,
        }));
      }
    }
    emit(job, 'surrogateEngine', { engine });
  }

  const surrogates = [];
  for (let k = 1; k <= wantSurrogates; k++) {
    if (job.cancel) break;
    const s = surrogateSeries[k - 1];
    const used = Math.min(cfg.maxBars + 1, s.length);
    emit(job, 'surrogateStart', { k, of: wantSurrogates });
    const res = await replaySeries(s, cfg, {
      shouldCancel: () => job.cancel,
      onProgress: (p) => emit(job, 'progress', { phase: `surrogate ${k}`, ...p }),
    });
    const row = {
      k,
      engine,
      stats: describe(s.slice(0, used)),
      metrics: res.metrics,
      pathCorrelation: Number(pathCorrelation(bars.slice(0, used), s.slice(0, used)).toFixed(3)),
      // the closes the agents actually traded, so the web can draw surrogate k as
      // exactly the series that produced row k
      path: s.slice(0, used).map((b) => Number(b.c.toFixed(4))),
      bill: res.bill,
    };
    surrogates.push(row);
    emit(job, 'surrogate', row);
  }

  emit(job, 'done', { cancelled: job.cancel, original: base, surrogates, stats });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/') && !authorised(req, url)) {
    return send(res, 401, JSON.stringify({ error: 'unauthorised' }));
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    res.write(`event: round\ndata: ${JSON.stringify(snapshot())}\n\n`);
    const beat = setInterval(() => {
      try { res.write(': beat\n\n'); } catch {}
    }, 20000);
    req.on('close', () => { clearInterval(beat); clients.delete(res); });
    return;
  }

  if (url.pathname === '/api/state') return send(res, 200, JSON.stringify(snapshot()));

  // The whole session, compact — fetched once when the chart is zoomed out to "all",
  // then extended client-side by one point per round. Kept off the SSE payload.
  if (url.pathname === '/api/history') {
    return send(
      res,
      200,
      JSON.stringify({
        asset: ASSET,
        round: market.round,
        points: market.history.map((p) => ({ r: p.round, m: p.mid, f: p.fair })),
      }),
    );
  }

  if (req.method === 'POST' && url.pathname === '/api/replay/run') {
    let params = {};
    try { params = JSON.parse(await readBodyLimited(req, 12 * 1024 * 1024)); } catch {}
    if (params.source === 'csv' && !params.csv) {
      return send(res, 400, JSON.stringify({ error: 'source "csv" needs a csv payload' }));
    }
    const id = randomUUID();
    const job = { id, cancel: false, events: [], subscribers: new Set(), done: false };
    jobs.set(id, job);
    runJob(job, params)
      .catch((err) => emit(job, 'error', { message: err.message }))
      .finally(() => { job.done = true; emit(job, 'close', {}); });
    if (jobs.size > 10) jobs.delete(jobs.keys().next().value);
    return send(res, 200, JSON.stringify({ id }));
  }

  if (req.method === 'POST' && url.pathname === '/api/replay/cancel') {
    let body = {};
    try { body = JSON.parse(await readBodyLimited(req, 4096)); } catch {}
    const job = jobs.get(body.id);
    if (job) job.cancel = true;
    return send(res, 200, JSON.stringify({ ok: !!job }));
  }

  if (url.pathname === '/api/replay/result') {
    const job = jobs.get(url.searchParams.get('id'));
    if (!job) return send(res, 404, JSON.stringify({ error: 'unknown job' }));
    return send(res, 200, JSON.stringify({
      id: job.id,
      done: job.done,
      cancelled: Boolean(job.cancel),
      failure: job.failure || null,
      meta: job.meta || null,
      barCount: job.events.filter((e) => e.type === 'bar').length,
      outcome: job.outcome || null,
    }));
  }

  if (url.pathname === '/api/replay/last') {
    const done = [...jobs.values()].filter((j) => j.outcome).pop();
    if (!done) return send(res, 200, JSON.stringify({ none: true }));
    return send(res, 200, JSON.stringify({ id: done.id, meta: done.meta, outcome: done.outcome }));
  }

  if (url.pathname === '/api/replay/stream') {
    const job = jobs.get(url.searchParams.get('id'));
    if (!job) return send(res, 404, JSON.stringify({ error: 'unknown job' }));

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    for (const frame of job.events) {
      res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`);
    }
    if (job.done) return res.end();
    job.subscribers.add(res);
    const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(beat); job.subscribers.delete(res); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/control') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}

    switch (body.cmd) {
      case 'start': start(); break;
      case 'pause': pause(); break;
      case 'step': pause(); await step(); break;
      case 'reset': pause(); market = freshMarket(); broadcast('round', snapshot()); break;
      case 'depth':
        setDepth(market, body.value);
        broadcast('round', snapshot());
        break;
      case 'speed':
        speed = ['slow', 'normal', 'turbo'].includes(body.value) ? body.value : 'normal';
        broadcast('control', { running, speed });
        break;
      default: return send(res, 400, JSON.stringify({ error: 'unknown command' }));
    }
    return send(res, 200, JSON.stringify({ ok: true, running, speed, csv: !!body.cmd }));
  }

  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    if (rel.includes('..')) return send(res, 400, 'bad path', 'text/plain');
    try {
      const file = await readFile(join(HERE, rel));
      return send(res, 200, file, TYPES[extname(rel)] || 'application/octet-stream');
    } catch {
      return send(res, 404, 'not found', 'text/plain');
    }
  }

  return send(res, 404, 'not found', 'text/plain');
});

const lanAddresses = () => {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
};

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`
  CORPORATION 001  →  http://${shown}:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const lan of lanAddresses()) console.log(`  on the network    →  http://${lan}:${PORT}`);
    console.log('  open that on the phone, or send it to yourself in Telegram');
  }
  console.log(`  ${ACCESS_TOKEN ? 'API gated by ACCESS_TOKEN' : 'API open (set ACCESS_TOKEN before exposing this host)'}
`);
});
