/* Corporation 001 — replay view.
 * Loaded after the main inline script, so it shares the same global scope:
 * mode, esc, money, cssVar, tint, authHeaders, TOKEN all come from there.
 */

const R = {
  source: 'synth',
  csvName: '',
  csvText: '',
  csvSummary: '',
  running: false,
  jobId: null,
  es: null,
  watchdog: null,
  meta: null,
  path: [],
  result: null,
  surrogates: [],
  engine: '',
  zoom: null,
  zoomed: false,
  focus: null,
};

const rEl = (id) => document.getElementById(id);

// One hue per surrogate, reused in the chart, the label and the table chip, so
// "surrogate 2" always means the same line. Muted on purpose: the amber Jev path
// and the white mid line must stay dominant.
const SURROGATE_HUES = ['#6f8fb5', '#8a7fa8', '#6f9f8c', '#b08a6a', '#7f8fa6', '#a08a9c', '#8fb0b5', '#a89a6f'];
const hueOf = (k) => SURROGATE_HUES[(Number(k) - 1) % SURROGATE_HUES.length];

/**
 * Switching source never throws the loaded file away — a file you picked stays
 * picked. Only the controls that do not apply get disabled, and the readiness
 * line always says which path the next run will take.
 */
function setSource(src) {
  R.source = src;
  [...rEl('rSource').children].forEach((b) => b.classList.toggle('on', b.dataset.source === src));
  const isCsv = src === 'csv';
  rEl('rDrop').hidden = !isCsv;
  rEl('rSurr').disabled = !isCsv;
  rEl('rMethod').disabled = !isCsv;
  if (!isCsv) rEl('rSurr').value = 0;
  else if (!Number(rEl('rSurr').value)) rEl('rSurr').value = 3;
  paintDrop();
  refreshReady();
}

/** The drop box shows the loaded file, or the invitation. */
function paintDrop() {
  if (!rEl('rDrop')) return;
  rEl('rDrop').innerHTML = R.csvName
    ? '<b>' + esc(R.csvName) + '</b> · ' + R.csvSummary
    : 'drop a CSV · DateTime,open,high,low,close[,volume]';
}

/** What the next press of run will actually do. */
function refreshReady() {
  if (R.running) return;
  rEl('rMeta').textContent = R.source === 'csv'
    ? (R.csvName ? 'ready · ' + R.csvName + ' · ' + R.csvSummary : 'ready · csv — choose a file first')
    : 'ready · fictional series · no surrogates';
}

rEl('rSource').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) setSource(b.dataset.source);
};

rEl('rDrop').onclick = () => rEl('rFile').click();
rEl('rDrop').ondragover = (e) => { e.preventDefault(); rEl('rDrop').classList.add('on'); };
rEl('rDrop').ondragleave = () => rEl('rDrop').classList.remove('on');
rEl('rDrop').ondrop = (e) => { e.preventDefault(); rEl('rDrop').classList.remove('on'); loadCsv(e.dataTransfer.files[0]); };
rEl('rFile').onchange = (e) => loadCsv(e.target.files[0]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Cheap prefix scan: rows, first/last stamp, and the bar interval, before we send anything. */
function quickScan(text) {
  const lines = text.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const iT = head.findIndex((h) => ['datetime', 'date', 'time', 'timestamp'].includes(h));
  const rows = lines.slice(1);
  const isNumeric = (v) => v.length > 0 && v.split('').every((c) => c >= '0' && c <= '9');
  const tsOf = (raw) => {
    let v = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
    if (!v) return NaN;
    if (v.length === 8 && isNumeric(v)) return Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8));
    if (v.length === 14 && isNumeric(v)) {
      return Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(8, 10), +v.slice(10, 12), +v.slice(12, 14));
    }
    if (isNumeric(v)) return Number(v.length === 13 ? v : v + '000');
    v = v.replace(/[./]/g, '-');
    const iso = v.includes(' ') && !v.includes('T') ? v.replace(' ', 'T') : v;
    const n = Date.parse(iso);
    return Number.isNaN(n) ? NaN : n;
  };
  const times = iT < 0 ? [] : rows.slice(0, 400).map((l) => tsOf(l.split(',')[iT])).filter(Number.isFinite);
  const deltas = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) deltas.push(times[i] - times[i - 1]);
  deltas.sort((a, b) => a - b);
  const ms = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;
  return {
    rows: rows.length,
    from: iT >= 0 ? String(rows[0].split(',')[iT]).trim() : '',
    to: iT >= 0 ? String(rows[rows.length - 1].split(',')[iT]).trim() : '',
    ms,
  };
}

