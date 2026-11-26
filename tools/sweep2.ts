// Grid sweep round 2: exits and sizing around the best region (rq>=20, share<=0.3).
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532', 'dev', ds.sha256));
const sol = (x: bigint) => Number(x) / 1e9;

const base: Partial<Params> = {
  minRqSol: 20, maxRqSol: 80, minBuyers: 4, maxBuyerShare: 0.3,
  minNetSol: 0.5, minBuys: 3, minSellers: 2, minTrades: 6,
  minAge: 500, minPriceUp: 0.03, maxPriceUp: 0.8, nearHigh: 0.9,
};
const combos: Partial<Params>[] = [];
for (const takeProfit of [0.15, 0.25, 0.4]) {
  for (const stopLoss of [0.06, 0.1]) {
    for (const buySol of [0.05, 0.15]) {
      combos.push({ ...base, takeProfit, stopLoss, buySol, maxExposureSol: 5, trail: 0.12, trailArm: 0.06, maxHold: 800 });
    }
  }
}
// trailing-stop-led: huge TP, trail does the work
for (const trail of [0.06, 0.1]) {
  for (const trailArm of [0.03, 0.06]) {
    combos.push({ ...base, takeProfit: 10, stopLoss: 0.15, buySol: 0.1, maxExposureSol: 5, trail, trailArm, maxHold: 2000 });
  }
}
// exits off: fade and bigSell disabled, long hold
combos.push({ ...base, takeProfit: 0.25, stopLoss: 0.1, buySol: 0.1, maxExposureSol: 5, trail: 0.12, trailArm: 0.06, maxHold: 2000, fadeNetSol: 1000, bigSellSol: 1000 });
// tight scalp
combos.push({ ...base, takeProfit: 0.08, stopLoss: 0.05, buySol: 0.1, maxExposureSol: 5, trail: 0.12, trailArm: 0.06, maxHold: 300 });

const rows: { net: number; line: string }[] = [];
for (const c of combos) {
  const params = { ...DEFAULT_PARAMS, ...c };
  const r = simulate(ds, hello, createStrategy(params));
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  rows.push({ net: sol(r.netPnl), line: `${sol(r.netPnl).toFixed(3)} net  dd ${r.maxDrawdown.toFixed(3)}  trips ${r.trips.length} wins ${wins} coins ${r.mints} | tp${c.takeProfit} sl${c.stopLoss} buy${c.buySol} trail${c.trail}/${c.trailArm} hold${c.maxHold} fade${c.fadeNetSol ?? 1.5}` });
}
rows.sort((a, b) => b.net - a.net);
for (const row of rows.slice(0, 12)) console.log(row.line);
console.log('... worst:', rows[rows.length - 1].line);
