// Launch Radar, model radar-3: pre-token protocols valued from their own record.
//
// Two fitted models, both trained only on the snapshot's own figures and both tested held-out
// (leave-one-out and walk-forward) before any term is kept:
//
//   value  log(market cap / TVL) of the traded peers that carry a usable cap (the ample set),
//          as a function of size, family, 7-day growth, age and chain count, plus a placebo
//          control. A term is kept only when it lowers the held-out miss in BOTH tests.
//   odds   a logistic fit on all 442 peers of the board's universe (244 of them record a
//          token), scored by Brier score under the same two tests and the same keep rule.
//
// implied value = (value if a token launches) x (token odds). Nothing is hardcoded by name:
// every number on the board is computed from the snapshot's TVL, 7-day change, listing date,
// chains and category, and the fits above.

import { createHash } from 'node:crypto';

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-3';

/** The farm scenario the board prices by default; the dashboard's controls recompute it live. */
export const SCENARIO = { planPct: 0.0002, planMin: 250, planMax: 25_000, dropShare: 0.07, weeks: 12, hoursPerWeek: 1.5 };

const DAY_MS = 86_400_000;

export class SnapshotError extends Error {}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot is not JSON');
  }
  const snap = raw as Snapshot;
  if (typeof snap?.as_of !== 'string' || !Array.isArray(snap?.protocols) || !Array.isArray(snap?.watchlist)) {
    throw new SnapshotError('snapshot is missing as_of, protocols or watchlist');
  }
  for (const p of snap.protocols) {
    if (typeof p?.slug !== 'string' || typeof p?.name !== 'string' || typeof p?.tvl_usd !== 'number') {
      throw new SnapshotError('a protocol is missing slug, name or tvl_usd');
    }
  }
  return snap;
}

/** Whole days from a YYYY-MM-DD date to the snapshot's as_of date. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((a - b) / DAY_MS));
}

export function ageYears(asOf: string, listedAt: string | null): number | null {
  const d = ageDays(asOf, listedAt);
  return d === null ? null : d / 365.25;
}

export const hasToken = (p: SnapshotProtocol): boolean => p.gecko_id !== null || p.symbol !== null;

const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Why a pre-token protocol is left off the board, or null when it is ranked. The house's own rule. */
export function outReason(p: SnapshotProtocol): 'bridge' | 'liquid staking' | 'exchange' | 'versioned or wrapped' | null {
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') return 'liquid staking';
  if (p.category === 'CEX') return 'exchange';
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name) || EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return 'versioned or wrapped';
  return null;
}

/** A name family: the first word of the name, lowercased (Sentora Curator -> sentora). */
const famKeyCache = new Map<string, string>();
export function familyKey(name: string): string {
  let key = famKeyCache.get(name);
  if (key === undefined) {
    const first = name.trim().split(/\s+/)[0] ?? '';
    key = first.toLowerCase().replace(/[^a-z0-9]/g, '');
    famKeyCache.set(name, key);
  }
  return key;
}