const labelMs = (ms) => {
  if (!ms) return null;
  const p = (n, u) => n + ' ' + u + (n === 1 ? '' : 's');
  if (ms % 604800000 === 0) return p(ms / 604800000, 'week');
  if (ms % 86400000 === 0) return p(ms / 86400000, 'day');
  if (ms % 3600000 === 0) return p(ms / 3600000, 'hour');
  if (ms % 60000 === 0) return ms / 60000 + ' min';
  return ms / 1000 + ' sec';
};

const tsLabel = (t, intraday) => {
  const s = String(t || '');
  if (intraday) {
    const m = s.match(/[T ](\d{2}:\d{2})/) || s.match(/^\d{8}(\d{2})(\d{2})/);
    return m ? m[1] + ':' + m[2] : '';
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/) || s.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (iso) return MONTHS[Number(iso[2]) - 1] + ' ' + Number(iso[3]);
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return MONTHS[Number(compact[2]) - 1] + ' ' + Number(compact[3]);
  return s;
};

async function loadCsv(file) {
  if (!file) return;
  R.csvText = await file.text();
  R.csvName = file.name;
  const scan = quickScan(R.csvText);
  const tf = labelMs(scan.ms);
  R.csvSummary = scan.rows + ' bars' + (tf ? ' · ' + tf : '') +
    (scan.from ? ' · ' + String(scan.from).slice(0, 19) + ' → ' + String(scan.to).slice(0, 19) : '');
  // picking a CSV is an intent to use it
  setSource('csv');
  paintDrop();
  refreshReady();
}

document.addEventListener('drop', (e) => {
  if (typeof mode === 'undefined' || mode !== 'replay') return;
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && (/\.csv$/i.test(f.name) || f.type === 'text/csv')) {
    e.preventDefault();
    e.stopPropagation();
    loadCsv(f);
  }
}, true);

function resetReplay() {
  R.path = [];
  R.result = null;
  R.surrogates = [];
  R.engine = '';
  R.zoom = null;
  R.zoomed = false;
  R.focus = null;
  R.meta = null;
  rEl('rBar').style.width = '0%';
  rEl('rPhase').textContent = 'idle';
  rEl('rDelta').textContent = '—';
  rEl('rDelta').className = 'big';
  rEl('rJev').textContent = '—';
  rEl('rActual').textContent = '—';
  rEl('rMetrics').innerHTML = '<div class="metric"><div class="k">delta</div><div class="v">—</div></div>';
  rEl('rSurrCard').hidden = true;
  const lg = rEl('rSurrLegend');
  if (lg) lg.hidden = true;
  rEl('rSurrTable').innerHTML = '';
  rEl('rSurrNote').textContent = '';
  drawReplayChart();
  refreshReady();
}

rEl('rRun').onclick = async () => {
  if (R.running) {
    rEl('rMeta').textContent = 'a run is already in flight — press cancel to stop it';
    return;
  }
  if (R.source === 'csv' && !R.csvText.trim()) {
    rEl('rMeta').textContent = 'csv selected but no file loaded — opening the picker';
    rEl('rFile').click();
    return;
  }
  resetReplay();
  R.running = true;
  rEl('rRun').disabled = true;
  rEl('rCancel').disabled = false;
  rEl('rPhase').textContent = 'starting';
  rEl('rMeta').textContent = 'submitting…';

  const body = {
    source: R.source,
    csv: R.source === 'csv' ? R.csvText : undefined,
    bars: Number(rEl('rBars').value) || 36,
    surrogates: R.source === 'csv' ? Number(rEl('rSurr').value) || 0 : 0,
    method: rEl('rMethod').value,
    seed: Number(rEl('rSeed').value) || 7,
    costBps: Number(rEl('rCost').value) || 6,
  };

  try {
    const res = await fetch('/api/replay/run', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
    R.jobId = json.id;
    openStream(json.id);
  } catch (err) {
    fail(err.message);
  }
};

rEl('rCancel').onclick = async () => {
  if (!R.jobId) return;
  await fetch('/api/replay/cancel', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ id: R.jobId }),
  });
  rEl('rPhase').textContent = 'cancelling';
};

