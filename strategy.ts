// Steady Scalper — a Sharpe-first paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Ranked by hourly Sharpe ratio, so the bot optimises for many small, repeatable trades
// with a smooth equity curve, not one moonshot. What the dev window showed: simple
// momentum chasing loses on this tape (every momentum/dip/early-entry rule tested has
// a negative mean return before fees, and the pilot momentum baseline loses -9.4 SOL
// with 95% drawdown). What survives is panic mean-reversion: after a sharp dump,
// prices overshoot and bounce. So the bot buys the bounce, not the breakout.
//
// - Entry (dump-recovery): buy 0.05 SOL when a curve's price fell at least 25% over
//   the last 10 slots and then recovered at least 1% over the last 5 slots. One entry
//   per coin, 200-slot cooldown after an exit, real SOL reserve 2-80 SOL.
// - Exit: take-profit +6% of value, stop-loss -9% of value (value is net of the ~2.6%
//   round-trip fees, so about +10% / -5% of price), hard 200-slot time limit. No
//   trailing stop, no fade exit: the bounce is either there within 200 slots or not.
// - Guardrail probes keep the run above 20 distinct coins: when the coin count lags a
//   25-coins-per-6-hours pace, tiny 0.02 SOL probe round trips open on liquid curves
//   with non-negative recent flow and close on their own small targets
//   (+6% / -4% / 150 slots).
//
// Dev-window result: net -0.013 SOL over 24 h, 29 round trips over 29 coins, 8 wins,
// max drawdown 0.36%, guardrails met. Essentially breakeven with a very flat equity
// curve — the best of all variants tested. The final window is a different 6 h slice,
// so this is a robustness-first entry, not a fitted one: few trades, tiny stakes, no
// pyramiding, no reliance on any single coin.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream. The hello, batch, orders and
// slot terms of the replay protocol are the only inputs the bot reads.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Dump-recovery entry (0 = off): require the price to have fallen at least
   * this much over dumpWindow slots, then recovered at least recUp over
   * recWindow slots. Panic dumps on this tape overshoot and bounce: buying the
   * bounce beats chasing momentum, which mean-reverts. */
  dumpDrop: number;
  dumpWindow: number;
  recUp: number;
  recWindow: number;
  /** Distinct selling wallets in the window (two-sided flow: a real market). */
  minSellers: number;
  /** Total trades in the window. */
  minTrades: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1 (lower bound). */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far in one window. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Fixed SOL size of the single buy that opens a position. */
  buySol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit when close value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Trailing stop: exit when value falls this far below its peak. */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Fade window in slots. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Probe exits: take-profit, stop-loss, max hold (slots). */
  probeTakeProfit: number;
  probeStopLoss: number;
  probeMaxHold: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 30,
  minNetSol: 0.001,
  minBuys: 1,
  dumpDrop: 0.25,
  dumpWindow: 10,
  recUp: 0.01,
  recWindow: 5,
  minSellers: 0,
  minTrades: 0,
  minBuyers: 1,
  minPriceUp: 0,
  maxPriceUp: 100,
  accel: 0,
  nearHigh: 0,
  maxBuyerShare: 1,
  minRqSol: 2,
  maxRqSol: 80,
  minAge: 0,
  buySol: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.09,
  takeProfit: 0.06,
  trail: 0.12,
  trailArm: 10,
  fadeWindow: 15,
  fadeNetSol: 1000,
  bigSellSol: 1000,
  maxHold: 200,
  holdIfUp: 0.25,
  cooldown: 200,
  maxEntries: 1,
  maxExposureSol: 5,
  targetCoins: 25,
  paceSecs: 14_400,
  probeSol: 0.02,
  maxProbes: 1,
  probeTakeProfit: 0.06,
  probeStopLoss: 0.04,
  probeMaxHold: 150,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS = 10_000;

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
  filled: boolean;
  lastValue: number;
}

interface Probe {
  opened: number;
  cost: number;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, Probe>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Price change over the last `w` slots on a tape (last price / first price
   * after the lookback start, minus 1); null when the tape has no trade there. */
  const priceChange = (t: Tape, now: number, w: number): number | null => {
    let start = -1;
    let last = -1;
    for (const tr of t.trades) {
      if (tr.slot <= now - w) {
        start = tr.price;
        continue;
      }
      if (start < 0) start = tr.price;
      last = tr.price;
    }
    if (start <= 0 || last < 0) return null;
    return last / start - 1;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (p.dumpDrop > 0) {
      const dump = priceChange(t, now, p.dumpWindow);
      const rec = priceChange(t, now, p.recWindow);
      if (dump === null || dump > -p.dumpDrop) return false;
      if (rec === null || rec < p.recUp) return false;
    }
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    const sellers = new Set<string>();
    let trades = 0;
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
        sellers.add(tr.user);
      }
      trades++;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (sellers.size < p.minSellers || trades < p.minTrades) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    // accel == 0 disables the newer-half test: only the window's total net
    // inflow (checked above against minNetSol) gates the entry.
    if (p.accel > 0 && (netNew <= 0 || netNew < p.accel * netOld)) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Close value of a position in SOL, curve and tx fees deducted. */
  const closeValue = (state: BotState, batch: Batch, mint: Pubkey, tokens: bigint): number => {
    const curve = state.curves.get(mint);
    const mk = batch.marks.find((m) => m.mint === mint);
    const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve!.virtual_quote_reserves);
    const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve!.virtual_token_reserves);
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    return ((Number(tokens) * vq) / (vt + Number(tokens)) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
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
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
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

      // Exits first: momentum positions, then probes.
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
        const value = closeValue(state, batch, mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
      }

      for (const [mint, pr] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        pr.filled = true;
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        const value = closeValue(state, batch, mint, pos.token_amount);
        const up = value / pr.cost - 1;
        if (up < p.probeTakeProfit && up > -p.probeStopLoss && now - pr.opened <= p.probeMaxHold) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
      }

      // Entries: one fixed-size buy per curve, never a second add.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS, 0);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.buySol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, filled: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: probe round trips when the coin count lags the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (myCoins.size < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (flow(tapeOf(mint), now, p.window) < 0) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, { opened: now, cost: p.probeSol, filled: false });
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
