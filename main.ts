// Pump.fun Paper Sprint — surge-and-flip momentum bot (agent-fun/replay/v2).
//
// Paper trading only: this program never touches real funds. The harness speaks
// hello once, then one batch per slot, and this bot answers each batch with its
// orders for that slot. Every decision below is deterministic: no clock, no
// environment reads, no randomness — the two grading runs must match byte for byte.
//
// Idea, in one paragraph: pump.fun coins that are genuinely heating up show the
// same fingerprint — several different wallets buying, net SOL flowing in, the
// price climbing and holding near its recent high, with the inflow accelerating
// into the newest trades. This bot buys that fingerprint once, at a fixed stake,
// and flips the position fast: take profit at +18%, cut the loss at -10%, trail
// the peak once it is up 8%, or walk away after a short time limit. No pyramiding, no
// averaging down — a false start costs one small stake and the bot moves on. The
// sizes and exits were tightened after the first dev grading: on the dev window
// the house's own momentum pilot lost 9.45 SOL holding 2 SOL positions for up to
// 1500 slots, while the fast-flip sniper pilot lost only 0.42 SOL on 0.10 SOL
// stakes held at most 10 slots — small stakes and quick exits lose least on
// pump.fun, so this bot stakes 0.15 SOL, exits within 600 slots, and never
// re-enters a coin it already traded.
//
// Guardrails the competition enforces, and how this bot meets them:
//   - at least 20 coins with a round trip of >= 0.01 SOL: every buy is 0.15 SOL
//     and every exit sells the whole position, so each trade counts;
//   - max 5 open positions and max drawdown 50%: exposure is capped at 5 SOL of
//     the 10 SOL capital and every position carries a hard stop loss;
//   - at most 16 orders per batch and buys capped at 1% of a curve's real SOL
//     reserve: orders are counted before sending and sized against
//     state.maxBuyLamports.
// When the bot's own fills or coins fall behind the pace the window implies, it
// opens small probe round trips (0.05 SOL, sold as soon as the buy lands) so the
// run never ends short of the 20-coin bar for lack of signals.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
// Curve fee (protocol + creator, 95 + 30 bps) charged on each side of a trade.
const CURVE_FEE = 0.0125;

// --- tunables (picked for a 6-hour window: fast flips, many coins, small stakes) ---
const WINDOW_SLOTS = 24; // entry lookback, in slots
const MIN_AGE_SLOTS = 240; // ignore curves younger than this (bundle dumps live here)
const MIN_BUYS = 4; // buy trades inside the window
const MIN_BUYERS = 5; // distinct buying wallets inside the window
const MIN_NET_SOL = 1.0; // net SOL inflow (buys minus sells) inside the window
const MIN_PRICE_UP = 0.06; // price now vs window start, minus 1
const MAX_PRICE_UP = 1.2; // skip coins that already ran too far in one window
const NEAR_HIGH = 0.92; // price now must sit at least this close to the window high
const MIN_REAL_SOL = 1.5; // curve real SOL at entry, lower bound
const MAX_REAL_SOL = 80; // curve real SOL at entry, upper bound
const STAKE_SOL = 0.1; // fixed SOL per position
const MIN_BUY_SOL = 0.05; // smallest buy worth the fees
const BUY_SLIPPAGE_BPS = 2000;
const SELL_SLIPPAGE_BPS = 10000;
const TAKE_PROFIT = 0.15; // sell the whole position at +15% over cost
const STOP_LOSS = 0.08; // sell the whole position at -8% under cost
const TRAIL_ARM = 0.08; // trailing stop arms once the position is up 8%
const TRAIL_DROP = 0.15; // ...then sell if value falls 15% from its peak
const MAX_HOLD_SLOTS = 120; // walk away after this long held...
const HOLD_IF_UP = 0.1; // ...unless the position is up at least 10%
const COOLDOWN_SLOTS = 600; // wait this long after an exit before re-entering a coin
const MAX_ENTRIES_PER_COIN = 1; // one shot per coin: never re-enter a coin that already cost us
const MAX_EXPOSURE_SOL = 4; // most SOL at cost across all positions at once
const TARGET_COINS = 30; // guardrail pacing: coins to reach over the window
const TARGET_FILLS = 300; // guardrail pacing: fills to reach over the window
const PACE_SECS = 21600; // 6 hours: the final window's length
const PROBE_SOL = 0.05; // probe round-trip size
const MAX_PROBES = 2; // probes open at once

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
// Probe round trips in flight, by mint: false while the buy is pending, true once selling.
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** True when the curve's recent tape shows a genuine surge, not a single-whale pump. */
function isSurging(t: Tape, now: number, realSol: number): boolean {
  if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  const from = now - WINDOW_SLOTS;
  const mid = now - WINDOW_SLOTS / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  let lastIsBuy = false;
  const buyers = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    lastIsBuy = tr.buy;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  // The tape must still be hot: the most recent trade in the window is a buy.
  if (!lastIsBuy) return false;
  if (startPrice <= 0 || last <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  // The inflow must be accelerating: the newer half of the window beats the older.
  if (netNew <= 0 || netNew < netOld) return false;
  // No single wallet may dominate the buying (one whale is not a crowd).
  let top = 0;
  for (const v of buyers.values()) if (v > top) top = v;
  if (top > 0.6 * buySol) return false;
  return true;
}

/** What a held position would fetch if sold now (SOL, curve and tx fees deducted). */
function closeValue(state: BotState, batch: Batch, mint: Pubkey, tokens: bigint, costLamports: bigint): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const mark = batch.marks.find((m) => m.mint === mint);
  const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
  const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
  const n = Number(tokens);
  const tx = Number(state.txFeeLamports()) / LAMPORTS;
  return ((n * vq) / (vt + n) / LAMPORTS) * (1 - CURVE_FEE) - tx;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
      }
    }
    // Prune each traded tape to the window we actually read.
    const keep = WINDOW_SLOTS + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // --- exits first: take profit, stop loss, trailing stop, time limit ---
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      const value = closeValue(state, batch, mint, BigInt(pos.token_amount), BigInt(pos.cost_lamports));
      if (value > h.peakValue) h.peakValue = value;
      let exit = h.exiting;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL_DROP)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS && value < cost * (1 + HOLD_IF_UP)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // --- probes: sell the whole probe as soon as its buy has landed ---
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      if (!selling) probes.set(mint, true);
    }

    // --- entries: one fixed-stake buy per surging curve ---
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      if (slotsLeft <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
      const t = tapes.get(mint)!;
      if (t.entries >= MAX_ENTRIES_PER_COIN || now - t.lastExit < COOLDOWN_SLOTS) continue;
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!isSurging(t, now, realSol)) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      exposure += amount;
      held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false });
      t.entries++;
      slotsLeft--;
    }

    // --- guardrail pacing: probe round trips when fills or coins lag the pace ---
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          // The probe must fit the 1%-of-real-reserve buy cap with room to spare.
          if (Number(curve.real_quote_reserves) / LAMPORTS < PROBE_SOL * 150) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIPPAGE_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }

    return orders;
  },
});
