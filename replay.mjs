/**
 * Event-driven replay.
 *
 * The engine walks a bar series forward one step at a time. At step i the agents
 * see bars[0..i-1] and nothing else — the decision is recorded, then bar i's return
 * is applied. There is no way to see the future from inside a brief, and the loop
 * cannot be reordered without breaking that.
 *
 * The agents trade a notional position in [-1, +1] of capital, so the same engine
 * works on a R5 share and a 40 000 index. Their NAV, rebased to the first close,
 * is the "Jev path" the UI compares against the actual close path.
 */
import { systemOne } from './jev.mjs';
import { byId } from './personas.mjs';

const PRICE_PER_MTOK = Number(process.env.JEV_PRICE_PER_MTOK || 0.042);
const COST_PER_TOKEN = PRICE_PER_MTOK / 1e6;

export const DEFAULTS = {
  maxBars: 60,
  surrogates: 3,
  method: 'aaft',      // aaft | iaaft | ft | block | shuffle
  block: 8,
  seed: 7,
  costBps: 6,          // round-trip cost per unit of position change
  window: 8,           // returns the agents are shown
  maxLeverage: { mm: 0.0, mom: 0.80, val: 0.70, news: 0.60, mm2: 0.40 },
};

const pct = (x) => Number((x * 100).toFixed(2));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

const returnsOf = (bars) => bars.slice(1).map((b, i) => b.c / bars[i].c - 1);

/* --------------------------------------------------------------- context */

/** Everything an agent may know at step i: bars[0..i-1]. Nothing later. */
function context(bars, i, window) {
  const past = bars.slice(0, i);              // strictly the past
  const closes = past.map((b) => b.c);
  const rets = returnsOf(past).slice(-window);
  const last = closes[closes.length - 1];
  const at = (k) => (closes.length > k ? closes[closes.length - 1 - k] : closes[0]);

  const vol = stdev(returnsOf(past).slice(-window * 2));
  const vols = past.slice(-window).map((b) => b.v);
  const vMean = mean(bars.slice(0, i).map((b) => b.v));
  const vNow = past[past.length - 1]?.v ?? 0;
  const vZ = vMean > 0 ? (vNow - mean(vols)) / (stdev(vols) || 1) : 0;

  return {
    last,
    rets,
    change1: pct(last / at(1) - 1),
    change5: pct(last / at(5) - 1),
    change10: pct(last / at(10) - 1),
    vol: pct(vol),
    fair: mean(closes.slice(-20)),           // a trailing mean, not the whole series
    vZ: Number(vZ.toFixed(2)),
    bar: past.length,
  };
}

/* ---------------------------------------------------------------- briefs */

const trailing = (ctx) =>
  ctx.rets.map((r) => Number((r * 100).toFixed(2)));

const common = (ctx) => ({
  last_close: Number(ctx.last.toFixed(4)),
  last_returns_pct: trailing(ctx),
  change_1_bar_pct: ctx.change1,
  change_5_bar_pct: ctx.change5,
  change_10_bar_pct: ctx.change10,
  realised_vol_pct: ctx.vol,
});

