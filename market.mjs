/**
 * CORPORATION 001 — a microstructure sandbox where every participant is a Jev.
 *
 * Mechanics kept deliberately small and honest:
 *   • a 5-level book rebuilt each round around a mid price
 *   • every agent answers ONE atomic question per round (one judgment, one call)
 *   • code — not Jev — turns probabilities into order size and price impact
 *   • the market maker is the counterparty to every fill, so it carries real inventory risk
 */
import { systemOne } from './jev.mjs';
import { ROSTER } from './personas.mjs';

export const ASSET = 'CORPORATION 001';
const TICK = 0.05;
const DEPTH0 = 900;          // shares resting at the best quote
const LEVELS_DEFAULT = 10;   // book rows, both sides together (5 per side)
const LEVELS_MAX = 100;
const SPREAD_BASE = 8;       // basis points at a 1.0x quote width
const IMPACT = 0.0000055;    // mid moves ~0.11% per 200 shares of net flow
const REVERT = 0.07;         // pull back toward fair value each round
const HOLD_BAND = 0.12;      // |p(buy) - p(sell)| under this is a hold

// Billing. TypeSafe charges per INPUT token; output tokens are free.
// Published rate is $42 per billion tokens = $0.042 per million tokens.
const PRICE_PER_MTOK = Number(process.env.JEV_PRICE_PER_MTOK || 0.042);
const COST_PER_TOKEN = PRICE_PER_MTOK / 1e6;
const billFor = (usage) => {
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  return { input, output, tokens: input + output, cost: Number((input * COST_PER_TOKEN).toFixed(10)) };
};

const r2 = (x) => Math.round(x * 100) / 100;
const pct = (a, b) => (b ? ((a - b) / b) * 100 : 0);


const MAX_SIZE = { mom: 140, val: 120, news: 110, mm2: 70 };

const AGENTS = ROSTER.map((r) => ({
  ...r,
  kind: r.id === 'mm' ? 'quote' : 'trade',
  ...(r.id === 'mm'
    ? { startPosition: 4000, startCash: -400000 }
    : { maxSize: MAX_SIZE[r.id] }),
}));

/* ------------------------------------------------------------------ setup */

export function freshMarket() {
  const agents = AGENTS.map((def) => ({
    id: def.id,
    name: def.name,
    role: def.role,
    kind: def.kind,
    blurb: def.blurb,
    maxSize: def.maxSize || 0,
    position: def.startPosition || 0,
    cash: def.startCash || 0,
    pnl: 0,
    fills: 0,
    last: null,
  }));

  const m = {
    round: 0,
    mid: 99.6,      // the tape opens below fair value on purpose: a market with
    fair: 100,      // no gap and no headline is a market where every Jev rightly holds
    quiet: 0,
    bid: 99.96,
    ask: 100.04,
    spreadBps: 8,
    book: { bids: [], asks: [] },
    levels: LEVELS_DEFAULT,
    tape: [],
    news: [],
    history: [],
    agents,
    stats: { buys: 0, sells: 0, holds: 0, volume: 0, calls: 0, fails: 0 },
    bill: {
      pricePerMTok: PRICE_PER_MTOK,
      round: { calls: 0, tokens: 0, cost: 0 },
      total: { rounds: 0, calls: 0, tokens: 0, cost: 0 },
      byAgent: Object.fromEntries(agents.map((a) => [a.id, { calls: 0, tokens: 0, cost: 0 }])),
    },
    lastRoundMs: 0,
  };
  rebuild(m, 1, 0);
  m.history.push({ round: 0, mid: m.mid, bid: m.bid, ask: m.ask, fair: m.fair });
  m.news.push({
    round: 0,
    mid: m.mid,
    text: 'CORPORATION 001 wins a larger state contract than expected',
  });
  return m;
}

