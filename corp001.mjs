/**
 * CORPORATION 001 — Telegram surface.
 *
 * A thin controller over the running app: it starts replays on the local server,
 * waits a bounded time, and reports the same numbers the browser shows. All the
 * domain state stays in corp-001; this app only remembers the last summary.
 */
const BASE = process.env.CORP001_URL || 'http://127.0.0.1:4362';
const TOKEN = process.env.CORP001_TOKEN || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => (n < 0.001 ? `$${Number(n).toFixed(7)}` : `$${Number(n).toFixed(4)}`);
const pct = (x) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(2)}%`;

async function api(path, init = {}) {
  const headers = {
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(TOKEN ? { 'x-access-token': TOKEN } : {}),
  };
  const r = await fetch(BASE + path, { ...init, headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(json?.error || `server ${r.status}`);
  return json;
}

const buttons = (rows) => `<!-- telegram_button ${JSON.stringify(rows)} -->`;

const PANEL = [
  [{ label: '▶ fictional', prompt: 'corp001::fictional' },
   { label: '📈 csv', prompt: 'corp001::csv' }],
  [{ label: '🎲 surrogates', prompt: 'corp001::surrogates' },
   { label: '⟳ status', prompt: 'corp001::status' }],
];

/** Starts a run and waits up to `waitMs` for it to finish. */
async function startRun(body, waitMs = 14000) {
  const { id } = await api('/api/replay/run', { method: 'POST', body: JSON.stringify(body) });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    const s = await api('/api/replay/result?id=' + encodeURIComponent(id));
    if (s.done) return { done: true, ...s };
  }
  return { done: false, id };
}

function report(meta, outcome) {
  const o = outcome?.original;
  const m = o?.metrics;
  const tf = meta?.timeframe?.label || '—';
  const src = meta?.source === 'csv' ? 'CSV' : 'fictional series';
  const traded = o?.bars ?? meta?.maxBars ?? '?';
  const lines = [
    `**${src}** · ${traded} of ${meta?.bars?.n ?? '?'} bars · ${tf}`,
    meta?.bars?.from && meta?.bars?.to ? `\`${meta.bars.from} → ${meta.bars.to}\`` : '',
    '',
    `delta **${pct(m?.deltaPct)}**  ·  tracking error ${Number(m?.trackingErrorPct ?? 0).toFixed(2)}%`,
    `direction agreement ${Number(m?.directionAgreementPct ?? 0).toFixed(0)}%  ·  corr ${Number(m?.corr ?? 0).toFixed(2)}`,
    `jev ${pct(m?.jevReturnPct)}  ·  actual ${pct(m?.totalReturnPct)}`,
    `bill ${money(o?.bill?.cost ?? 0)}`,
  ].filter(Boolean);

  if (outcome?.surrogates?.length) {
    lines.push('', '**surrogates**');
    for (const s of outcome.surrogates) {
      lines.push(
        `\`${String(s.k).padStart(2)}\` vol ${Number(s.stats.vol * 100).toFixed(2)}%  ` +
        `ρ ${Number(s.pathCorrelation).toFixed(2)}  delta ${pct(s.metrics.deltaPct)}`,
      );
    }
    const ds = outcome.surrogates.map((s) => s.metrics.deltaPct);
    const mu = ds.reduce((a, b) => a + b, 0) / ds.length;
    const sd = Math.sqrt(ds.reduce((a, x) => a + (x - mu) ** 2, 0) / ds.length);
    lines.push(`original ${pct(m.deltaPct)} vs surrogates ${pct(mu)} ± ${sd.toFixed(2)}%`);
  }
  return lines.join('\n');
}