function fail(message) {
  clearTimeout(R.watchdog);
  if (R.es) { try { R.es.close(); } catch {} }
  R.running = false;
  rEl('rRun').disabled = false;
  rEl('rCancel').disabled = true;
  rEl('rPhase').textContent = 'error';
  rEl('rMeta').textContent = message;
}

function openStream(id) {
  if (R.es) R.es.close();
  const q = '?id=' + encodeURIComponent(id) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '');
  const es = new EventSource('/api/replay/stream' + q);
  R.es = es;

  // a stream that dies without a `done` must not leave the run button locked
  clearTimeout(R.watchdog);
  R.watchdog = setTimeout(() => {
    if (R.running) fail('the stream went quiet — the run may still be going server-side');
  }, 8 * 60 * 1000);

  es.addEventListener('meta', (e) => {
    const m = JSON.parse(e.data);
    R.meta = m;
    rEl('rMeta').textContent =
      (m.source === 'csv' ? 'CSV' : 'fictional') + ' · ' + m.bars.n + ' bars' +
      (m.timeframe && m.timeframe.label ? ' · ' + m.timeframe.label : '') + ' · ' + m.bars.from + ' → ' + m.bars.to +
      (m.surrogates ? ' · ' + m.surrogates + ' surrogate' + (m.surrogates > 1 ? 's' : '') : ' · no surrogates');
    rEl('rPhase').textContent = 'replaying';
    if (m.surrogates) renderSurrogates();
  });

  es.addEventListener('bar', (e) => {
    R.path.push(JSON.parse(e.data).bar);
    drawReplayChart();
    updateHead();
  });

  es.addEventListener('progress', (e) => {
    const p = JSON.parse(e.data);
    rEl('rBar').style.width = ((p.maxBars ? p.i / p.maxBars : 0) * 100).toFixed(1) + '%';
    rEl('rPhase').textContent = p.phase;
  });

  es.addEventListener('original', (e) => {
    R.result = JSON.parse(e.data).result;
    renderResult();
  });

  es.addEventListener('surrogateEngine', (e) => {
    R.engine = JSON.parse(e.data).engine;
    renderSurrogates();          // shows N rows, all pending
  });

  es.addEventListener('surrogate', (e) => {
    R.surrogates.push(JSON.parse(e.data));
    renderSurrogates();
    drawReplayChart();
  });

  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data);
    clearTimeout(R.watchdog);
    R.running = false;
    rEl('rRun').disabled = false;
    rEl('rCancel').disabled = true;
    rEl('rPhase').textContent = d.cancelled ? 'cancelled' : 'done';
  });

  es.addEventListener('error', (e) => {
    let msg = 'stream error';
    try { msg = JSON.parse(e.data).message || msg; } catch {}
    fail(msg);
  });

  es.addEventListener('close', () => {
    es.close();
    clearTimeout(R.watchdog);
    R.running = false;
    rEl('rRun').disabled = false;
    rEl('rCancel').disabled = true;
  });
}

function updateHead() {
  if (!R.path.length) return;
  const last = R.path[R.path.length - 1];
  const d = last.jev - last.close;
  const dp = (d / last.close) * 100;
  const el = rEl('rDelta');
  el.textContent = (d >= 0 ? '+' : '') + d.toFixed(2) + ' (' + (dp >= 0 ? '+' : '') + dp.toFixed(2) + '%)';
  el.className = 'big ' + (d >= 0 ? 'up' : 'dn');
  rEl('rJev').textContent = last.jev.toFixed(2);
  rEl('rActual').textContent = last.close.toFixed(2);
}

