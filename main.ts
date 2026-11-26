// Steady Scalper — a Sharpe-first paper bot for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte as vendor/makefun-bot.ts.
// Paper money only: 10 SOL of simulated capital on replayed Solana chain data. Nothing
// is traded for real, no network call is made, no key is read.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