// ---------- small statistics and linear algebra (deterministic, no dependencies) ----------

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const at = Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)));
  return s[at]!;
}
/** Seeded PRNG so the bootstrap is identical on every run (run_deterministic). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c] = M[r]![c]! - f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}
/** Ridge fit: minimise ||y - Xb||^2 + sum(pen_j * b_j^2). pen 0 on the intercept. */
function ridgeFit(X: number[][], y: number[], pen: number[]): number[] {
  const k = pen.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    for (let a = 0; a < k; a++) {
      b[a] += xi[a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c] += xi[a]! * xi[c]!;
    }
  }
  for (let a = 0; a < k; a++) A[a]![a] += pen[a]!;
  return solve(A, b);
}
const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
/** Logistic fit by IRLS with a small ridge for stability; `init` warm-starts it (LOO folds). */
function logisticFit(X: number[][], y: number[], pen = 1e-3, init?: number[]): number[] {
  const k = X[0]!.length;
  let beta = init !== undefined ? [...init] : new Array<number>(k).fill(0);
  if (init === undefined) beta[0] = Math.log((mean(y) + 0.01) / (1 - mean(y) + 0.01));
  for (let iter = 0; iter < 12; iter++) {
    const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const g = new Array<number>(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      const xi = X[i]!;
      const p = sigmoid(dot(beta, xi));
      const w = Math.max(1e-6, p * (1 - p));
      for (let a = 0; a < k; a++) {
        g[a] += xi[a]! * (y[i]! - p);
        for (let c = 0; c < k; c++) A[a]![c] += w * xi[a]! * xi[c]!;
      }
    }
    for (let a = 0; a < k; a++) {
      A[a]![a] += a === 0 ? 1e-9 : pen;
      g[a] -= (a === 0 ? 0 : pen) * beta[a]!;
    }
    const step = solve(A, g);
    beta = beta.map((v, i) => v + step[i]!);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return beta;
}

// ---------- features shared by both models ----------

interface Feat {
  size: number;
  growth: number;
  age: number;
  chains: number;
  control: number;
}

/** 7-day TVL change (per cent) compressed so a +4,000% outlier cannot run the fit. */
const growthOf = (c: number | null): number => (c === null ? 0 : Math.sign(c) * Math.log1p(Math.abs(c) / 25));

function featureBuilder(snapshot: Snapshot): (p: SnapshotProtocol) => Feat {
  const ages = snapshot.protocols.map((p) => ageYears(snapshot.as_of, p.listed_at)).filter((x): x is number => x !== null);
  const medAge = median(ages);
  const bySlug = [...snapshot.protocols].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const control = new Map<string, number>();
  bySlug.forEach((p, i) => {
    const other = bySlug[(i + 1) % bySlug.length]!;
    control.set(p.slug, growthOf(other.change_7d));
  });
  return (p) => ({
    size: Math.log10(p.tvl_usd / 1e8),
    growth: growthOf(p.change_7d),
    age: ageYears(snapshot.as_of, p.listed_at) ?? medAge,
    chains: p.chains.length,
    control: control.get(p.slug) ?? 0,
  });
}

// ---------- the value model: what a token would be worth if one launched ----------

export interface ValueTermRow {
  term: string;
  loo: number;
  wf: number;
  verdict: 'baseline' | 'kept' | 'tested, not kept' | 'must not help';
}

interface CompRow {
  p: SnapshotProtocol;
  y: number; // log(mcap / TVL)
  feat: Feat;
}

const VALUE_TERM_ORDER = ['size', 'family', 'sizeRidge', 'growth', 'age', 'chains', 'control'] as const;
type ValueTerm = (typeof VALUE_TERM_ORDER)[number];
const VALUE_TERM_LABEL: Record<ValueTerm, string> = {
  size: '+ size, in TVL',
  family: '+ family effect – ridge 16',
  sizeRidge: '+ size, ridge 64',
  growth: '+ 7-day TVL growth',
  age: '+ age, years listed',
  chains: '+ chain count',
  control: '+ control: growth of another row',
};
const VALUE_TERM_PEN: Record<string, number> = { sizeRidge: 64 };

/** Design row for a protocol under a term set; the family column comes from the fold's own residuals. */
function valueDesign(feat: Feat, famCol: number, terms: readonly string[]): number[] {
  const row = [1];
  for (const t of VALUE_TERM_ORDER) {
    if (!terms.includes(t)) continue;
    if (t === 'size') row.push(feat.size);
    else if (t === 'family') row.push(famCol);
    else if (t === 'sizeRidge') row.push(feat.size);
    else if (t === 'growth') row.push(feat.growth);
    else if (t === 'age') row.push(feat.age);
    else if (t === 'chains') row.push(feat.chains);
    else if (t === 'control') row.push(feat.control);
  }
  return row;
}
function valuePens(terms: readonly string[]): number[] {
  const pen = [0];
  for (const t of VALUE_TERM_ORDER) if (terms.includes(t)) pen.push(VALUE_TERM_PEN[t] ?? 0);
  return pen;
}

interface ValueFit {
  beta: number[];
  famColOf: (p: SnapshotProtocol, feat: Feat) => number;
  predict: (p: SnapshotProtocol, feat: Feat) => number;
}

/** Fit the value model on a set of comps. The family column is built from the fold's own
 *  intercept+size residuals, shrunk by ridge 16, so no fold ever sees its own answer. */
function fitValue(train: CompRow[], featOf: (p: SnapshotProtocol) => Feat, terms: readonly string[]): ValueFit {
  const useFam = terms.includes('family');
  let famEffect = new Map<string, number>();
  if (useFam) {
    const baseTerms = terms.filter((t) => t === 'size');
    const baseBeta = ridgeFit(train.map((r) => valueDesign(r.feat, 0, baseTerms)), train.map((r) => r.y), valuePens(baseTerms));
    const sums = new Map<string, { s: number; n: number }>();
    for (const r of train) {
      const resid = r.y - dot(baseBeta, valueDesign(r.feat, 0, baseTerms));
      const key = familyKey(r.p.name);
      const cur = sums.get(key) ?? { s: 0, n: 0 };
      cur.s += resid;
      cur.n += 1;
      sums.set(key, cur);
    }
    famEffect = new Map([...sums.entries()].map(([k, v]) => [k, v.s / (v.n + 16)]));
  }
  const famColOf = (p: SnapshotProtocol): number => (useFam ? famEffect.get(familyKey(p.name)) ?? 0 : 0);
  const X = train.map((r) => valueDesign(r.feat, famColOf(r.p), terms));
  const beta = ridgeFit(X, train.map((r) => r.y), valuePens(terms));
  return { beta, famColOf: (p) => famColOf(p), predict: (p, feat) => dot(beta, valueDesign(feat, famColOf(p), terms)) };
}

/** The typical miss: the median absolute log error, as a multiple (a "x4.4" reads either way). */
const missOf = (resids: number[]): number => Math.exp(median(resids.map((r) => Math.abs(r))));

function evalValue(comps: CompRow[], featOf: (p: SnapshotProtocol) => Feat, terms: readonly string[]): { loo: number; wf: number; looResid: number[]; looPredCap: number[]; wfPred: { resid: number; predCap: number; actual: number }[] } {
  const looResid: number[] = [];
  const looPredCap: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const fit = fitValue(train, featOf, terms);
    const pred = fit.predict(comps[i]!.p, comps[i]!.feat);
    looResid.push(comps[i]!.y - pred);
    looPredCap.push(Math.exp(pred) * comps[i]!.p.tvl_usd);
  }
  const dated = comps.filter((r) => r.p.listed_at !== null).sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const wfPred: { resid: number; predCap: number; actual: number }[] = [];
  for (let j = Math.floor(dated.length / 2); j < dated.length; j++) {
    const target = dated[j]!;
    const train = dated.slice(0, j).filter((r) => r.p.listed_at! <= target.p.listed_at!);
    if (train.length < 10) continue;
    const fit = fitValue(train.map((r) => comps.find((c) => c.p.slug === r.p.slug) ?? r), featOf, terms);
    const pred = fit.predict(target.p, target.feat);
    wfPred.push({ resid: target.y - pred, predCap: Math.exp(pred) * target.p.tvl_usd, actual: target.p.mcap_usd! });
  }
  return { loo: missOf(looResid), wf: missOf(wfPred.map((x) => x.resid)), looResid, looPredCap, wfPred };
}

