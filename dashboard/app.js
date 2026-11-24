'use strict';
/* Launch Radar dashboard. Everything on this page is rendered from
   window.RADAR (../data.js, written by main.ts from the sealed snapshot)
   and re-verified in the browser before the chips below the accounting
   bar are shown. No network calls are made. */

const R = window.RADAR;
const $ = (s) => document.querySelector(s);

const DEPOSIT_CATS = new Set(['Lending', 'CDP', 'Yield', 'Risk Curators', 'Onchain Capital Allocator', 'RWA']);
const DEFAULTS = { planPct: 0.0002, drop: 0.07, weeks: 12 };
const state = {
  verdict: 'all', tier: 'all', q: '', cat: 'all', chain: 'all',
  sortKey: 'rank', sortDir: 1,
  planPct: DEFAULTS.planPct, drop: DEFAULTS.drop, weeks: DEFAULTS.weeks,
  picked: new Set(),
};

/* ---------- formatting (mirrors lib/model.ts) ---------- */
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
function moneyShort(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e8) return '$' + (v / 1e6).toFixed(0) + 'M';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v);
}
const money0 = (v) => (v < 0 ? '-$' : '$') + fmtInt(Math.abs(v));
const money2 = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
const pct0 = (x) => Math.round(x * 100) + '%';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ageText(days) {
  if (days === null || days === undefined) return '—';
  if (days < 365) return days + ' d';
  return (days / 365.25).toFixed(1) + ' yr';
}

/* ---------- farm scenario (same maths as lib/model.ts farmPlan) ---------- */
function scenarioOf(row) {
  const plan = Math.round(Math.min(25000, Math.max(250, state.planPct * row.tvl)));
  const share = plan / (row.tvl + plan);
  const effValue = row.valueIf * (row.parent === null ? 1 : row.parent);
  const gross = state.drop * effValue * share;
  const ev = row.odds * gross - row.fees;
  const netHour = ev / (state.weeks * 1.5);
  const verdict = ev <= 0 ? 'skip' : ev >= 50 && netHour >= 4 ? 'farm' : 'marginal';
  return { plan, ev, netHour, verdict };
}

/* ---------- header, KPIs, accounting ---------- */
function renderMeta() {
  $('#metaLine').innerHTML =
    'Snapshot: DefiLlama, sealed <b>' + esc(R.asOf) + '</b> &middot; model <b>' + esc(R.model) +
    '</b> &middot; floor <b>' + moneyShort(R.floorUsd) + '</b> TVL &middot; every figure on this page is recomputed from the board handed in';
}
function renderKpis() {
  $('#kpis').innerHTML = R.kpis.map((k) =>
    '<div class="kpi"><div class="klabel">' + esc(k.label) + '</div><div class="kbig">' + esc(k.big) +
    '</div><div class="ksub">' + esc(k.sub) + '</div></div>').join('');
}
function renderAccounting() {
  const total = R.accounting.reduce((s, a) => s + a.count, 0);
  $('#acctNote').textContent = 'all ' + fmtInt(total) + ' snapshot protocols in exactly one group: a protocol either records a token, is out under the house rule, or is ranked';
  $('#acctBar').innerHTML = R.accounting.map((a) =>
    '<div style="width:' + (a.count / total * 100).toFixed(3) + '%;background:' + a.color + '" title="' + esc(a.label) + ': ' + a.count + '"></div>').join('');
  $('#acctLegend').innerHTML = R.accounting.map((a) =>
    '<span><i class="dot" style="background:' + a.color + '"></i>' + esc(a.label) + ' &middot; ' + a.count + '</span>').join('');
}