function renderResult() {
  const m = R.result && R.result.metrics;
  if (!m) return;
  const items = [
    ['delta', (m.delta >= 0 ? '+' : '') + m.delta.toFixed(2), m.delta >= 0 ? 'up' : 'dn'],
    ['delta %', (m.deltaPct >= 0 ? '+' : '') + m.deltaPct.toFixed(2) + '%', m.deltaPct >= 0 ? 'up' : 'dn'],
    ['tracking error', m.trackingErrorPct.toFixed(2) + '%'],
    ['direction agreement', m.directionAgreementPct.toFixed(0) + '%'],
    ['correlation', m.corr.toFixed(2)],
    ['jev return', (m.jevReturnPct >= 0 ? '+' : '') + m.jevReturnPct.toFixed(2) + '%', m.jevReturnPct >= 0 ? 'up' : 'dn'],
    ['actual return', (m.totalReturnPct >= 0 ? '+' : '') + m.totalReturnPct.toFixed(2) + '%'],
    ['jev volatility', m.jevVolPct.toFixed(2) + '%'],
    ['bars', String(m.bars)],
    ['bill', money((R.result.bill && R.result.bill.cost) || 0)],
  ];
  rEl('rMetrics').innerHTML = items.map((it) =>
    '<div class="metric"><div class="k">' + esc(it[0]) + '</div><div class="v ' + (it[2] || '') + '">' + esc(it[1]) + '</div></div>'
  ).join('');
}

function renderSurrogates() {
  const wanted = Number(R.meta?.surrogates || 0);
  if (!wanted && !R.surrogates.length) return;

  rEl('rSurrCard').hidden = false;
  const legend = rEl('rSurrLegend');
  if (legend) legend.hidden = false;
  const head = rEl('rSurrCard').querySelector('h3');
  if (head) {
    const done = R.surrogates.length;
    head.textContent = 'surrogate study' +
      (done < wanted ? ` · ${done} of ${wanted} running` : '');
  }

  const cols = [
    ['series', (r) => r.label],
    ['return', (r) => (r.stats.totalReturn * 100).toFixed(2) + '%'],
    ['vol', (r) => (r.stats.vol * 100).toFixed(2) + '%'],
    ['skew', (r) => r.stats.skew.toFixed(2)],
    ['acf(1)', (r) => r.stats.acf1.toFixed(3)],
    ['max dd', (r) => (r.stats.maxDrawdown * 100).toFixed(1) + '%'],
    ['path ρ', (r) => (r.pathCorrelation === undefined ? '1.000' : r.pathCorrelation.toFixed(3))],
    ['delta', (r) => (Number.isFinite(r.metrics?.deltaPct)
      ? (r.metrics.deltaPct >= 0 ? '+' : '') + r.metrics.deltaPct.toFixed(2) + '%' : '—')],
    ['dir. agree', (r) => (Number.isFinite(r.metrics?.directionAgreementPct)
      ? r.metrics.directionAgreementPct.toFixed(0) + '%' : '—')],
  ];

  const chip = (k) =>
    '<span class="chipdot" style="background:' + hueOf(k) + '"></span>';

  const done = new Map(R.surrogates.map((s) => [s.k, s]));
  const rows = [{
    label: 'original',
    html: 'original',
    stats: R.meta.stats,
    metrics: R.result ? R.result.metrics : { deltaPct: NaN, directionAgreementPct: NaN },
    pendingNotYet: !R.result,
  }];

  // every configured surrogate gets a row immediately — pending ones say so
  for (let k = 1; k <= wanted; k++) {
    const s = done.get(k);
    rows.push(s
      ? { k, label: 'surrogate ' + k, html: chip(k) + 'surrogate ' + k, stats: s.stats, metrics: s.metrics, pathCorrelation: s.pathCorrelation }
      : { k, label: 'surrogate ' + k, html: chip(k) + 'surrogate ' + k, pending: true });
  }

  rEl('rSurrTable').innerHTML =
    '<table class="billtable"><thead><tr>' + cols.map((c) => '<th>' + c[0] + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => r.pending
      ? '<tr class="pending"><td>' + r.html + '</td><td class="n" colspan="' + (cols.length - 1) + '">running…</td></tr>'
      : '<tr data-k="' + (r.k || 0) + '" class="' + (R.focus && R.focus === r.k ? 'focused' : '') + '">' +
        cols.map((c, i) => '<td class="' + (i ? 'n' : '') + '">' + (i === 0 ? r.html : esc(c[1](r))) + '</td>').join('') + '</tr>'
    ).join('') +
    '</tbody></table>';

  // clicking a surrogate row focuses its band; click again to release
  rEl('rSurrTable').querySelectorAll('tr[data-k]').forEach((tr) => {
    tr.onclick = () => {
      const k = Number(tr.dataset.k);
      if (!k) return;
      R.focus = R.focus === k ? null : k;
      renderSurrogates();
      drawReplayChart();
    };
  });

  if (!R.surrogates.length) {
    rEl('rSurrNote').textContent = 'generating ' + wanted + ' surrogate' + (wanted > 1 ? 's' : '') + '…';
    return;
  }

  const ds = R.surrogates.map((s) => s.metrics.deltaPct);
  const mu = ds.reduce((a, b) => a + b, 0) / ds.length;
  const sd = Math.sqrt(ds.reduce((a, x) => a + (x - mu) * (x - mu), 0) / ds.length);
  const own = (R.result && R.result.metrics && R.result.metrics.deltaPct) || 0;
  const inside = ds.length > 1 ? Math.abs(own - mu) <= 2 * Math.max(sd, 0.02) : true;

  rEl('rSurrNote').textContent =
    'Surrogates keep the volatility, autocorrelation and drift of the original but none of its shape — ' +
    'path ρ near 0 is the point. ' +
    'Delta on the original ' + (own >= 0 ? '+' : '') + own.toFixed(2) + '% · across ' + ds.length +
    ' surrogate' + (ds.length > 1 ? 's' : '') + ' ' + (mu >= 0 ? '+' : '') + mu.toFixed(2) + '% ± ' + sd.toFixed(2) + '%. ' +
    (inside
      ? 'The original sits inside that spread — most of what you are seeing is the agents, not the data.'
      : 'The original sits outside that spread — the result is not just the agents reacting to noise.');
}