function briefFor(id, ctx, st) {
  const base = { ...common(ctx), your_position: Number(st.pos.toFixed(2)), your_pnl_pct: pct(st.pnl) };

  if (id === 'mm') {
    return {
      state: { ...base, inventory_vs_target: Number(st.pos.toFixed(2)), relative_volume_z: ctx.vZ },
      question: {
        type: 'choice',
        instructions:
          'You are the only market maker in this instrument and you quote every bar. ' +
          'How should you quote on the next bar?',
        criteria: {
          tighten: 'Volume is calm and your inventory is near flat. Quote tight and collect the spread.',
          hold: 'Nothing in the flow or your inventory justifies a change. Keep the current width.',
          widen: 'Inventory is stretched or volatility just rose. Charge more for the risk.',
        },
      },
    };
  }

  if (id === 'mom') {
    return {
      state: base,
      question: {
        type: 'choice',
        instructions:
          'You trade momentum on this instrument, bar by bar, seeing only the bars already printed. ' +
          'What is your position for the next bar?',
        criteria: {
          buy: 'The recent bars are trending up and the move is still carrying. Be long.',
          sell: 'The recent bars are trending down and the selling is still carrying. Be short.',
          hold: 'The tape is flat or contradictory. Take no position.',
        },
      },
    };
  }

  if (id === 'val') {
    return {
      state: {
        ...base,
        your_fair_value: Number(ctx.fair.toFixed(4)),
        price_vs_your_fair_value_pct: pct(ctx.last / ctx.fair - 1),
      },
      question: {
        type: 'choice',
        instructions:
          'You trade value on this instrument. Your fair value is a trailing average of recent closes, ' +
          'and you trade the gap between price and that estimate, ignoring the tape. ' +
          'What is your position for the next bar?',
        criteria: {
          buy: 'Price sits clearly below your estimate. Be long the discount.',
          sell: 'Price sits clearly above your estimate. Be short the premium.',
          hold: 'Price is close to your estimate. There is no edge worth paying the spread for.',
        },
      },
    };
  }

  if (id === 'news') {
    return {
      state: { ...base, relative_volume_z: ctx.vZ, largest_recent_move_pct: Math.max(...ctx.rets.map((r) => Math.abs(pct(r))), 0) },
      question: {
        type: 'choice',
        instructions:
          'You trade events on this instrument. A volume spike or an outsized bar is your signal that ' +
          'something happened, and you judge whether the price has absorbed it. ' +
          'What is your position for the next bar?',
        criteria: {
          buy: 'There was an outsized up-bar or a volume spike, and it is not fully absorbed. Be long.',
          sell: 'There was an outsized down-bar or a volume spike against the price, and it is not absorbed. Be short.',
          hold: 'No event stands out this bar, or the move is already absorbed. Do nothing.',
        },
      },
    };
  }

  return {
    state: { ...base, realised_vol_pct: ctx.vol },
    question: {
      type: 'choice',
      instructions:
        'You scalp this instrument. You take a small position when volatility is high enough to pay ' +
        'for the spread, and you stay flat when it is not. What is your position for the next bar?',
      criteria: {
        buy: 'Volatility is rich and the last bar closed strong. Take a small long.',
        sell: 'Volatility is rich and the last bar closed weak. Take a small short.',
        hold: 'Volatility is too thin to pay the spread. Stay flat.',
      },
    },
  };
}

/* ----------------------------------------------------------------- engine */

