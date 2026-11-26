# Strategy note — Steady Scalper

## What it is

A Sharpe-first paper bot for the pump.fun replay (agent-fun/replay/v2).
The rank key is the hourly Sharpe ratio, so the bot optimises for many small,
repeatable trades with a smooth equity curve, not one moonshot.

## What the dev window showed

Simple momentum chasing loses on this tape: every momentum/dip/early-entry
rule tested on the dev window has a negative mean return before fees, and the
pilot momentum baseline loses −9.4 SOL with 95% drawdown. What survives is
panic mean-reversion: after a sharp dump, prices overshoot and bounce. So the
bot buys the bounce, not the breakout.

## Rules

- **Entry (dump-recovery).** Buy 0.05 SOL when a curve's price fell at least
  25% over the last 10 slots and then recovered at least 1% over the last 5
  slots. One entry per coin, 200-slot cooldown after an exit, real SOL reserve
  2–80 SOL, at most 5 SOL deployed at once.
- **Exit.** Take-profit +6% of value, stop-loss −9% of value (value is net of
  the ~2.6% round-trip fees, so these are about +10% / −5% of price), a hard
  200-slot time limit. No trailing stop, no fade exit: the bounce is either
  there within 200 slots or it is not.
- **Guardrail.** The run needs ≥ 20 distinct coins with a ≥ 0.01 SOL round
  trip and max drawdown ≤ 50%. When the distinct-coin count lags a
  25-coins-per-6-hours pace, tiny 0.02 SOL probe round trips open on liquid
  curves with non-negative recent flow and close on their own small targets
  (+6% / −4% / 150 slots).

## Dev-window result (local replay; the kit's own grader confirms it)

Net −0.013 SOL over the 24 h dev window, 29 round trips over 29 coins,
8 wins, max drawdown 0.36%, guardrails met. Essentially breakeven with a
very flat equity curve — the best of all variants tested (momentum variants
lost −0.10 to −0.59 SOL, the pilot baseline −9.4 SOL). The final window is a
different 6 h slice, so this is a robustness-first entry, not a fitted one:
few trades, tiny stakes, no pyramiding, no reliance on any single coin.

## Costs

Fees are ~1.25% of size per side plus ~0.000105 SOL of tx fees per order, so
a 0.05 SOL round trip costs roughly 2.9%.

## Determinism

No clock, no randomness; iteration only over insertion-ordered maps fed by
the batch stream. Two runs produce identical action logs.
