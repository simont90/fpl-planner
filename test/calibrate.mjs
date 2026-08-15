/**
 * Calibration harness — not a pass/fail test, a look at the model's arithmetic.
 *
 * The model derives its rates from last season's per-90 numbers, so running it
 * back over last season is a consistency check rather than a forecast: it asks
 * whether the component accounting (appearance + goals + assists + clean sheet
 * + defcon + saves + bonus + cards) actually reproduces the points FPL awarded.
 * A component that is double counted, dropped, or scaled wrong shows up here as
 * a systematic bias.
 *
 * Usage: node test/calibrate.mjs   (needs test/fixtures/bootstrap.json)
 */

import { readFileSync } from 'node:fs';
import { buildContext, projectFixture, POS, minutesModel, _internals } from '../js/model.js';

const boot = JSON.parse(readFileSync(new URL('./fixtures/bootstrap.json', import.meta.url)));
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/fixtures.json', import.meta.url)));
const ctx = buildContext(boot, fixtures);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const f2 = (x) => x.toFixed(2);

/* -- 1. Points per 90: modelled vs actual ------------------------------- */

// Neutral fixture and full minutes, so this isolates the scoring arithmetic
// from the minutes and difficulty models.
const NEUTRAL = { fdr: 3, home: true, opponent: null };
const FULL = { p60: 1, pAppear: 1, expMinutes: 90 };

/**
 * Only players who play close to full matches can be compared per 90.
 *
 * Appearance points are paid per appearance, not per minute: a substitute who
 * plays 25 minutes banks his point over less than a third of a 90, so his
 * actual points-per-90 carries 3-4 appearance points where a modelled full
 * match carries 2. That inflation is a property of the denominator, not of
 * the player, and it falls hardest on rotated midfielders and forwards —
 * which is precisely where an earlier version of this harness reported a
 * large "under-projection" that did not exist. Keepers and centre-backs play
 * 90s, so they looked unbiased and the artifact read as a positional flaw in
 * the model.
 *
 * Filtering on minutes-per-start alone does not remove it. A player who starts
 * 20 matches at a full 90 and adds 10 bench cameos still averages well over 80
 * minutes per start, because his cameo minutes land in the numerator too — the
 * filter cannot see the extra appearances at all, only their minutes. Those
 * unseen appearance points were the whole of the residual bias this harness
 * used to report: sweeping the subset from every player to genuine
 * ever-presents moves it from -0.37 to -0.04 points per 90, and midfielders
 * from -0.47 to 0.00. The model was never the problem.
 *
 * So the comparison set is players who both start most weeks and are rarely
 * withdrawn. A manager does not bring an ever-present starter off the bench,
 * so for these players appearances and starts are the same number and actual
 * points-per-90 is finally an honest denominator.
 */
const MIN_STARTS = 25;
const FULL_MATCH_MINUTES = 87;

const rows = [];
const rotated = [];
for (const p of boot.elements) {
  if (p.minutes < 900 || !p.starts) continue;
  const actual = (p.total_points / p.minutes) * 90;
  const rates = _internals.ratesFor(p, ctx);
  if (rates.provisional) continue;
  if (p.starts < MIN_STARTS || p.minutes / p.starts < FULL_MATCH_MINUTES) {
    rotated.push({ p, actual });
    continue;
  }
  // Home/away venue lean cancels over a season; evaluate at the midpoint.
  const h = projectFixture(p, { ...NEUTRAL, home: true }, ctx, { rates, mins: FULL }).total;
  const a = projectFixture(p, { ...NEUTRAL, home: false }, ctx, { rates, mins: FULL }).total;
  rows.push({ p, actual, model: (h + a) / 2 });
}

const errs = rows.map((r) => r.model - r.actual);
const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
const mae = errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length;
const rmse = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / errs.length);

const mx = rows.reduce((a, r) => a + r.model, 0) / rows.length;
const my = rows.reduce((a, r) => a + r.actual, 0) / rows.length;
let cov = 0;
let vx = 0;
let vy = 0;
for (const r of rows) {
  cov += (r.model - mx) * (r.actual - my);
  vx += (r.model - mx) ** 2;
  vy += (r.actual - my) ** 2;
}
const corr = cov / Math.sqrt(vx * vy);