function rebuild(m, mult = 1, skew = 0) {
  // Always quote off the FIXED base width. Deriving the next width from the current
  // bid/ask compounds the maker's multiplier into a runaway spread.
  const half = Math.max(0.01, ((m.mid * SPREAD_BASE) / 10000) * mult * 0.5);
  m.bid = r2(m.mid - half + skew);
  m.ask = r2(m.mid + half + skew);
  m.spreadBps = Number((((m.ask - m.bid) / m.mid) * 10000).toFixed(1));

  const bids = [], asks = [];
  const perSide = Math.max(1, Math.min(LEVELS_MAX / 2, Math.round((m.levels || LEVELS_DEFAULT) / 2)));
  for (let i = 0; i < perSide; i++) {
    // depth grows for the first ten levels and then flattens: a 100-row book
    // should thin away from the touch, not explode into tens of thousands
    const ramp = 1 + Math.min(i, 10) * 0.45 + Math.max(0, i - 10) * 0.06;
    const size = Math.round(DEPTH0 * ramp * (0.9 + Math.random() * 0.2));
    bids.push({ price: r2(m.bid - i * TICK), size });
    asks.push({ price: r2(m.ask + i * TICK), size });
  }
  m.book = { bids, asks };
}

/* -------------------------------------------------------------- questions */

const commonState = (m, a) => ({
  asset: ASSET,
  round: m.round,
  mid: m.mid,
  bid: m.bid,
  ask: m.ask,
  spread_bps: m.spreadBps,
  your_position_shares: a.position,
  your_pnl: Number(a.pnl.toFixed(2)),
});

const tapeState = (m, n = 6) =>
  m.tape.slice(-n).map((t) => ({ side: t.side, shares: t.size, price: t.price }));

const changeOver = (m, rounds) => {
  const then = m.history[Math.max(0, m.history.length - 1 - rounds)];
  return then ? Number(pct(m.mid, then.mid).toFixed(2)) : 0;
};

/** Each agent returns { state, question } — one atomic question, one judgment. */
function brief(agent, m, a) {
  const base = commonState(m, a);

  if (agent.id === 'mm') {
    const drift = changeOver(m, 5);
    const long = a.position - 4000;
    return {
      state: {
        ...base,
        inventory_vs_target_shares: long,
        price_change_last_5_rounds_pct: drift,
        recent_flow: tapeState(m),
      },
      question: {
        type: 'choice',
        instructions:
          'You are the only market maker in CORPORATION 001. You quote a bid and an ask every round ' +
          'and you are the counterparty to every trade. How should you quote in the next round?',
        criteria: {
          tighten:
            'Narrow the spread. Volume is healthy and inventory is close to target, so capture more flow.',
          hold: 'Keep the current spread. Nothing in the flow or your inventory justifies a change.',
          widen:
            'Widen the spread. Inventory is far from target or the tape is unstable, so charge more for the risk.',
        },
      },
    };
  }

  if (agent.id === 'mom') {
    return {
      state: {
        ...base,
        change_1_round_pct: changeOver(m, 1),
        change_3_rounds_pct: changeOver(m, 3),
        change_5_rounds_pct: changeOver(m, 5),
        recent_flow: tapeState(m),
      },
      question: {
        type: 'choice',
        instructions:
          'You trade CORPORATION 001 as a momentum trader: you buy strength and sell weakness, ' +
          'and you avoid trading when the tape is flat or contradictory. What is your order this round?',
        criteria: {
          buy: 'The recent move is up and it is still carrying. Add to the position now.',
          sell: 'The recent move is down and the selling is still carrying. Reduce or go short now.',
          hold: 'The move is flat, exhausted, or contradicts itself. Sit out this round.',
        },
      },
    };
  }

  if (agent.id === 'val') {
    const edge = Number((((m.fair - m.mid) / m.mid) * 100).toFixed(2));
    return {
      state: {
        ...base,
        your_fair_value_estimate: r2(m.fair),
        price_versus_your_estimate_pct: edge,
        recent_flow: tapeState(m),
      },
      question: {
        type: 'choice',
        instructions:
          'You trade CORPORATION 001 on value. You have your own estimate of what it is worth and ' +
          'you trade against the gap between the price and that estimate, ignoring the tape. ' +
          'What is your order this round?',
        criteria: {
          buy: 'The price sits clearly below your estimate. Buy the discount.',
          sell: 'The price sits clearly above your estimate. Sell the premium.',
          hold: 'The price is close enough to your estimate that there is no edge worth trading.',
        },
      },
    };
  }

  if (agent.id === 'news') {
    const latest = m.news[m.news.length - 1];
    return {
      state: {
        ...base,
        latest_headline: latest ? latest.text : 'no new headline this round',
        rounds_since_headline: latest ? m.round - latest.round : null,
        change_since_headline_pct: latest ? Number(pct(m.mid, latest.mid).toFixed(2)) : 0,
        recent_flow: tapeState(m),
      },
      question: {
        type: 'choice',
        instructions:
          'You trade CORPORATION 001 on news. You read the latest headline and decide whether the ' +
          'market has already priced it. What is your order this round?',
        criteria: {
          buy: 'The headline is good news the price has not fully absorbed yet. Buy now.',
          sell: 'The headline is bad news the price has not fully absorbed yet. Sell now.',
          hold: 'There is no fresh headline, or the price has already absorbed it. Do nothing.',
        },
      },
    };
  }

  // Nyx — scalper
  return {
    state: {
      ...base,
      your_fills_so_far: a.fills,
      recent_flow: tapeState(m),
    },
    question: {
      type: 'choice',
      instructions:
        'You scalp CORPORATION 001: you take liquidity when the spread is wide enough to pay you ' +
        'and you stay flat when it is not. What is your order this round?',
      criteria: {
        buy: 'The spread is wide and the last trades are being lifted. Buy and work the position out.',
        sell: 'The spread is wide and the last trades are hitting the bid. Sell into it.',
        hold: 'The spread is too tight to pay for the risk. Stay flat this round.',
      },
    },
  };
}