export interface ValueModel {
  terms: ValueTermRow[];
  kept: string[];
  comps: number;
  looMiss: number;
  wfMiss: number;
  betaSe: Record<string, number>;
  beta: Record<string, number>;
  residQ: { q10: number; q25: number; q75: number; q90: number };
  cover: { p2575Loo: number; p2575Wf: number; p1090Loo: number; p1090Wf: number; within3Loo: number; within3Wf: number };
  predict: (p: SnapshotProtocol, feat: Feat) => { valueIf: number; parentFactor: number };
}

function fitValueModel(snapshot: Snapshot, featOf: (p: SnapshotProtocol) => Feat): ValueModel {
  const comps: CompRow[] = snapshot.protocols
    .filter((p) => hasToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && outReason(p) === null)
    .map((p) => ({ p, y: Math.log(p.mcap_usd! / p.tvl_usd), feat: featOf(p) }));
  const rows: ValueTermRow[] = [];
  let kept: string[] = [];
  let cur = evalValue(comps, featOf, kept);
  rows.push({ term: 'flat median multiple', loo: cur.loo, wf: cur.wf, verdict: 'baseline' });
  for (const t of VALUE_TERM_ORDER) {
    const trial = [...kept, t];
    const ev = evalValue(comps, featOf, trial);
    const better = ev.loo < cur.loo - 1e-12 && ev.wf < cur.wf - 1e-12;
    if (better) {
      kept = trial;
      cur = ev;
      rows.push({ term: VALUE_TERM_LABEL[t], loo: ev.loo, wf: ev.wf, verdict: 'kept' });
    } else {
      rows.push({ term: VALUE_TERM_LABEL[t], loo: ev.loo, wf: ev.wf, verdict: t === 'control' ? 'must not help' : 'tested, not kept' });
    }
  }
  const finalFit = fitValue(comps, featOf, kept);
  const finalEval = evalValue(comps, featOf, kept);
  const rq = {
    q10: quantile(finalEval.looResid, 0.1),
    q25: quantile(finalEval.looResid, 0.25),
    q75: quantile(finalEval.looResid, 0.75),
    q90: quantile(finalEval.looResid, 0.9),
  };
  const inside = (predCap: number, actual: number, lo: number, hi: number): boolean =>
    actual >= predCap * Math.exp(lo) && actual <= predCap * Math.exp(hi);
  const cover = {
    p2575Loo: 0,
    p2575Wf: 0,
    p1090Loo: 0,
    p1090Wf: 0,
    within3Loo: finalEval.looResid.filter((r) => Math.abs(r) <= Math.log(3)).length / comps.length,
    within3Wf: finalEval.wfPred.length
      ? finalEval.wfPred.filter((w) => Math.abs(w.resid) <= Math.log(3)).length / finalEval.wfPred.length
      : 0,
  };
  {
    let a = 0;
    let b = 0;
    for (let i = 0; i < comps.length; i++) {
      if (inside(finalEval.looPredCap[i]!, comps[i]!.p.mcap_usd!, rq.q25, rq.q75)) a++;
      if (inside(finalEval.looPredCap[i]!, comps[i]!.p.mcap_usd!, rq.q10, rq.q90)) b++;
    }
    cover.p2575Loo = a / comps.length;
    cover.p1090Loo = b / comps.length;
    let c = 0;
    let d = 0;
    for (const w of finalEval.wfPred) {
      if (inside(w.predCap, w.actual, rq.q25, rq.q75)) c++;
      if (inside(w.predCap, w.actual, rq.q10, rq.q90)) d++;
    }
    cover.p2575Wf = finalEval.wfPred.length ? c / finalEval.wfPred.length : 0;
    cover.p1090Wf = finalEval.wfPred.length ? d / finalEval.wfPred.length : 0;
  }
  const rng = mulberry32(20261114);
  const boot: number[][] = [];
  for (let rep = 0; rep < 200; rep++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rng() * comps.length)]!);
    boot.push(fitValue(sample, featOf, kept).beta);
  }
  const names = ['intercept', ...VALUE_TERM_ORDER.filter((t) => kept.includes(t)).map((t) => t)];
  const beta: Record<string, number> = {};
  const betaSe: Record<string, number> = {};
  names.forEach((name, i) => {
    beta[name] = finalFit.beta[i]!;
    const xs = boot.map((b) => b[i]!);
    const m = mean(xs);
    betaSe[name] = Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
  });
  // A protocol whose family already records a token is priced off that family's own record:
  // the family's shrunk residual under the fitted model, as a multiplier on the value. (When
  // the family term itself survives both tests it is already inside the fit, and no separate
  // factor is applied.)
  const famResid = new Map<string, { s: number; n: number }>();
  for (const r of comps) {
    const resid = r.y - finalFit.predict(r.p, r.feat);
    const key = familyKey(r.p.name);
    const cur2 = famResid.get(key) ?? { s: 0, n: 0 };
    cur2.s += resid;
    cur2.n += 1;
    famResid.set(key, cur2);
  }
  const parentFactorOf = (p: SnapshotProtocol): number => {
    if (kept.includes('family')) return 1;
    const v = famResid.get(familyKey(p.name));
    if (v === undefined || v.n === 0) return 1;
    const eff = (v.s / v.n) * (v.n / (v.n + 4));
    return Math.min(2.5, Math.max(0.2, Math.exp(eff)));
  };
  return {
    terms: rows,
    kept,
    comps: comps.length,
    looMiss: finalEval.loo,
    wfMiss: finalEval.wf,
    betaSe,
    beta,
    residQ: rq,
    cover,
    predict: (p, feat) => {
      const logMult = finalFit.predict(p, feat);
      return { valueIf: p.tvl_usd * Math.exp(logMult), parentFactor: parentFactorOf(p) };
    },
  };
}