export async function init({ argument }) {
  let health = 'unreachable';
  try {
    const s = await api('/api/state');
    health = `live market · round ${s.round} · ${money(s.bill?.total?.cost ?? 0)} spent`;
  } catch (err) {
    health = `cannot reach ${BASE} (${err.message})`;
  }
  const body = `**Corporation 001**

${health}

A replay feeds the five Jevs a price path one bar at a time — never a future bar —
and measures their capital path against the actual one.

${buttons(PANEL)}`;
  return { state: { base: BASE, last: null, csvPath: argument?.csv || null }, output: body };
}

export async function status({ state }) {
  const lines = [`**status**`, `server ${state?.base || BASE}`];
  try {
    const s = await api('/api/state');
    lines.push(`live market round ${s.round} · bill ${money(s.bill?.total?.cost ?? 0)}`);
    const last = await api('/api/replay/last');
    if (last?.none) lines.push('no replay run yet');
    else lines.push(`last replay: ${last.meta?.source} · ${last.meta?.bars?.n} bars · ${last.meta?.timeframe?.label}`);
  } catch (err) {
    lines.push(`error: ${err.message}`);
  }
  if (state?.csvPath) lines.push(`csv: \`${state.csvPath}\``);
  lines.push('', buttons(PANEL));
  return { output: lines.join('\n') };
}

export async function fictional({ state }) {
  const res = await startRun({ source: 'synth', bars: 14, surrogates: 0, seed: 7, costBps: 6 });
  if (!res.done) {
    return {
      state: { ...state, last: res.id },
      output: `**running** — the agents are still working through the bars.\n\n${buttons([[{ label: '⟳ check', prompt: 'corp001::status' }]])}`,
    };
  }
  return {
    state: { ...state, last: res.id },
    output: `${report(res.meta, res.outcome)}\n\n${buttons(PANEL)}`,
  };
}

export async function csv({ state, argument }) {
  const path = argument?.path || state?.csvPath;
  if (!path) {
    return {
      output: `**no csv**\n\nSend me a CSV (DateTime,open,high,low,close[,volume]) and then press this again, or run with \`{"path":"..."}\`.\n\n${buttons(PANEL)}`,
    };
  }
  let text;
  try {
    const { readFile } = await import('node:fs/promises');
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { output: `**cannot read** \`${path}\`\n\n${err.message}\n\n${buttons(PANEL)}` };
  }
  const res = await startRun({ source: 'csv', csv: text, bars: 14, surrogates: 0, seed: 7, costBps: 6 });
  if (!res.done) {
    return {
      state: { ...state, last: res.id, csvPath: path },
      output: `**running**\n\n${buttons([[{ label: '⟳ check', prompt: 'corp001::status' }]])}`,
    };
  }
  return {
    state: { ...state, last: res.id, csvPath: path },
    output: `${report(res.meta, res.outcome)}\n\n${buttons(PANEL)}`,
  };
}

export async function surrogates({ state, argument }) {
  const path = argument?.path || state?.csvPath;
  if (!path) {
    return { output: `**surrogates need a csv** — fictional runs have none, by design.\n\n${buttons(PANEL)}` };
  }
  const n = Math.max(1, Math.min(3, Number(argument?.n) || 2));
  let text;
  try {
    const { readFile } = await import('node:fs/promises');
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { output: `**cannot read** \`${path}\`\n\n${err.message}` };
  }
  const res = await startRun({ source: 'csv', csv: text, bars: 12, surrogates: n, seed: 7, costBps: 6 }, 22000);
  if (!res.done) {
    return {
      state: { ...state, last: res.id, csvPath: path },
      output: `**running** — ${n} surrogates take about a minute.\n\n${buttons([[{ label: '⟳ check', prompt: 'corp001::status' }]])}`,
    };
  }
  return {
    state: { ...state, last: res.id, csvPath: path },
    output: `${report(res.meta, res.outcome)}\n\n${buttons(PANEL)}`,
  };
}

export async function refresh({ state }) {
  return { output: await exportStateText(state) };
}

async function exportStateText(state) {
  return `**corp001** · last run ${state?.last || 'none'}`;
}