/* ------------------------------------------------------- replay chart */

function drawReplayChart() {
  const cv = rEl('rchart');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = w * dpr;
  cv.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const dim = cssVar('--dim');
  const faint = cssVar('--faint');
  const hair = cssVar('--hair');
  const amber = cssVar('--amber');
  const buy = cssVar('--buy');
  const sell = cssVar('--sell');

  if (R.path.length < 2) {
    ctx.fillStyle = faint;
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(w < 460 ? 'press run' : 'press run — each agent sees one bar at a time, never the next', 14, 26);
    return;
  }

  const padL = 6;
  const padR = 58;
  const padT = 12;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // every series on the chart counts for the framing, and every surrogate's path
  // too — a surrogate that runs above the Jev path must not be clipped away
  const values = R.path.flatMap((p) => [p.close, p.jev]);
  for (const s of R.surrogates) for (const v of s.path || []) values.push(v);

  // Frame follows the data until the user touches the chart. Without this, the very
  // first surrogate would freeze the view and a later, wider one would be clipped.
  const auto = autoView(values, R.path.length);
  const z = R.zoomed && R.zoom ? R.zoom : auto;
  if (!R.zoomed) R.zoom = { ...auto };

  const x = (i) => padL + ((i - z.x0) / Math.max(1e-9, z.x1 - z.x0)) * plotW;
  const y = (v) => padT + (1 - (v - z.y0) / Math.max(1e-12, z.y1 - z.y0)) * plotH;

  // grid + axis labels
  ctx.strokeStyle = hair;
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = faint;
  for (let i = 0; i <= 4; i++) {
    const gv = z.y0 + ((z.y1 - z.y0) * i) / 4;
    const gy = Math.round(y(gv)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(padL + plotW, gy);
    ctx.stroke();
    ctx.fillText(gv.toFixed(2), padL + plotW + 7, gy + 3.5);
  }

  // everything data-shaped is clipped to the plot box, so zooming never paints
  // over the axis or the header
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, plotW, plotH);
  ctx.clip();

  // surrogate delta bands: the gap between that surrogate and the actual close,
  // in its own hue. Focused one is solid, the rest whisper.
  for (const s of R.surrogates) {
    const pts = s.path || [];
    const n2 = Math.min(pts.length, R.path.length);
    if (n2 < 2) continue;
    const focused = R.focus === s.k;
    const a = R.focus ? (focused ? 0.20 : 0.03) : 0.07;
    ctx.fillStyle = tint(hueOf(s.k), a);
    for (let i = 1; i < n2; i++) {
      ctx.beginPath();
      ctx.moveTo(x(i - 1), y(R.path[i - 1].close));
      ctx.lineTo(x(i), y(R.path[i].close));
      ctx.lineTo(x(i), y(pts[i]));
      ctx.lineTo(x(i - 1), y(pts[i - 1]));
      ctx.closePath();
      ctx.fill();
    }
  }

  // the Jev delta band
  for (let i = 1; i < R.path.length; i++) {
    const a = R.path[i - 1];
    const b = R.path[i];
    ctx.beginPath();
    ctx.moveTo(x(i - 1), y(a.close));
    ctx.lineTo(x(i), y(b.close));
    ctx.lineTo(x(i), y(b.jev));
    ctx.lineTo(x(i - 1), y(a.jev));
    ctx.closePath();
    ctx.fillStyle = tint(b.jev >= b.close ? buy : sell, 0.10);
    ctx.fill();
  }

  // surrogate lines, with a dot and number at the right end
  if (R.surrogates.length) {
    ctx.lineWidth = 1.1;
    ctx.font = '600 9px ui-monospace, monospace';
    for (const s of R.surrogates) {
      const pts = s.path || [];
      const n2 = Math.min(pts.length, R.path.length);
      if (n2 < 2) continue;
      const hue = hueOf(s.k);
      ctx.globalAlpha = R.focus && R.focus !== s.k ? 0.35 : 1;
      ctx.beginPath();
      for (let i = 0; i < n2; i++) {
        if (i) ctx.lineTo(x(i), y(pts[i]));
        else ctx.moveTo(x(i), y(pts[i]));
      }
      ctx.strokeStyle = tint(hue, 0.9);
      ctx.stroke();

      const ex = x(n2 - 1);
      const ey = y(pts[n2 - 1]);
      ctx.beginPath();
      ctx.arc(ex, ey, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = tint(hue, 1);
      ctx.fill();
      ctx.fillStyle = tint(hue, 1);
      ctx.fillText(String(s.k), Math.min(ex + 5, padL + plotW - 8), ey - 4);
      ctx.globalAlpha = 1;
    }
  }

  const line = (getter, color, width, dash) => {
    ctx.beginPath();
    R.path.forEach((p, i) => {
      if (i) ctx.lineTo(x(i), y(getter(p)));
      else ctx.moveTo(x(i), y(getter(p)));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
  };

  line((p) => p.close, dim, 1.3, [4, 3]);
  line((p) => p.jev, amber, 1.8);

  const last = R.path[R.path.length - 1];
  const lx = x(R.path.length - 1);
  ctx.beginPath();
  ctx.arc(lx, y(last.jev), 3, 0, Math.PI * 2);
  ctx.fillStyle = amber;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(lx, y(last.close), 3, 0, Math.PI * 2);
  ctx.fillStyle = dim;
  ctx.fill();

  ctx.restore();

  // the timeframe along the bottom, first / middle / last
  const intraday = Boolean(R.meta && R.meta.timeframe && R.meta.timeframe.intraday);
  const n = R.path.length;
  ctx.fillStyle = faint;
  ctx.font = '9.5px ui-monospace, monospace';
  [0, Math.floor((n - 1) / 2), n - 1].forEach((i) => {
    const label = tsLabel(R.path[i].t, intraday);
    if (!label) return;
    const tw = ctx.measureText(label).width;
    const anchor = i === 0 ? x(i) : i === n - 1 ? x(i) - tw : x(i) - tw / 2;
    ctx.fillText(label, Math.min(Math.max(anchor, padL), padL + plotW - tw), h - 5);
  });

  if (R.zoom && R.zoomed) {
    ctx.fillStyle = tint(amber, 0.85);
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.fillText('double-click to reset zoom', padL + 2, padT + 12);
  }
}

/** The default framing: all visible data, padded 12%. */
function autoView(values, n) {
  let lo = Math.min.apply(null, values);
  let hi = Math.max.apply(null, values);
  const span = Math.max(hi - lo, 1e-6);
  lo -= span * 0.12;
  hi += span * 0.12;
  return { x0: 0, x1: Math.max(1, n - 1), y0: lo, y1: hi };
}

/* ------------------------------------------------------- zoom and pan */

const chartBox = () => {
  const cv = rEl('rchart');
  const r = cv.getBoundingClientRect();
  return { cv, w: cv.clientWidth, h: cv.clientHeight, left: r.left, top: r.top };
};

function zoomAt(clientX, clientY, factor) {
  if (!R.path.length) return;
  const { w, h, left, top } = chartBox();
  const padL = 6, padR = 58, padT = 12, padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const px = Math.min(Math.max(clientX - left - padL, 0), plotW);
  const py = Math.min(Math.max(clientY - top - padT, 0), plotH);

  const values = R.path.flatMap((p) => [p.close, p.jev]);
  for (const s of R.surrogates) for (const v of s.path || []) values.push(v);
  const z = R.zoom || autoView(values, R.path.length);
  const ax = z.x0 + (px / plotW) * (z.x1 - z.x0);
  const ay = z.y1 - (py / plotH) * (z.y1 - z.y0);

  const nx0 = ax - (ax - z.x0) * factor;
  const nx1 = ax + (z.x1 - ax) * factor;
  const ny0 = ay - (ay - z.y0) * factor;
  const ny1 = ay + (z.y1 - ay) * factor;

  const minSpanX = 3;
  if (nx1 - nx0 < minSpanX || nx1 - nx0 > R.path.length * 2) return;

  R.zoom = { x0: nx0, x1: nx1, y0: ny0, y1: ny1 };
  R.zoomed = true;
  drawReplayChart();
}
/* ------------------------------------------------- zoom, pan, pinch */

(function wireChartGestures() {
  const cv = rEl('rchart');
  if (!cv) return;

  const PAD = { l: 6, r: 58, t: 12, b: 22 };
  const box = () => {
    const r = cv.getBoundingClientRect();
    return { w: cv.clientWidth, h: cv.clientHeight, plotW: cv.clientWidth - PAD.l - PAD.r, plotH: cv.clientHeight - PAD.t - PAD.b, left: r.left, top: r.top };
  };
  const dataView = () => {
    const values = R.path.flatMap((p) => [p.close, p.jev]);
    for (const s of R.surrogates) for (const v of s.path || []) values.push(v);
    return values.length ? autoView(values, R.path.length) : null;
  };

  cv.addEventListener('wheel', (e) => {
    if (!R.path.length) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 0.89);
  }, { passive: false });

  let drag = null;
  const touches = new Map();
  let pinchDist = 0;

  cv.addEventListener('pointerdown', (e) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) {
      drag = { x: e.clientX, y: e.clientY, view: { ...(R.zoom || dataView()) } };
      cv.setPointerCapture(e.pointerId);
    } else if (touches.size === 2) {
      drag = null;
      const [a, b] = [...touches.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });

  cv.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    const prev = touches.get(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) {
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinchDist / d);
      }
      pinchDist = d;
      return;
    }

    if (!drag) return;
    const { plotW, plotH } = box();
    const v = drag.view;
    const dx = ((e.clientX - drag.x) / plotW) * (v.x1 - v.x0);
    const dy = ((e.clientY - drag.y) / plotH) * (v.y1 - v.y0);
    R.zoom = { x0: v.x0 - dx, x1: v.x1 - dx, y0: v.y0 + dy, y1: v.y1 + dy };
    R.zoomed = true;
    drawReplayChart();
  });

  const release = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchDist = 0;
    if (touches.size === 0) drag = null;
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);

  cv.addEventListener('dblclick', () => {
    R.zoom = null;
    R.zoomed = false;
    drawReplayChart();
  });
})();

new ResizeObserver(() => { if (mode === 'replay') drawReplayChart(); }).observe(document.getElementById('rchart'));
setSource('synth');
drawReplayChart();