/** Change how many rows the book shows. Rebuilds immediately, so the ladder never lags. */
export function setDepth(m, value) {
  const next = Math.max(2, Math.min(LEVELS_MAX, Math.round(Number(value) || LEVELS_DEFAULT)));
  m.levels = next % 2 ? next + 1 : next;
  const mm = m.agents.find((a) => a.id === 'mm');
  rebuild(m, mm?._quote?.mult ?? 1, mm?._quote?.skew ?? 0);
  return m.levels;
}

/* ------------------------------------------------------------------ round */

export async function runRound(m) {
  const started = Date.now();
  m.round++;

  // --- news: occasionally, and forced when the book has gone quiet for two rounds,
  //     because a market with no catalyst is a market where every Jev correctly holds
  const stalled = m.quiet >= 2;
  if (stalled || Math.random() < 0.16) {
    const shock = (Math.random() - 0.5) * 0.012;
    m.fair = r2(m.fair * (1 + shock));
    m.news.push({
      round: m.round,
      mid: m.mid,
      text:
        shock > 0
          ? pick(['CORPORATION 001 wins a larger state contract than expected',
                 'CORPORATION 001 raises guidance for the second half',
                 'a rival stumbles, and CORPORATION 001 picks up the shelf space',
                 'CORPORATION 001 announces a buyback of 4% of shares outstanding',
                 'a broker upgrades CORPORATION 001 two notches in one note',
                 'CORPORATION 001 lands a national retailer as a stockist'])
          : pick(['CORPORATION 001 loses its biggest distribution partner',
                 'CORPORATION 001 flags a margin squeeze for the next quarter',
                 'a regulator opens a file on CORPORATION 001',
                 'CORPORATION 001 recalls a product line over a supplier defect',
                 'the finance director of CORPORATION 001 resigns without notice',
                 'a short seller publishes a note questioning CORPORATION 001 revenue']),
    });
    if (m.news.length > 12) m.news.shift();
  }

  // --- every agent answers one question, in parallel
  const replies = await Promise.all(
    m.agents.map(async (a) => {
      const { state, question } = brief(a, m, a);
      m.stats.calls++;
      try {
        const res = await systemOne({ state, questions: { d: question } });
        const ans = res.answers?.d;
        if (!ans?.probabilities) throw new Error('no probabilities');
        return {
          id: a.id,
          probs: ans.probabilities,
          confidence: ans.confidence ?? null,
          bill: billFor(res.usage),
          error: null,
        };
      } catch (err) {
        m.stats.fails++;
        return { id: a.id, probs: null, confidence: null, bill: billFor(null), error: err.message };
      }
    }),
  );

  // --- code turns judgments into orders
  let netFlow = 0;
  let volume = 0;
  const fills = [];

  for (const a of m.agents) {
    const r = replies.find((x) => x.id === a.id);
    const p = r?.probs || {};

    if (a.kind === 'quote') {
      const mult =
        (p.tighten || 0) * 0.68 + (p.hold || 0) * 1.0 + (p.widen || 0) * 1.75;
      const safeMult = Math.min(2.2, Math.max(0.6, mult || 1));
      const drift = (a.position - 4000) / 4000;             // long inventory -> quote lower
      const skew = -drift * 0.035;

      a.last = {
        action: safeMult < 0.9 ? 'tighten' : safeMult > 1.15 ? 'widen' : 'hold',
        probs: { tighten: p.tighten || 0, hold: p.hold || 0, widen: p.widen || 0 },
        confidence: r?.confidence ?? null,
        width_mult: Number(safeMult.toFixed(2)),
        edge: Number(((safeMult - 1) * 100).toFixed(1)),
        size: 0,
        error: r?.error || null,
      };
      a._quote = { mult: safeMult, skew };
      continue;
    }

    const pBuy = p.buy || 0;
    const pSell = p.sell || 0;
    const intent = pBuy - pSell;
    const action = intent > HOLD_BAND ? 'buy' : intent < -HOLD_BAND ? 'sell' : 'hold';

    let size = 0;
    if (action !== 'hold') {
      size = Math.round(Math.min(1, Math.abs(intent) * 1.25) * a.maxSize);
      size = Math.max(10, Math.round(size / 10) * 10);
    }

    a.last = {
      action,
      probs: { buy: pBuy, sell: pSell, hold: p.hold || 0 },
      confidence: r?.confidence ?? null,
      intent: Number(intent.toFixed(3)),
      size,
      error: r?.error || null,
    };

    if (!size) continue;

    const slip = 1 + IMPACT * size * 0.55;
    const px = r2(action === 'buy' ? m.ask * slip : m.bid / slip);

    a.position += action === 'buy' ? size : -size;
    a.cash += action === 'buy' ? -size * px : size * px;
    a.fills++;

    const mm = m.agents.find((x) => x.id === 'mm');
    mm.position += action === 'buy' ? -size : size;
    mm.cash += action === 'buy' ? size * px : -size * px;

    netFlow += action === 'buy' ? size : -size;
    volume += size;
    m.stats[action === 'buy' ? 'buys' : 'sells']++;
    m.tape.push({
      round: m.round,
      time: new Date().toISOString().slice(11, 19),
      agent: a.name,
      side: action,
      size,
      price: px,
    });
    fills.push({ agent: a.name, side: action, size, price: px });
  }

  const holds = m.agents.filter((a) => a.kind === 'trade' && a.last?.action === 'hold').length;
  m.stats.holds += holds;

  // --- impact, mean reversion, new book
  m.mid = r2(m.mid * (1 + netFlow * IMPACT));
  m.mid = r2(m.mid + (m.fair - m.mid) * REVERT);

  const mm = m.agents.find((a) => a.id === 'mm');
  rebuild(m, mm?._quote?.mult ?? 1, mm?._quote?.skew ?? 0);

  for (const a of m.agents) a.pnl = Number((a.cash + a.position * m.mid).toFixed(2));
  m.stats.volume += volume;

  // --- the bill: what this round actually cost, per agent and in total
  let roundCost = 0, roundTokens = 0, roundCalls = 0;
  for (const a of m.agents) {
    const r = replies.find((x) => x.id === a.id);
    const bill = r?.bill || billFor(null);
    if (a.last) a.last.bill = bill;
    if (r?.error === null) roundCalls++;
    roundTokens += bill.tokens;
    roundCost += bill.cost;
    const acc = m.bill.byAgent[a.id];
    acc.calls += r?.error === null ? 1 : 0;
    acc.tokens += bill.tokens;
    acc.cost = Number((acc.cost + bill.cost).toFixed(10));
  }
  roundCost = Number(roundCost.toFixed(10));
  m.bill.round = { calls: roundCalls, tokens: roundTokens, cost: roundCost };
  m.bill.total.rounds += 1;
  m.bill.total.calls += roundCalls;
  m.bill.total.tokens += roundTokens;
  m.bill.total.cost = Number((m.bill.total.cost + roundCost).toFixed(10));

  // the whole session is kept, so the chart can look back over the entire run;
  // only a 180-round window of it ships on every snapshot (see server.mjs).
  m.history.push({ round: m.round, mid: m.mid, bid: m.bid, ask: m.ask, fair: m.fair });
  if (m.history.length > 8000) m.history.shift();
  if (m.tape.length > 200) m.tape.shift();

  m.quiet = volume === 0 ? m.quiet + 1 : 0;
  m.lastRoundMs = Date.now() - started;
  return { fills, netFlow, volume };
}

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
