/**
 * OHLCV parsing, descriptors, and surrogate series generation.
 *
 * A "surrogate" is a series with the same volatility, distribution shape and
 * autocorrelation as the input, but with its phase structure destroyed — so it has
 * no trend, no cycle, no story. Running the agents on surrogates answers one
 * question: how much of the result is the data, and how much is the market?
 */
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ parse */

const NUM = (s) => {
  const n = Number(String(s).replace(/[, $%]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

export function parseOHLCV(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 3) throw new Error('need a header and at least two rows');

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
  const at = (...names) => header.findIndex((h) => names.includes(h));

  const iT = at('datetime', 'date', 'time', 'timestamp');
  const iO = at('open', 'o');
  const iH = at('high', 'h');
  const iL = at('low', 'l');
  const iC = at('close', 'adj close', 'adj_close', 'price', 'c');
  const iV = at('volume', 'vol', 'v');

  if (iC < 0) throw new Error('no close column — expected DateTime,open,high,low,close[,volume]');

  const bars = [];
  for (let n = 1; n < lines.length; n++) {
    const cells = lines[n].split(',');
    const c = NUM(cells[iC]);
    if (!Number.isFinite(c) || c <= 0) continue;
    const o = iO >= 0 && Number.isFinite(NUM(cells[iO])) ? NUM(cells[iO]) : c;
    const h = iH >= 0 && Number.isFinite(NUM(cells[iH])) ? NUM(cells[iH]) : Math.max(o, c);
    const l = iL >= 0 && Number.isFinite(NUM(cells[iL])) ? NUM(cells[iL]) : Math.min(o, c);
    const v = iV >= 0 && Number.isFinite(NUM(cells[iV])) ? NUM(cells[iV]) : 0;
    bars.push({
      t: iT >= 0 ? String(cells[iT]).trim().replace(/^["']|["']$/g, '') : `#${bars.length + 1}`,
      o, h, l, c, v,
    });
  }

  if (bars.length < 20) throw new Error(`only ${bars.length} usable rows — need at least 20`);

  const hasVolume = bars.some((b) => b.v > 0);
  return { bars, columns: header, hasVolume, timeframe: detectTimeframe(bars) };
}

/* -------------------------------------------------------------- timeframe */

const NUMERIC_TS = /^\d{10,13}$/;

/** Millisecond timestamp from ISO, "YYYY-MM-DD HH:MM", or an epoch number. */
export function parseTs(value) {
  let raw = String(value ?? '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return NaN;

  // compact stamps: 20230101 (YYYYMMDD) and 20230101153000 (YYYYMMDDHHMMSS)
  if (/^\d{8}$/.test(raw)) {
    return Date.UTC(+raw.slice(0, 4), +raw.slice(4, 6) - 1, +raw.slice(6, 8));
  }
  if (/^\d{14}$/.test(raw)) {
    return Date.UTC(+raw.slice(0, 4), +raw.slice(4, 6) - 1, +raw.slice(6, 8),
      +raw.slice(8, 10), +raw.slice(10, 12), +raw.slice(12, 14));
  }
  if (NUMERIC_TS.test(raw)) return Number(raw.length === 13 ? raw : raw + '000');

  // 2023.01.01 / 2023/01/01 -> 2023-01-01
  raw = raw.replace(/[./]/g, '-');
  const iso = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : ms;
}

function humanInterval(ms) {
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (ms % 604800000 === 0) return plural(ms / 604800000, 'week');
  if (ms % 86400000 === 0) return plural(ms / 86400000, 'day');
  if (ms % 3600000 === 0) return plural(ms / 3600000, 'hour');
  if (ms % 60000 === 0) return `${ms / 60000} min`;
  if (ms % 1000 === 0) return `${ms / 1000} sec`;
  return `${ms} ms`;
}

/**
 * The bar interval the data is actually on. Median rather than mean, so weekend
 * gaps and holidays don't drag a daily series into "1.4 days".
 */
export function detectTimeframe(bars) {
  const ts = bars.map((b) => parseTs(b.t)).filter(Number.isFinite);
  const deltas = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return { ms: null, label: 'unknown', intraday: false };
  deltas.sort((a, b) => a - b);
  const ms = deltas[Math.floor(deltas.length / 2)];
  return { ms, label: humanInterval(ms), intraday: ms < 86400000 };
}

/* ------------------------------------------------------------------ stats */

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

export const returnsOf = (bars) => bars.slice(1).map((b, i) => b.c / bars[i].c - 1);

function acf(xs, lag = 1) {
  const m = mean(xs);
  const d = xs.map((x) => x - m);
  let num = 0, den = 0;
  for (let i = lag; i < d.length; i++) num += d[i] * d[i - lag];
  for (const x of d) den += x * x;
  return den ? num / den : 0;
}

function maxDrawdown(bars) {
  let peak = bars[0].c, worst = 0;
  for (const b of bars) {
    if (b.c > peak) peak = b.c;
    worst = Math.min(worst, b.c / peak - 1);
  }
  return worst;
}

export function describe(bars) {
  const r = returnsOf(bars);
  const m = mean(r);
  const sd = stdev(r);
  const skew = sd
    ? r.reduce((a, x) => a + ((x - m) / sd) ** 3, 0) / r.length
    : 0;
  const kurt = sd
    ? r.reduce((a, x) => a + ((x - m) / sd) ** 4, 0) / r.length - 3
    : 0;

  return {
    bars: bars.length,
    first: bars[0].c,
    last: bars[bars.length - 1].c,
    totalReturn: bars[bars.length - 1].c / bars[0].c - 1,
    meanReturn: m,
    vol: sd,
    skew,
    kurtosis: kurt,
    acf1: acf(r),
    acf1Abs: acf(r.map(Math.abs)),
    maxDrawdown: maxDrawdown(bars),
    avgVolume: bars.some((b) => b.v > 0) ? mean(bars.map((b) => b.v)) : 0,
  };
}

/* -------------------------------------------------------------- surrogates */

export function rng(seed = 1) {
  let a = seed >>> 0 || 1;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Phase-randomised (FT) surrogate: keep every Fourier amplitude, randomise every
 * phase. Preserves the power spectrum (hence the autocorrelation) and the marginal
 * variance; destroys trend, cycle and volatility clustering alignment.
 * Naive DFT is O(n^2) — for a few hundred bars that is microseconds.
 */
function ftSurrogate(r, rand) {
  const n = r.length;
  const x = r.map((v) => v - mean(r));
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let j = 0; j < n; j++) {
      const ang = (TAU * k * j) / n;
      sr += x[j] * Math.cos(ang);
      si += x[j] * Math.sin(ang);
    }
    re[k] = sr; im[k] = si;
  }

  const phases = new Float64Array(n);
  for (let k = 0; k < n; k++) phases[k] = rand() * TAU;
  phases[0] = 0;
  if (n % 2 === 0) phases[n / 2] = 0;

  const nr = new Float64Array(n);
  const ni = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const mirror = (n - k) % n;
    const mag = Math.hypot(re[k], im[k]);
    const ph = phases[k];
    nr[k] = mag * Math.cos(ph);
    ni[k] = mag * Math.sin(ph);
    // conjugate symmetry so the inverse transform is real
    nr[mirror] = nr[k];
    ni[mirror] = -ni[k];
  }

  const out = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let sr = 0;
    for (let k = 0; k < n; k++) {
      const ang = (TAU * k * j) / n;
      sr += nr[k] * Math.cos(ang) - ni[k] * Math.sin(ang);
    }
    out[j] = sr / n;
  }

  // amplitude adjustment: match the original mean and standard deviation
  const m0 = mean(out);
  const s1 = stdev(out) || 1;
  return Array.from(out, (v) => ((v - m0) / s1) * stdev(r) + mean(r));
}

/** Block bootstrap: keeps local shape inside blocks, destroys long-range order. */
function blockSurrogate(r, rand, block) {
  const n = r.length;
  const b = Math.max(2, Math.min(block, Math.floor(n / 2)));
  const out = [];
  while (out.length < n) {
    const start = Math.floor(rand() * Math.max(1, n - b));
    for (let i = 0; i < b && out.length < n; i++) out.push(r[start + i]);
  }
  return out;
}

function shuffleSurrogate(r, rand) {
  const a = [...r];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Rebuild a bar series from a return path, keeping the first close and the volume profile. */
export function seriesFromReturns(bars, rets) {
  const out = [{ ...bars[0] }];
  for (let i = 0; i < rets.length; i++) {
    const prev = out[i].c;
    const c = prev * (1 + rets[i]);
    const o = prev;
    const wick = Math.abs(rets[i]) * 0.35;
    const src = bars[i + 1] || bars[bars.length - 1];
    out.push({
      t: src.t,
      o,
      c,
      h: Math.max(o, c) * (1 + wick),
      l: Math.min(o, c) * (1 - wick),
      v: src.v,
    });
  }
  return out;
}

export function makeSurrogate(bars, { method = 'ft', seed = 1, block = 8, index = 0 } = {}) {
  const rand = rng(seed * 7919 + index * 104729 + 13);
  const r = returnsOf(bars);
  let next;
  const m = String(method || 'ft').toLowerCase();
  if (m === 'shuffle') next = shuffleSurrogate(r, rand);
  else if (m === 'block') next = blockSurrogate(r, rand, block);
  else next = ftSurrogate(r, rand);   // aaft, iaaft and ft all fall back to phase randomisation
  return seriesFromReturns(bars, next);
}

/* ------------------------------------------------------ a fictional series */

/**
 * A made-up price path for the default run: no file, no surrogates, just something
 * with vol clustering and a slow regime so the agents have structure to trade.
 */
export function synthSeries({ n = 120, seed = 20240102, start = 100 } = {}) {
  const rand = rng(seed);
  let c = start;
  let vol = 0.012;
  const bars = [];
  const t0 = Date.UTC(2024, 0, 2);

  for (let i = 0; i < n; i++) {
    vol = Math.max(0.005, vol * 0.94 + 0.06 * (0.006 + rand() * 0.016));
    const drift = Math.sin(i / 34) * 0.0016 + 0.0002;
    const r = drift + (rand() - 0.5) * 2 * vol;
    const o = c;
    c = c * (1 + r);
    const w = Math.abs(r) * 0.6 + vol * 0.3;
    bars.push({
      t: new Date(t0 + i * 86400000).toISOString().slice(0, 10),
      o,
      c,
      h: Math.max(o, c) * (1 + w * rand()),
      l: Math.min(o, c) * (1 - w * rand()),
      v: Math.round(400000 * (0.6 + rand() * 0.9) * (1 + Math.abs(r) * 25)),
    });
  }
  return bars;
}

/* ------------------------------------------------------------------- misc */

/** Pearson correlation of two close paths — 0 means the shape is unrelated. */
export function pathCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const xa = a.slice(0, n).map((x) => x.c);
  const xb = b.slice(0, n).map((x) => x.c);
  const ma = mean(xa), mb = mean(xb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (xa[i] - ma) * (xb[i] - mb);
    da += (xa[i] - ma) ** 2;
    db += (xb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function csvOf(bars) {
  const rows = ['DateTime,open,high,low,close,volume'];
  for (const b of bars) {
    rows.push([b.t, b.o.toFixed(4), b.h.toFixed(4), b.l.toFixed(4), b.c.toFixed(4), Math.round(b.v)].join(','));
  }
  return rows.join('\n');
}