/* ---------- verification chips: recomputed here, in the browser ---------- */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function renderChips() {
  const rows = [...R.rows].sort((a, b) => a.rank - b.rank);
  const rowsOk = rows.every((r) => Math.max(1, Math.round(r.valueIf * (r.parent === null ? 1 : r.parent) * r.odds)) === r.implied);
  const ranksOk = rows.every((r, i) => r.rank === i + 1 && (i === 0 || r.implied <= rows[i - 1].implied));
  const totalsOk = rows.reduce((s, r) => s + r.implied, 0) === R.totals.impliedSum;
  const sum = rows.map((r) => r.slug + ':' + r.rank + ':' + r.implied).join(';');
  const checksumOk = fnv1a(sum) === R.totals.checksum;
  const watchRows = rows.filter((r) => r.badges.includes('Watchlist')).length;
  const ledger = R.accounting.reduce((s, a) => s + a.count, 0);
  const chips = [
    [rowsOk, 'this table is data.js: ' + rows.length + ' of ' + R.totals.ranked + ' rows recomputed here'],
    [ranksOk, 'ranks 1–' + R.totals.ranked + ' in order, values never rise'],
    [totalsOk, 'totals equal: ' + moneyShort(R.totals.impliedSum)],
    [checksumOk, 'checksum ' + R.totals.checksum + ' = main.ts'],
    [watchRows === R.totals.watchlist, 'watchlist ' + watchRows + ' of ' + R.totals.watchlist + ' ranked'],
    [ledger === R.totals.protocols, 'ledger ' + fmtInt(ledger) + ' of ' + fmtInt(R.totals.protocols) + ' protocols'],
  ];
  $('#chips').innerHTML = chips.map(([ok, text]) =>
    '<span class="chip' + (ok ? '' : ' fail') + '">' + (ok ? '&#10003;' : '&#10007;') + ' ' + esc(text) + '</span>').join('');
}

/* ---------- out-of-sample evidence ---------- */
function verdictSpan(v) {
  if (v === 'kept') return '<span class="verdict kept">kept</span>';
  if (v === 'baseline') return '<span class="verdict base">baseline</span>';
  if (v === 'control') return '<span class="verdict tested">must not help</span>';
  return '<span class="verdict tested">tested, not kept</span>';
}
function renderEvidence() {
  $('#valueTitle').textContent = 'Value — what a token would be worth · ' + R.ample.value + ' traded tokens';
  $('#valueTable').innerHTML =
    '<tr><th>Term</th><th>Leave-one-out</th><th>Walk-forward</th><th></th></tr>' +
    R.valueTerms.map((t) =>
      '<tr><td>' + esc(t.term) + '</td><td>&times;' + t.loo.toFixed(2) + '</td><td>&times;' + t.wf.toFixed(2) + '</td><td>' + verdictSpan(t.verdict) + '</td></tr>').join('');
  $('#oddsTitle').textContent = 'Odds — will a token be recorded at all? · ' + R.ample.oddsPeers + ' peers';
  $('#oddsTable').innerHTML =
    '<tr><th>Term</th><th>Brier, leave-one-out</th><th>Brier, walk-forward</th><th></th></tr>' +
    R.oddsTerms.map((t) =>
      '<tr><td>' + esc(t.term) + '</td><td>' + t.loo.toFixed(3) + '</td><td>' + t.wf.toFixed(3) + '</td><td>' + verdictSpan(t.verdict) + '</td></tr>').join('');
  const g = R.range;
  const row = (label, a, b) => '<tr><td>' + label + '</td><td>' + Math.round(a * 100) + '%</td><td>' + Math.round(b * 100) + '%</td></tr>';
  $('#rangeTable').innerHTML =
    '<tr><th>Share of real caps</th><th>Leave-one-out</th><th>Walk-forward</th></tr>' +
    row('within &times;3 of the model', g.within3Loo, g.within3Wf) +
    row('inside P25–P75, stated 50%', g.p2575Loo, g.p2575Wf) +
    row('inside P10–P90, stated 80%', g.p1090Loo, g.p1090Wf);
  $('#coefText').textContent = R.coefText;
  $('#readingText').textContent = R.readingText;
}