// ---------- the odds model: which peers go on to record a token ----------

export interface OddsTermRow {
  term: string;
  loo: number;
  wf: number;
  looRight: number;
  wfRight: number;
  verdict: 'baseline' | 'kept' | 'tested, not kept' | 'must not help';
}

interface PeerRow {
  p: SnapshotProtocol;
  y: 0 | 1;
  feat: Feat;
}

const ODDS_TERM_ORDER = ['age', 'family', 'size', 'growth', 'chains', 'control'] as const;
const ODDS_TERM_LABEL: Record<(typeof ODDS_TERM_ORDER)[number], string> = {
  age: '+ age, years listed',
  family: '+ family already traded',
  size: '+ size, in TVL',
  growth: '+ 7-day TVL growth',
  chains: '+ chain count',
  control: '+ control: growth of another row',
};

function oddsDesign(feat: Feat, famShare: number, terms: readonly string[]): number[] {
  const row = [1];
  for (const t of ODDS_TERM_ORDER) {
    if (!terms.includes(t)) continue;
    if (t === 'age') row.push(feat.age);
    else if (t === 'family') row.push(famShare);
    else if (t === 'size') row.push(feat.size);
    else if (t === 'growth') row.push(feat.growth);
    else if (t === 'chains') row.push(feat.chains);
    else if (t === 'control') row.push(feat.control);
  }
  return row;
}

/** Share of a protocol's family that records a token, the protocol itself left out, smoothed. */
function famShareOf(peers: PeerRow[], self: PeerRow): number {
  const key = familyKey(self.p.name);
  let traded = 0;
  let total = 0;
  for (const r of peers) {
    if (r.p.slug === self.p.slug) continue;
    if (familyKey(r.p.name) !== key) continue;
    total++;
    traded += r.y;
  }
  const base = mean(peers.map((r) => r.y));
  return (traded + 2 * base) / (total + 2);
}

function evalOdds(peers: PeerRow[], terms: readonly string[]): { loo: number; wf: number; looRight: number; wfRight: number } {
  // The family share of a peer never depends on the fold (it already leaves the peer itself
  // out), so every design row is built once here and the folds just drop rows.
  const shares = peers.map((r) => famShareOf(peers, r));
  const XFull = peers.map((r, i) => oddsDesign(r.feat, shares[i]!, terms));
  const ys = peers.map((r) => r.y);
  const fullBeta = logisticFit(XFull, ys);
  const brier = (preds: number[], yy: number[]): number => mean(preds.map((p, i) => (p - yy[i]!) ** 2));
  const right = (preds: number[], yy: number[]): number => mean(preds.map((p, i) => ((p >= 0.5 ? 1 : 0) === yy[i]! ? 1 : 0)));
  const looPred: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const X = XFull.filter((_, j) => j !== i);
    const beta = logisticFit(X, ys.filter((_, j) => j !== i), 1e-3, fullBeta);
    looPred.push(sigmoid(dot(beta, XFull[i]!)));
  }
  const at = new Map(peers.map((r, i) => [r.p.slug, i]));
  const dated = peers.filter((r) => r.p.listed_at !== null).sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const wfPred: number[] = [];
  const wfY: number[] = [];
  for (let j = Math.floor(dated.length / 2); j < dated.length; j++) {
    const train = dated.slice(0, j);
    if (train.length < 20) continue;
    const beta = logisticFit(train.map((r) => XFull[at.get(r.p.slug)!]!), train.map((r) => r.y), 1e-3, fullBeta);
    wfPred.push(sigmoid(dot(beta, XFull[at.get(dated[j]!.p.slug)!]!)));
    wfY.push(dated[j]!.y);
  }
  return { loo: brier(looPred, ys), wf: brier(wfPred, wfY), looRight: right(looPred, ys), wfRight: right(wfPred, wfY) };
}

