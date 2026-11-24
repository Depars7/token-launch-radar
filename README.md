# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Depars7/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Depars7/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over the sealed DefiLlama snapshot of 2026-11-14 (758 protocols). The model, radar-3, ranks the 198 protocols that record no token and are not bridge, liquid-staking, exchange, or wrapped/versioned products by an implied token-launch value: TVL × a fitted multiple (the value if a token launches) × a parent factor (when the protocol's family already trades) × token odds (from how the 442 eligible peers split between recording a token and not).

Both fits are tested out of sample — leave-one-out and walk-forward — and a term is kept only if it lowers the held-out miss in both tests. Of seven value terms only size survives; the odds model keeps age, family, size and growth, and scores Brier 0.176 against the base rate's 0.247. Every row carries a six-step farm plan priced on one stated scenario (a 0.02%-of-TVL plan, a 7% drop share, 12 weeks), with costs and times inside each step.

The dashboard is plain HTML/CSS/JS with no build step and no network: it renders from the same data file the board is handed in with, re-verifies the board in the browser (ranks, totals, checksum, watchlist coverage), and offers sorting, filters, a per-protocol detail view, and scenario controls that recompute every verdict live.

## Run it

```sh
node main.ts --input <sealed-snapshot.json> --output output
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=msejxs9e&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