/* ---------- board: filters, tabs, table ---------- */
function tierOk(row) {
  if (state.tier === 'watch') return row.badges.includes('Watchlist');
  if (state.tier === 'early') return row.tvl < R.floorUsd;
  if (state.tier === 'off') return row.badges.includes('Off-List');
  if (state.tier === 'deposit') return DEPOSIT_CATS.has(row.category);
  return true;
}
function visibleRows() {
  const q = state.q.trim().toLowerCase();
  return R.rows.filter((row) => {
    if (state.verdict !== 'all' && scenarioOf(row).verdict !== state.verdict) return false;
    if (!tierOk(row)) return false;
    if (state.cat !== 'all' && row.category !== state.cat) return false;
    if (state.chain !== 'all' && row.chain !== state.chain) return false;
    if (q && !(row.name + ' ' + row.slug + ' ' + row.category + ' ' + row.chainLabel).toLowerCase().includes(q)) return false;
    return true;
  });
}
function sortedRows(rows) {
  const k = state.sortKey, d = state.sortDir;
  const val = (r) => {
    if (k === 'ev') return scenarioOf(r).ev;
    if (k === 'netHour') return scenarioOf(r).netHour;
    if (k === 'change7d') return r.change7d === null ? -Infinity : r.change7d;
    if (k === 'ageDays') return r.ageDays === null ? -1 : r.ageDays;
    return r[k];
  };
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (typeof va === 'string') return va.localeCompare(vb) * d;
    return (va - vb) * d;
  });
}
function renderTabs() {
  const counts = { all: R.rows.length, farm: 0, marginal: 0, skip: 0 };
  for (const r of R.rows) counts[scenarioOf(r).verdict]++;
  const vt = [['all', 'All'], ['farm', 'Farm'], ['marginal', 'Marginal'], ['skip', 'Skip']];
  $('#verdictTabs').innerHTML = vt.map(([key, label]) =>
    '<button type="button" class="tab' + (state.verdict === key ? ' on' : '') + '" data-verdict="' + key + '">' +
    label + ' <span class="n">' + counts[key] + '</span></button>').join('');
  const tt = [['all', 'All tiers'], ['watch', 'Watchlist'], ['early', 'Early (&le; ' + moneyShort(R.floorUsd) + ')'], ['off', 'Off-list'], ['deposit', 'Deposit']];
  $('#tierTabs').innerHTML = tt.map(([key, label]) =>
    '<button type="button" class="tab' + (state.tier === key ? ' on' : '') + '" data-tier="' + key + '">' + label + '</button>').join('');
  document.querySelectorAll('#verdictTabs .tab').forEach((b) => b.addEventListener('click', () => { state.verdict = b.dataset.verdict; renderBoard(); }));
  document.querySelectorAll('#tierTabs .tab').forEach((b) => b.addEventListener('click', () => { state.tier = b.dataset.tier; renderBoard(); }));
}
function badgeHtml(row) {
  let h = '';
  if (row.badges.includes('Watchlist')) h += '<span class="badge watch">Watchlist</span>';
  if (row.badges.includes('Off-List')) h += '<span class="badge off">Off-List</span>';
  if (row.parent !== null) h += '<span class="badge parent">Parent &times;' + row.parent.toFixed(2) + '</span>';
  return h;
}
function rowHtml(row) {
  const sc = scenarioOf(row);
  const frac = Math.min(1, Math.max(0, (Math.log(row.implied) - Math.log(row.rangeLo)) / (Math.log(row.rangeHi) - Math.log(row.rangeLo))));
  const chg = row.change7d === null ? '<span class="dim">—</span>'
    : '<span class="' + (row.change7d >= 0 ? 'pos' : 'neg') + '">' + (row.change7d >= 0 ? '+' : '') + row.change7d.toFixed(1) + '%</span>';
  const vlabel = sc.verdict === 'farm' ? 'FARM' : sc.verdict === 'skip' ? 'SKIP' : 'MARGINAL';
  return '<tr data-slug="' + esc(row.slug) + '" class="' + (state.picked.has(row.slug) ? 'picked' : '') + '">' +
    '<td class="cbcol"><input type="checkbox" class="pick" data-slug="' + esc(row.slug) + '"' + (state.picked.has(row.slug) ? ' checked' : '') + ' aria-label="Pick ' + esc(row.name) + '"></td>' +
    '<td class="num">' + row.rank + '</td>' +
    '<td><div class="range-track"><div class="range-seg" style="left:6%;width:88%"></div><div class="range-dot" style="left:' + (6 + 88 * frac).toFixed(1) + '%"></div></div></td>' +
    '<td><span class="pname">' + esc(row.name) + '</span>' + badgeHtml(row) + '<div class="psub">' + esc(row.category) + ' &middot; ' + esc(row.chainLabel) + '</div></td>' +
    '<td class="num">' + moneyShort(row.tvl) + '</td>' +
    '<td class="num">' + chg + '</td>' +
    '<td class="num">' + ageText(row.ageDays) + '</td>' +
    '<td class="num">' + pct0(row.odds) + '<span class="oddsbar"><i style="width:' + Math.round(row.odds * 100) + '%"></i></span></td>' +
    '<td class="num">' + moneyShort(row.valueIf) + '</td>' +
    '<td class="num"><b>' + moneyShort(row.implied) + '</b></td>' +
    '<td class="num dim">' + moneyShort(row.rangeLo) + '–' + moneyShort(row.rangeHi) + '</td>' +
    '<td><span class="vchip ' + sc.verdict + '">' + vlabel + '</span><span class="vnet">' + money0(sc.ev) + '</span><div class="vsub">plan ' + money0(sc.plan) + ' &middot; fees ' + money2(row.fees) + '</div></td>' +
    '<td class="num">' + money2(sc.netHour) + '</td></tr>';
}
function renderTable() {
  const rows = sortedRows(visibleRows());
  $('#tbody').innerHTML = rows.map(rowHtml).join('');
  const tvl = rows.reduce((s, r) => s + r.tvl, 0);
  const imp = rows.reduce((s, r) => s + r.implied, 0);
  $('#shownLine').innerHTML = '<b>' + rows.length + '</b> of ' + R.totals.ranked + ' rows &middot; ' + moneyShort(tvl) + ' TVL &middot; ' + moneyShort(imp) + ' implied';
  document.querySelectorAll('#tbody tr').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.classList.contains('pick')) return;
    const row = R.rows.find((r) => r.slug === tr.dataset.slug);
    if (row) openDetail(row);
  }));
  document.querySelectorAll('#tbody .pick').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) state.picked.add(cb.dataset.slug); else state.picked.delete(cb.dataset.slug);
    cb.closest('tr').classList.toggle('picked', cb.checked);
  }));
  document.querySelectorAll('#board th.sortable').forEach((th) => {
    const on = th.dataset.sort === state.sortKey;
    th.innerHTML = th.textContent.replace(/\s*[▲▼]$/, '') + (on ? ' <span class="arr">' + (state.sortDir === 1 ? '▲' : '▼') + '</span>' : '');
  });
}
function renderBoard() { renderTabs(); renderTable(); }