export interface OddsModel {
  terms: OddsTermRow[];
  kept: string[];
  peers: number;
  recorded: number;
  baseRate: number;
  looBrier: number;
  wfBrier: number;
  looRight: number;
  wfRight: number;
  predict: (p: SnapshotProtocol, feat: Feat) => number;
}

function fitOddsModel(snapshot: Snapshot, featOf: (p: SnapshotProtocol) => Feat): OddsModel {
  const peers: PeerRow[] = snapshot.protocols
    .filter((p) => outReason(p) === null)
    .map((p) => ({ p, y: hasToken(p) ? 1 : 0, feat: featOf(p) }));
  const rows: OddsTermRow[] = [];
  let kept: string[] = [];
  let cur = evalOdds(peers, kept);
  rows.push({ term: 'base rate of peers', loo: cur.loo, wf: cur.wf, looRight: cur.looRight, wfRight: cur.wfRight, verdict: 'baseline' });
  for (const t of ODDS_TERM_ORDER) {
    const trial = [...kept, t];
    const ev = evalOdds(peers, trial);
    const better = ev.loo < cur.loo - 1e-12 && ev.wf < cur.wf - 1e-12;
    if (better) {
      kept = trial;
      cur = ev;
      rows.push({ term: ODDS_TERM_LABEL[t], loo: ev.loo, wf: ev.wf, looRight: ev.looRight, wfRight: ev.wfRight, verdict: 'kept' });
    } else {
      rows.push({ term: ODDS_TERM_LABEL[t], loo: ev.loo, wf: ev.wf, looRight: ev.looRight, wfRight: ev.wfRight, verdict: t === 'control' ? 'must not help' : 'tested, not kept' });
    }
  }
  const X = peers.map((r) => oddsDesign(r.feat, famShareOf(peers, r), kept));
  const beta = logisticFit(X, peers.map((r) => r.y));
  return {
    terms: rows,
    kept,
    peers: peers.length,
    recorded: peers.filter((r) => r.y === 1).length,
    baseRate: mean(peers.map((r) => r.y)),
    looBrier: cur.loo,
    wfBrier: cur.wf,
    looRight: cur.looRight,
    wfRight: cur.wfRight,
    predict: (p, feat) => {
      const self: PeerRow = { p, y: 0, feat };
      return sigmoid(dot(beta, oddsDesign(feat, famShareOf(peers, self), kept)));
    },
  };
}

// ---------- the farm plan: what farming a row pays under the stated scenario ----------