console.log(
  `\nPOINTS PER 90 — modelled vs actual  (n=${rows.length}, ever-presents: ${MIN_STARTS}+ starts ` +
  `at ${FULL_MATCH_MINUTES}+ min per start; ${rotated.length} rotated players excluded — see note)`
);
console.log(`  mean actual ${f2(my)}   mean modelled ${f2(mx)}`);
console.log(`  bias ${f2(bias)}   MAE ${f2(mae)}   RMSE ${f2(rmse)}   correlation ${f2(corr)}`);

console.log('\n  by position:');
for (const code of ['GKP', 'DEF', 'MID', 'FWD']) {
  const sub = rows.filter((r) => POS[r.p.element_type] === code);
  if (!sub.length) continue;
  const b = sub.reduce((a, r) => a + (r.model - r.actual), 0) / sub.length;
  const m = sub.reduce((a, r) => a + Math.abs(r.model - r.actual), 0) / sub.length;
  const am = sub.reduce((a, r) => a + r.actual, 0) / sub.length;
  console.log(`    ${code}  n=${String(sub.length).padStart(3)}  actual ${f2(am)}  bias ${f2(b).padStart(6)}  MAE ${f2(m)}`);
}

console.log('\n  largest over-projections:');
[...rows].sort((a, b) => b.model - b.actual - (a.model - a.actual)).slice(0, 5)
  .forEach((r) => console.log(`    ${r.p.web_name.padEnd(15)} ${POS[r.p.element_type]}  actual ${f2(r.actual)}  model ${f2(r.model)}`));
console.log('  largest under-projections:');
[...rows].sort((a, b) => a.model - a.actual - (b.model - b.actual)).slice(0, 5)
  .forEach((r) => console.log(`    ${r.p.web_name.padEnd(15)} ${POS[r.p.element_type]}  actual ${f2(r.actual)}  model ${f2(r.model)}`));

/* -- 2. Clean sheet probability ----------------------------------------- */

console.log('\nCLEAN SHEETS — Poisson on expected goals conceded vs actual rate');
const def = boot.elements.filter((p) => p.minutes >= 1500 && (p.element_type === 1 || p.element_type === 2));
let predCS = 0;
let actCS = 0;
for (const p of def) {
  const xgc = parseFloat(p.expected_goals_conceded_per_90) || 1.35;
  predCS += Math.exp(-xgc * _internals.CS_DISPERSION);
  actCS += p.clean_sheets / (p.minutes / 90);
}
console.log(`  n=${def.length}  predicted ${pct(predCS / def.length)}  actual ${pct(actCS / def.length)}`);
console.log(`  current CS_DISPERSION ${_internals.CS_DISPERSION}`);
// Solve for the dispersion that reproduces the observed rate.
let best = null;
for (let d = 0.5; d <= 1.5; d += 0.005) {
  let s = 0;
  for (const p of def) s += Math.exp(-(parseFloat(p.expected_goals_conceded_per_90) || 1.35) * d);
  const diff = Math.abs(s / def.length - actCS / def.length);
  if (!best || diff < best.diff) best = { d, diff };
}
console.log(`  best-fit CS_DISPERSION ${best.d.toFixed(3)}`);

/* -- 3. Defensive contribution ------------------------------------------ */

console.log('\nDEFENSIVE CONTRIBUTION — Poisson threshold hit rate');
for (const [code, type, thresh] of [['DEF', 2, 10], ['MID', 3, 12], ['FWD', 4, 12]]) {
  const sub = boot.elements.filter((p) => p.element_type === type && p.minutes >= 1500);
  if (!sub.length) continue;
  const rates = sub.map((p) => (p.defensive_contribution / p.minutes) * 90);
  const hit = rates.map((r) => _internals.poissonAtLeast(thresh, r));
  console.log(
    `  ${code}  n=${String(sub.length).padStart(3)}  median actions/90 ${f2(median(rates))}` +
    `  mean P(hit) ${pct(hit.reduce((a, b) => a + b, 0) / hit.length)}` +
    `  top ${pct(Math.max(...hit))}`
  );
}

/* -- 4. Minutes model ---------------------------------------------------- */

console.log('\nMINUTES — modelled P(60+) vs starts share');
const mrows = boot.elements.filter((p) => p.minutes > 0 && p.status === 'a');
let mBias = 0;
for (const p of mrows) {
  const m = minutesModel(p, 1);
  mBias += m.p60 - p.starts / 38;
}
console.log(`  n=${mrows.length}  mean (modelled P60 − starts/38) ${f2(mBias / mrows.length)}`);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