/* ---------- detail view ---------- */
function openDetail(row) {
  const sc = scenarioOf(row);
  const vlabel = sc.verdict === 'farm' ? 'FARM' : sc.verdict === 'skip' ? 'SKIP' : 'MARGINAL';
  const stat = (l, v) => '<div class="dstat"><div class="dl">' + l + '</div><div class="dv">' + v + '</div></div>';
  $('#detail').innerHTML =
    '<button type="button" class="dclose" id="detailClose">Close</button>' +
    '<h2 id="detailName">' + esc(row.name) + badgeHtml(row) + '</h2>' +
    '<p class="dsub">Rank #' + row.rank + ' &middot; ' + esc(row.category) + ' &middot; ' + esc(row.chainLabel) + ' &middot; ' + esc(row.slug) + '</p>' +
    '<div class="dgrid">' +
    stat('TVL', moneyShort(row.tvl)) +
    stat('7-day change', row.change7d === null ? '—' : (row.change7d >= 0 ? '+' : '') + row.change7d.toFixed(1) + '%') +
    stat('No-token age', ageText(row.ageDays)) +
    stat('Token odds', pct0(row.odds)) +
    stat('If it launches', moneyShort(row.valueIf)) +
    stat('Implied value', moneyShort(row.implied)) +
    stat('P25–P75 range', moneyShort(row.rangeLo) + ' – ' + moneyShort(row.rangeHi)) +
    stat('Plan (scenario)', money0(sc.plan)) +
    stat('Fees, whole plan', money2(row.fees)) +
    stat('Net of fees', money0(sc.ev)) +
    stat('Net / hour', money2(sc.netHour)) +
    stat('Verdict', vlabel) +
    '</div>' +
    '<h3>Farm plan — ' + row.steps.length + ' steps</h3>' +
    '<ol>' + row.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
    '<p class="dnote">The plan is priced on the scenario set by the controls behind this view (plan size, drop share, horizon). The steps are the same ones handed in with the board; costs and times are stated inside each step.</p>';
  $('#overlay').hidden = false;
  $('#detailClose').addEventListener('click', closeDetail);
}
function closeDetail() { $('#overlay').hidden = true; }