const L2_CHAINS = new Set(['Base', 'Arbitrum', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Ink', 'Mode', 'Taiko', 'Metis', 'Zora', 'Unichain', 'Soneium', 'World Chain']);
type ChainClass = 'ethereum' | 'l2' | 'solana' | 'other';
function chainClass(chain: string): ChainClass {
  if (chain === 'Ethereum') return 'ethereum';
  if (chain === 'Solana') return 'solana';
  if (L2_CHAINS.has(chain)) return 'l2';
  return 'other';
}
const SETUP_FEE: Record<ChainClass, number> = { ethereum: 6.0, l2: 2.4, solana: 0.3, other: 1.5 };
const ACTION_FEE: Record<ChainClass, number> = { ethereum: 0.9, l2: 0.05, solana: 0.01, other: 0.25 };
const ACTIONS = 9;

const fmtInt = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const fmtMoney = (n: number): string => `$${fmtInt(n)}`;
export function fmtMoneyShort(n: number): string {
  const trim = (s: string): string => s.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
  if (n >= 1e9) return `$${trim((n / 1e9).toFixed(2))}B`;
  if (n >= 1e6) return `$${trim((n / 1e6).toFixed(1))}M`;
  if (n >= 1e3) return `$${trim((n / 1e3).toFixed(1))}K`;
  return `$${fmtInt(n)}`;
}

function coreAction(p: SnapshotProtocol, chain: string): string {
  switch (p.category) {
    case 'Lending':
      return 'supply the main stablecoin market and take one small borrow against it, so both sides of the book see the wallet';
    case 'CDP':
      return 'open a small vault and mint the stablecoin against it, then hold or farm the minted amount inside the app';
    case 'Dexs':
      return 'provide liquidity to the flagship pair and route a few swaps a week through it';
    case 'Derivatives':
      return 'trade the flagship perpetual market in small size, opening and closing both a long and a short over the window';
    case 'Yield':
      return 'deposit into the flagship yield vault and hold the receipt token in the same wallet';
    case 'Risk Curators':
      return `deposit into the flagship curated vault on ${chain} and hold the vault shares untouched`;
    case 'Onchain Capital Allocator':
      return 'allocate to the flagship strategy vault and hold the shares for the whole window';
    case 'RWA':
      return 'buy or mint the tokenised asset through the app and hold it in the wallet';
    case 'Launchpad':
      return 'take part in one launch allocation and hold whatever it issues';
    case 'Payments':
      return 'route one real payment a week through it, the way a customer would';
    default:
      return 'use the core product the way a real user would, in the wallet that holds the position';
  }
}

export interface FarmPlan {
  plan: number;
  fees: number;
  grossIf: number;
  ev: number;
  netHour: number;
  verdict: 'farm' | 'marginal' | 'skip';
  steps: string[];
}

function farmPlan(p: SnapshotProtocol, valueIf: number, odds: number): FarmPlan {
  const chain = p.chains[0] ?? 'Ethereum';
  const cls = chainClass(chain);
  const plan = Math.round(Math.min(SCENARIO.planMax, Math.max(SCENARIO.planMin, SCENARIO.planPct * p.tvl_usd)));
  const fees = Math.round((SETUP_FEE[cls] + ACTIONS * ACTION_FEE[cls]) * 100) / 100;
  const share = plan / (p.tvl_usd + plan);
  const grossIf = SCENARIO.dropShare * valueIf * share;
  const ev = odds * grossIf - fees;
  const hours = SCENARIO.weeks * SCENARIO.hoursPerWeek;
  const netHour = ev / hours;
  const verdict: FarmPlan['verdict'] = ev <= 0 ? 'skip' : ev >= 50 && netHour >= 4 ? 'farm' : 'marginal';
  const oddsPct = `${Math.round(odds * 100)}%`;
  const feesTxt = `$${fees.toFixed(2)}`;
  const rawPlan = SCENARIO.planPct * p.tvl_usd;
  const sizing =
    rawPlan > SCENARIO.planMax
      ? `0.02% of its ${fmtMoneyShort(p.tvl_usd)} TVL would be ${fmtMoney(Math.round(rawPlan))}, over the plan cap, so the plan goes in at the ${fmtMoney(SCENARIO.planMax)} cap`
      : rawPlan < SCENARIO.planMin
        ? `0.02% of its ${fmtMoneyShort(p.tvl_usd)} TVL comes to less than the ${fmtMoney(SCENARIO.planMin)} plan minimum, so the plan goes in at the minimum`
        : `sized at 0.02% of its ${fmtMoneyShort(p.tvl_usd)} TVL`;
  const steps = [
    `Connect a fresh wallet to ${p.name} on ${chain} and put the plan in: ${fmtMoney(plan)} of stablecoins, ${sizing}. Budget ${feesTxt} all-in for bridge and network fees; about 20 minutes to set up.`,
    `Work the position for ${SCENARIO.weeks} weeks: ${coreAction(p, chain)}. About ${SCENARIO.hoursPerWeek} hours a week, ${hours} hours in all, which is what the net-per-hour figure divides by.`,
    p.chains.length > 1
      ? `In week 2, spread a second position of ${fmtMoney(Math.round(plan / 4))} to ${p.chains[1]}, the protocol's second chain, so the wallet shows up in both deployments if a snapshot is ever taken per chain.`
      : `In week 2, make a second, smaller deposit of ${fmtMoney(Math.round(plan / 4))} from the same wallet, so the record shows a returning user rather than a single visit.`,
    `Hold the full ${fmtMoney(plan)} for the whole ${SCENARIO.weeks}-week window. If the protocol's TVL doubles, top up by about ${fmtMoney(plan)} to keep the same share of any drop instead of letting the position dilute.`,
    `Watch for a launch: the peer record gives ${p.name} ${oddsPct} token odds. Check the official channels twice a week, 10 minutes at a time, so a claim or conversion window is not missed if one opens.`,
    `Run the exit maths before adding a dollar more: if a token launches at the model's ${fmtMoneyShort(valueIf)}, this plan's share of a 7% drop pays $${grossIf.toFixed(2)}; the expected gross is odds × payout = ${(odds * 100).toFixed(2)}% × $${grossIf.toFixed(2)} = $${(odds * grossIf).toFixed(2)}, and less ${feesTxt} of fees that is an expected $${ev.toFixed(2)} net. If fees or the time cost rise past that, stop.`,
  ];
  return { plan, fees, grossIf, ev, netHour, verdict, steps };
}

// ---------- the board and the dashboard's data ----------

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export interface RadarRow {
  slug: string;
  name: string;
  rank: number;
  badges: string[];
  parent: number | null;
  category: string;
  chainLabel: string;
  chains: string[];
  tvl: number;
  change7d: number | null;
  ageDays: number | null;
  odds: number;
  valueIf: number;
  implied: number;
  rangeLo: number;
  rangeHi: number;
  plan: number;
  fees: number;
  ev: number;
  netHour: number;
  verdict: 'farm' | 'marginal' | 'skip';
  steps: string[];
}

export interface AccountingSegment {
  label: string;
  count: number;
  color: string;
}

export interface RadarData {
  model: string;
  asOf: string;
  source: string;
  floorUsd: number;
  totals: { protocols: number; ranked: number; watchlist: number; impliedSum: number; tvlSum: number; checksum: string };
  kpis: { label: string; big: string; sub: string }[];
  accounting: AccountingSegment[];
  valueTerms: ValueTermRow[];
  oddsTerms: OddsTermRow[];
  ample: { value: number; oddsPeers: number };
  range: { within3Loo: number; within3Wf: number; p2575Loo: number; p2575Wf: number; p1090Loo: number; p1090Wf: number };
  coefText: string;
  readingText: string;
  scenario: typeof SCENARIO;
  rows: RadarRow[];
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const featOf = featureBuilder(snapshot);
  const value = fitValueModel(snapshot, featOf);
  const odds = fitOddsModel(snapshot, featOf);
  const watch = new Set(snapshot.watchlist);
  const tradedFamilies = new Set(snapshot.protocols.filter(hasToken).map((p) => familyKey(p.name)));

  const ranked = snapshot.protocols.filter((p) => !hasToken(p) && outReason(p) === null);
  const scored = ranked.map((p) => {
    const feat = featOf(p);
    const { valueIf, parentFactor } = value.predict(p, feat);
    const o = odds.predict(p, feat);
    const hasParent = tradedFamilies.has(familyKey(p.name));
    const valueIfR = Math.round(valueIf);
    const implied = Math.max(1, Math.round(valueIfR * parentFactor * o));
    const farm = farmPlan(p, valueIfR * parentFactor, o);
    const parent = hasParent && Math.abs(parentFactor - 1) > 0.01 ? parentFactor : null;
    const row: RadarRow = {
      slug: p.slug,
      name: p.name,
      rank: 0,
      badges: watch.has(p.slug) ? ['Watchlist'] : hasParent ? ['Off-List'] : [],
      parent,
      category: p.category ?? 'Uncategorised',
      chainLabel: (p.chains[0] ?? '—') + (p.chains.length > 1 ? ` +${p.chains.length - 1}` : ''),
      chains: p.chains,
      tvl: p.tvl_usd,
      change7d: p.change_7d,
      ageDays: ageDays(snapshot.as_of, p.listed_at),
      odds: o,
      valueIf: valueIfR,
      implied,
      rangeLo: Math.round(valueIfR * Math.exp(value.residQ.q25)),
      rangeHi: Math.round(valueIfR * Math.exp(value.residQ.q75)),
      plan: farm.plan,
      fees: farm.fees,
      ev: farm.ev,
      netHour: farm.netHour,
      verdict: farm.verdict,
      steps: farm.steps,
    };
    return row;
  });
  scored.sort((a, b) => b.implied - a.implied || b.tvl - a.tvl || (a.slug < b.slug ? -1 : 1));
  scored.forEach((r, i) => {
    r.rank = i + 1;
  });

  const board: BoardRow[] = scored.map((r) => ({ slug: r.slug, name: r.name, rank: r.rank, implied_value_usd: r.implied, farm_steps: r.steps }));

  // Protocol accounting: every one of the snapshot's protocols in exactly one group.
  const tokenPriced = snapshot.protocols.filter((p) => hasToken(p) && p.mcap_usd !== null && p.mcap_usd > 0).length;
  const tokenNoCap = snapshot.protocols.filter((p) => hasToken(p) && !(p.mcap_usd !== null && p.mcap_usd > 0)).length;
  const outCount = (reason: string): number => snapshot.protocols.filter((p) => !hasToken(p) && outReason(p) === reason).length;
  const rankedWatch = scored.filter((r) => watch.has(r.slug)).length;
  const rankedParent = scored.filter((r) => !watch.has(r.slug) && r.badges.includes('Off-List')).length;
  const accounting: AccountingSegment[] = [
    { label: 'Ranked · watchlist', count: rankedWatch, color: '#4ade80' },
    { label: 'Ranked · early, below the floor', count: scored.length - rankedWatch - rankedParent, color: '#2dd4bf' },
    { label: 'Ranked · off-list, parent recorded', count: rankedParent, color: '#8b9cff' },
    { label: 'Token trades · priced comp', count: tokenPriced, color: '#fbbf24' },
    { label: 'Token recorded · no usable cap', count: tokenNoCap, color: '#fb923c' },
    { label: 'Out · bridge', count: outCount('bridge'), color: '#64748b' },
    { label: 'Out · liquid staking', count: outCount('liquid staking'), color: '#7c8db5' },
    { label: 'Out · exchange', count: outCount('exchange'), color: '#94a3b8' },
    { label: 'Out · versioned or wrapped', count: outCount('versioned or wrapped'), color: '#a78bfa' },
  ];

  const farmCount = scored.filter((r) => r.verdict === 'farm').length;
  const skipCount = scored.filter((r) => r.verdict === 'skip').length;
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  const baseBrier = odds.baseRate * (1 - odds.baseRate);
  const keptValue = value.kept.length;
  const keptOdds = odds.kept.length;
  const kpis = [
    {
      label: 'Out-of-sample miss, walk-forward',
      big: `×${value.wfMiss.toFixed(1)}`,
      sub: `leave-one-out ×${value.looMiss.toFixed(2)} · a listed cap is missed by this factor, either way, on tokens the fit never saw`,
    },
    {
      label: 'Is the printed range honest?',
      big: `${pct(Math.min(value.cover.p2575Loo, value.cover.p2575Wf))} – ${pct(Math.max(value.cover.p2575Loo, value.cover.p2575Wf))}`,
      sub: `of listed caps fall inside P25–P75 (the model states 50%); inside P10–P90, ${pct(Math.min(value.cover.p1090Loo, value.cover.p1090Wf))} – ${pct(Math.max(value.cover.p1090Loo, value.cover.p1090Wf))} (states 80%)`,
    },
    {
      label: 'Token odds vs base rate, Brier',
      big: `${odds.looBrier.toFixed(3)} vs ${baseBrier.toFixed(3)}`,
      sub: `brier, leave-one-out (${pct(odds.looRight)} called right) vs the base rate's ${baseBrier.toFixed(3)}; walk-forward ${odds.wfBrier.toFixed(3)}`,
    },
    {
      label: 'Terms that survived both tests',
      big: `${keptValue} of ${VALUE_TERM_ORDER.length} – ${keptOdds} of ${ODDS_TERM_ORDER.length}`,
      sub: 'value model first, odds model second; a term is kept only if it lowers the held-out miss in both tests',
    },
    {
      label: 'Worth farming, this scenario',
      big: `${farmCount} of ${scored.length}`,
      sub: `net beats $50 and $4 an hour at a 0.02%-of-TVL plan; ${scored.length - farmCount - skipCount} marginal, ${skipCount} skip`,
    },
    {
      label: 'Watchlist ranked',
      big: `${rankedWatch} / ${snapshot.watchlist.length}`,
      sub: `plus ${scored.length - rankedWatch} pre-token protocols the watchlist leaves out`,
    },
  ];

  const coefParts: string[] = [`multiple at $100M TVL ×${Math.exp(value.beta['intercept']!).toFixed(2)} (±${(Math.exp(value.beta['intercept']!) * value.betaSe['intercept']!).toFixed(2)})`];
  if (value.beta['size'] !== undefined) coefParts.push(`size ${value.beta['size']!.toFixed(2)} ± ${value.betaSe['size']!.toFixed(2)} per 10× of TVL`);
  if (value.beta['growth'] !== undefined) coefParts.push(`7-day growth ${value.beta['growth']!.toFixed(2)} ± ${value.betaSe['growth']!.toFixed(2)}`);
  if (value.beta['age'] !== undefined) coefParts.push(`years listed ${value.beta['age']!.toFixed(2)} ± ${value.betaSe['age']!.toFixed(2)}`);
  if (value.beta['chains'] !== undefined) coefParts.push(`chains ${value.beta['chains']!.toFixed(2)} ± ${value.betaSe['chains']!.toFixed(2)}`);
  const famFactors = scored.filter((r) => r.parent !== null).map((r) => r.parent!);
  if (famFactors.length > 0) {
    coefParts.push(`parent factors ×${Math.min(...famFactors).toFixed(2)} to ×${Math.max(...famFactors).toFixed(2)} (family record, shrunk)`);
  }
  const coefText = `Fitted, + bootstrap se. (200 reps): ${coefParts.join('; ')}.`;
  const droppedValue = VALUE_TERM_ORDER.filter((t) => !value.kept.includes(t) && t !== 'control').map((t) => VALUE_TERM_LABEL[t].replace('+ ', ''));
  const readingText =
    `Reading: ${droppedValue.length > 0 ? `${droppedValue.join(', ')} do not price a token better held-out, so the value model leaves them out; what helps tell which peers record a token enters through the odds instead. ` : ''}` +
    (famFactors.length > 0 ? `A protocol whose family already records a token is priced off that family's own record (the Parent factor on its row). ` : '') +
    `The odds are the peers' record (${odds.recorded} of ${odds.peers} record a token, more with each year listed), not a forecast: nothing below says a token will launch.`;

  const radar: RadarData = {
    model: MODEL_VERSION,
    asOf: snapshot.as_of,
    source: snapshot.source,
    floorUsd: snapshot.floor_usd,
    totals: {
      protocols: snapshot.protocols.length,
      ranked: scored.length,
      watchlist: snapshot.watchlist.length,
      impliedSum: scored.reduce((s, r) => s + r.implied, 0),
      tvlSum: scored.reduce((s, r) => s + r.tvl, 0),
      checksum: fnv1a(scored.map((r) => `${r.slug}:${r.rank}:${r.implied}`).join(';')),
    },
    kpis,
    accounting,
    valueTerms: value.terms,
    oddsTerms: odds.terms,
    ample: { value: value.comps, oddsPeers: odds.peers },
    range: {
      within3Loo: value.cover.within3Loo,
      within3Wf: value.cover.within3Wf,
      p2575Loo: value.cover.p2575Loo,
      p2575Wf: value.cover.p2575Wf,
      p1090Loo: value.cover.p1090Loo,
      p1090Wf: value.cover.p1090Wf,
    },
    coefText,
    readingText,
    scenario: SCENARIO,
    rows: scored,
  };
  return { board, radar };
}

/** The gate's board rules, checked before anything is written: a string says what is wrong. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100 to 4,000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const row of board) {
    if (!slugs.has(row.slug)) return `row ${row.slug} is not a snapshot protocol`;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 1e14) return `row ${row.slug} has a bad implied value`;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const s of row.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `row ${row.slug} has a farm step of ${t.length} characters`;
    }
  }
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `ranks are not exactly 1 to ${byRank.length}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return 'implied value rises as rank ascends';
  }
  if (board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every implied value is the same';
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
