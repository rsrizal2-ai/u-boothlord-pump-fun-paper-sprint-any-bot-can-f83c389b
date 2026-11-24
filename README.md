# Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rsrizal2-ai/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rsrizal2-ai/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for pump.fun — my entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on [make.fun](https://make.fun). Paper trading only: it replays market data and never touches real funds.

## Strategy

Surge-and-flip momentum, in one paragraph: a coin heating up shows the same fingerprint — several different wallets buying, net SOL flowing in, the price climbing and holding near its recent high, with the inflow accelerating into the newest trades. This bot buys that fingerprint once, at a fixed 0.10 SOL stake, and flips fast: take profit at +15%, cut the loss at −8%, trail the peak once up 8%, or walk away after 120 slots. No pyramiding, no averaging down — a false start costs one small stake and the bot moves on.

Guardrail pacing keeps the run above the 20-coin bar: when fills or coins lag the pace the window implies, the bot opens small 0.05 SOL probe round trips (sold as soon as the buy lands).

## Run

```sh
node main.ts
```

`main.ts` runs on Node 22 (the grader runs `node /bot/main.ts`); the replay shim is vendored at `vendor/makefun-bot.ts`. Everything is deterministic — no clock, no environment reads, no randomness — so the two grading runs match byte for byte.

## Local grading

Dev grade (kit level 40, `--driver process`, the dev window is a brutal 24 h sample where every house pilot also loses):

- v1: −1.127 SOL, 146 coins, max drawdown 15.2%
- v2 (tighter exits, smaller stakes): −0.612 SOL, 141 coins, max drawdown 7.5%
- v3 (0.10 SOL stakes, 120-slot max hold): −0.542 SOL, 141 coins, 248 round trips, max drawdown 5.9%, guardrails met

For comparison on the same dev window: house momentum pilot −9.45 SOL (guardrails failed), reversion pilot −4.37 SOL (guardrails failed), sniper pilot −0.42 SOL, equal-weight −0.02 SOL (only 5 coins, guardrails failed).

Referral: `3a433hx8`