export async function replaySeries(bars, opts = {}, hooks = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { onBar, onProgress, shouldCancel } = hooks;
  const maxBars = Math.min(cfg.maxBars, bars.length - 1);

  const agents = ['mm', 'mom', 'val', 'news', 'mm2'].map((id) => {
    const p = byId(id);
    return {
      id, name: p.name, role: p.role,
      pos: 0, target: 0, pnl: 0, fills: 0, last: null,
      bill: { calls: 0, tokens: 0, cost: 0 },
    };
  });
  const traders = agents.filter((a) => a.id !== 'mm');

  let nav = bars[0].c;
  let spreadMult = 1;
  let cancelled = false;
  const path = [{ i: 0, t: bars[0].t, close: bars[0].c, jev: nav }];

  for (let i = 1; i <= maxBars; i++) {
    if (shouldCancel?.()) { cancelled = true; break; }

    // 1. the positions set on the previous bar earn this bar's return.
    //    Cost was already charged when they were set — nothing here looks forward.
    const ret = bars[i].c / bars[i - 1].c - 1;
    const avgPos = mean(traders.map((a) => a.pos));
    nav = nav * (1 + avgPos * ret);

    const bar = { i, t: bars[i].t, close: bars[i].c, jev: nav, delta: nav - bars[i].c };

    // 2. the agents now see bars[0..i] — everything printed so far, nothing after
    const ctx = context(bars, i, cfg.window);

    const replies = await Promise.all(
      agents.map(async (a) => {
        const { state, question } = briefFor(a.id, ctx, a);
        try {
          const res = await systemOne({ state, questions: { d: question } });
          const ans = res.answers?.d;
          if (!ans?.probabilities) throw new Error('no probabilities');
          const u = res.usage || {};
          a.bill.calls++;
          a.bill.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
          a.bill.cost += (u.input_tokens || 0) * COST_PER_TOKEN;
          return { id: a.id, probs: ans.probabilities, confidence: ans.confidence ?? null, error: null };
        } catch (err) {
          return { id: a.id, probs: null, confidence: null, error: err.message };
        }
      }),
    );

    // 3. probabilities become target positions; the cost of the change is paid now
    const decisions = [];
    let paid = 0;

    for (const a of agents) {
      const r = replies.find((x) => x.id === a.id);
      const p = r?.probs || {};

      if (a.id === 'mm') {
        const mult = (p.tighten || 0) * 0.7 + (p.hold || 0) * 1 + (p.widen || 0) * 1.9;
        spreadMult = Math.min(2.4, Math.max(0.6, mult || 1));
        a.last = {
          action: spreadMult < 0.9 ? 'tighten' : spreadMult > 1.2 ? 'widen' : 'hold',
          probs: p, confidence: r?.confidence ?? null, error: r?.error || null,
        };
        decisions.push({ id: a.id, name: a.name, action: a.last.action, p: Number(spreadMult.toFixed(2)), size: 0 });
        continue;
      }

      const pBuy = p.buy || 0;
      const pSell = p.sell || 0;
      const intent = pBuy - pSell;
      const action = intent > 0.12 ? 'buy' : intent < -0.12 ? 'sell' : 'hold';
      const lev = cfg.maxLeverage[a.id] ?? 0.5;
      const target = action === 'hold' ? 0 : Math.sign(intent) * Math.min(1, Math.abs(intent) * 1.25) * lev;

      const dPos = target - a.pos;
      paid += Math.abs(dPos) * (cfg.costBps * spreadMult) / 10000;
      if (Math.abs(dPos) > 1e-9) a.fills++;
      a.pos = target;

      a.last = {
        action, probs: { buy: pBuy, sell: pSell, hold: p.hold || 0 },
        confidence: r?.confidence ?? null, intent: Number(intent.toFixed(3)), error: r?.error || null,
      };
      decisions.push({ id: a.id, name: a.name, action, p: Number(intent.toFixed(3)), size: Number(target.toFixed(3)) });
    }

    nav = nav * (1 - paid / traders.length);
    bar.jev = nav;
    bar.delta = nav - bar.close;
    bar.spread = Number(spreadMult.toFixed(2));
    path.push(bar);
    onBar?.(bar, decisions);
    onProgress?.({ i, maxBars });
  }

  const clipped = bars.slice(0, Math.max(1, path[path.length - 1].i + 1));
  const metrics = compare(clipped, path);

  return {
    cancelled,
    bars: path.length - 1,
    path,
    agents: agents.map((a) => ({
      id: a.id, name: a.name, role: a.role,
      position: Number(a.pos.toFixed(2)),
      pnlPct: pct(a.pnl),
      fills: a.fills,
      last: a.last,
      bill: { calls: a.bill.calls, tokens: a.bill.tokens, cost: Number(a.bill.cost.toFixed(10)) },
    })),
    metrics,
    bill: {
      calls: agents.reduce((s, a) => s + a.bill.calls, 0),
      tokens: agents.reduce((s, a) => s + a.bill.tokens, 0),
      cost: Number(agents.reduce((s, a) => s + a.bill.cost, 0).toFixed(10)),
      pricePerMTok: PRICE_PER_MTOK,
    },
  };
}

/* ---------------------------------------------------------------- metrics */

export function compare(bars, path) {
  const n = Math.min(bars.length, path.length) - 1;
  const assetRets = [];
  const jevRets = [];
  for (let i = 1; i <= n; i++) {
    assetRets.push(bars[i].c / bars[i - 1].c - 1);
    jevRets.push(path[i].jev / path[i - 1].jev - 1);
  }

  const excess = assetRets.map((r, i) => jevRets[i] - r);
  const mAsset = mean(assetRets);
  const mJev = mean(jevRets);
  const sdA = stdev(assetRets) || 1;
  const sdJ = stdev(jevRets) || 1;

  let cov = 0;
  for (let i = 0; i < assetRets.length; i++) cov += (assetRets[i] - mAsset) * (jevRets[i] - mJev);
  const corr = assetRets.length > 1 ? cov / ((assetRets.length - 1) * sdA * sdJ) : 0;

  // did the agents' capital move the same way as the asset, bar by bar?
  let agree = 0, judged = 0;
  for (let i = 0; i < assetRets.length; i++) {
    if (Math.abs(assetRets[i]) < 1e-9) continue;
    judged++;
    if (Math.sign(jevRets[i]) === Math.sign(assetRets[i])) agree++;
  }

  const last = path[path.length - 1];
  const delta = last.jev - last.close;

  return {
    bars: n,
    actualFinal: last.close,
    jevFinal: last.jev,
    delta,
    deltaPct: (delta / last.close) * 100,
    totalReturnPct: (last.close / bars[0].c - 1) * 100,
    jevReturnPct: (last.jev / bars[0].c - 1) * 100,
    trackingErrorPct: stdev(excess) * 100,
    corr,
    directionAgreementPct: judged ? (agree / judged) * 100 : 0,
    jevVolPct: sdJ * 100,
    assetVolPct: sdA * 100,
    maPct: mean(excess.map(Math.abs)) * 100,
  };
}