/* ---------- export ---------- */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function exportCsv() {
  const head = 'slug,name,rank,tvl_usd,change_7d_pct,no_token_age,token_odds_pct,if_it_launches_usd,implied_value_usd,verdict,net_of_fees_usd,net_per_hour_usd';
  const lines = sortedRows(visibleRows()).map((r) => {
    const sc = scenarioOf(r);
    return [r.slug, '"' + r.name.replace(/"/g, '""') + '"', r.rank, r.tvl, r.change7d === null ? '' : r.change7d.toFixed(1),
      ageText(r.ageDays), Math.round(r.odds * 100), r.valueIf, r.implied, sc.verdict, sc.ev.toFixed(2), sc.netHour.toFixed(2)].join(',');
  });
  download('launch-radar-board.csv', head + '\n' + lines.join('\n'), 'text/csv');
}
function exportJson() {
  const rows = sortedRows(visibleRows()).map((r) => ({ slug: r.slug, name: r.name, rank: r.rank, implied_value_usd: r.implied, farm_steps: r.steps }));
  download('launch-radar-board.json', JSON.stringify(rows, null, 2), 'application/json');
}

/* ---------- wiring ---------- */
function fillSelects() {
  const cats = [...new Set(R.rows.map((r) => r.category))].sort();
  $('#catSel').innerHTML = '<option value="all">All categories</option>' + cats.map((c) => '<option>' + esc(c) + '</option>').join('');
  const chains = [...new Set(R.rows.map((r) => r.chain))].sort();
  $('#chainSel').innerHTML = '<option value="all">All chains</option>' + chains.map((c) => '<option>' + esc(c) + '</option>').join('');
}
function syncScenarioLabels() {
  $('#dropVal').textContent = (state.drop * 100).toFixed(1).replace(/\.0$/, '') + '%';
  $('#weeksVal').textContent = state.weeks + ' wk';
}
function init() {
  renderMeta(); renderKpis(); renderAccounting(); renderChips(); renderEvidence(); fillSelects(); syncScenarioLabels(); renderBoard();
  $('#search').addEventListener('input', (e) => { state.q = e.target.value; renderTable(); });
  $('#catSel').addEventListener('change', (e) => { state.cat = e.target.value; renderTable(); });
  $('#chainSel').addEventListener('change', (e) => { state.chain = e.target.value; renderTable(); });
  $('#planSel').addEventListener('change', (e) => { state.planPct = parseFloat(e.target.value); renderBoard(); });
  $('#dropRange').addEventListener('input', (e) => { state.drop = parseInt(e.target.value, 10) / 100; syncScenarioLabels(); renderBoard(); });
  $('#weeksRange').addEventListener('input', (e) => { state.weeks = parseInt(e.target.value, 10); syncScenarioLabels(); renderBoard(); });
  $('#resetBtn').addEventListener('click', () => {
    Object.assign(state, { verdict: 'all', tier: 'all', q: '', cat: 'all', chain: 'all', sortKey: 'rank', sortDir: 1, planPct: DEFAULTS.planPct, drop: DEFAULTS.drop, weeks: DEFAULTS.weeks });
    $('#search').value = ''; $('#catSel').value = 'all'; $('#chainSel').value = 'all';
    $('#planSel').value = String(DEFAULTS.planPct); $('#dropRange').value = '7'; $('#weeksRange').value = '12';
    syncScenarioLabels(); renderBoard();
  });
  $('#csvBtn').addEventListener('click', exportCsv);
  $('#jsonBtn').addEventListener('click', exportJson);
  $('#pickAll').addEventListener('change', (e) => {
    for (const r of visibleRows()) { if (e.target.checked) state.picked.add(r.slug); else state.picked.delete(r.slug); }
    renderTable();
  });
  document.querySelectorAll('#board th.sortable').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir = -state.sortDir; else { state.sortKey = k; state.sortDir = 1; }
    renderTable();
  }));
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
}
init();
