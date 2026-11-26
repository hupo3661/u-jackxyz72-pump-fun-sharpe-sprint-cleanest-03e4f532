// Grid sweep of strategy params on the kit's dev window, in-process.
//   node tools/sweep.ts <kit dir>
// Prints one line per combo, sorted by net PnL desc.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532', 'dev', ds.sha256));
const sol = (x: bigint) => Number(x) / 1e9;

const combos: Partial<Params>[] = [];
for (const minRqSol of [2, 10, 20]) {
  for (const minBuyers of [4, 8]) {
    for (const maxBuyerShare of [0.3, 1]) {
      for (const takeProfit of [0.08, 0.15]) {
        for (const stopLoss of [0.06, 0.1]) {
          combos.push({
            minRqSol, maxRqSol: 80, minBuyers, maxBuyerShare, takeProfit, stopLoss,
            minNetSol: 0.5, minBuys: 3, minSellers: 2, minTrades: 6,
            minAge: 500, minPriceUp: 0.03, maxPriceUp: 0.8, nearHigh: 0.9,
            buySol: 0.05, maxExposureSol: 3, trail: 0.12, trailArm: 0.06,
            fadeNetSol: 1.5, bigSellSol: 5, maxHold: 800,
          });
        }
      }
    }
  }
}

const rows: string[] = [];
for (const c of combos) {
  const params = { ...DEFAULT_PARAMS, ...c };
  const r = simulate(ds, hello, createStrategy(params));
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  rows.push(
    `${sol(r.netPnl).toFixed(3)} net  dd ${r.maxDrawdown.toFixed(3)}  trips ${r.trips.length} wins ${wins} coins ${r.mints} | rq>=${c.minRqSol} buyers>=${c.minBuyers} share<=${c.maxBuyerShare} tp${c.takeProfit} sl${c.stopLoss}`,
  );
}
rows.sort((a, b) => parseFloat(b.split(' ')[0]) - parseFloat(a.split(' ')[0]));
for (const row of rows.slice(0, 15)) console.log(row);
console.log('... worst:', rows[rows.length - 1]);
