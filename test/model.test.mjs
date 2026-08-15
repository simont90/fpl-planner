/**
 * The expected-points model.
 *
 * These tests are mostly about arithmetic that is easy to get subtly wrong and
 * impossible to notice afterwards: a rate applied per match where it should be
 * per 90, a floor division replaced by a plain one, a threshold treated as an
 * average. Each of those is worth a few tenths of a point per player, which is
 * the same order as the gaps the optimiser makes decisions on, so none of them
 * would ever surface as an obviously wrong answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContext, projectPlayer, projectFixture, minutesModel, availability,
  POS, _internals,
} from '../js/model.js';
import { bootstrap, fixtures, ctx, projections, players, byName } from './fixtures.mjs';

const { poissonPmf, poissonAtLeast, expectedFloorDiv } = _internals;

test('poisson pmf sums to one', () => {
  for (const lambda of [0.2, 1.4, 6, 15]) {
    let s = 0;
    for (let k = 0; k <= 80; k++) s += poissonPmf(k, lambda);
    assert.ok(Math.abs(s - 1) < 1e-9, `lambda ${lambda} summed to ${s}`);
  }
});

test('poisson pmf stays finite where the naive factorial overflows', () => {
  // Defensive-contribution rates reach ~15 actions a match; 170! is Infinity in
  // double precision, so this has to be computed in log space.
  const p = poissonPmf(170, 15);
  assert.ok(Number.isFinite(p), 'pmf overflowed');
  assert.ok(p >= 0);
});

test('poissonAtLeast agrees with a direct sum of the tail', () => {
  for (const [k, lambda] of [[10, 8], [12, 12], [3, 1.5]]) {
    let tail = 0;
    for (let i = k; i <= 200; i++) tail += poissonPmf(i, lambda);
    assert.ok(Math.abs(poissonAtLeast(k, lambda) - tail) < 1e-9);
  }
});

test('expectedFloorDiv is the expectation of the floor, not the floor of the expectation', () => {
  // The distinction is the whole point: goals conceded are charged per
  // completed pair each match, so a side shipping one goal loses nothing.
  // Dividing the mean instead would charge them half a point.
  const lambda = 1.2;
  let direct = 0;
  for (let k = 0; k <= 60; k++) direct += Math.floor(k / 2) * poissonPmf(k, lambda);
  // The helper truncates its sum once the remaining mass is negligible, so the
  // tolerance is set to catch a wrong formula rather than a dropped tail.
  assert.ok(Math.abs(expectedFloorDiv(lambda, 2) - direct) < 1e-6);
  assert.ok(expectedFloorDiv(lambda, 2) < lambda / 2, 'floor division must be cheaper than halving the mean');
});

test('a keeper facing few shots is not paid as though save points were divisible', () => {
  // 1.6 saves a match is worth E[floor(s/3)] = 0.22 save points. Dividing the
  // mean instead claims 0.53 — a third of a point every match, applied to
  // every keeper, which was enough to rank them above defenders wrongly.
  const perMatch = expectedFloorDiv(1.6, 3);
  assert.ok(Math.abs(perMatch - 0.2227) < 0.01, `got ${perMatch}`);
  assert.ok(perMatch < (1.6 / 3) * 0.5, 'must be far below simply dividing the mean');
});

test('availability reads the explicit chance before the status flag', () => {
  assert.equal(availability({ status: 'd', chance_of_playing_next_round: 25 }), 0.25);
  assert.equal(availability({ status: 'a', chance_of_playing_next_round: null }), 1);
  assert.equal(availability({ status: 'i', chance_of_playing_next_round: null }), 0);
  assert.equal(availability({ status: 's', chance_of_playing_next_round: null }), 0);
});

test('minutes model is bounded and responds to availability', () => {
  const nailed = { starts: 36, minutes: 3200, status: 'a' };
  const full = minutesModel(nailed, 1);
  assert.ok(full.p60 > 0.8 && full.p60 <= 0.97);
  assert.ok(full.pAppear >= full.p60);
  assert.ok(full.expMinutes > 0 && full.expMinutes <= 90);

  const doubtful = minutesModel(nailed, 0.5);
  assert.ok(Math.abs(doubtful.p60 - full.p60 * 0.5) < 1e-9, 'availability scales p60 linearly');
});

test('fixture difficulty moves attack and defence in opposite directions', () => {
  const haaland = byName('Haaland');
  const easy = projectFixture(haaland, { fdr: 1, home: true }, ctx);
  const hard = projectFixture(haaland, { fdr: 5, home: true }, ctx);
  assert.ok(easy.parts.goals > hard.parts.goals, 'attack should fall against harder sides');

  const keeper = players.find((p) => POS[p.element_type] === 'GKP' && p.minutes > 2000);
  const easyK = projectFixture(keeper, { fdr: 1, home: true }, ctx);
  const hardK = projectFixture(keeper, { fdr: 5, home: true }, ctx);
  assert.ok(easyK.parts.cleanSheet > hardK.parts.cleanSheet, 'clean sheets should be rarer against harder sides');
  assert.ok(hardK.parts.saves > easyK.parts.saves, 'a keeper under pressure makes more saves');
});

test('the parts of a projection add up to its total', () => {
  for (const p of players.slice(0, 60)) {
    const proj = projectFixture(p, { fdr: 3, home: true }, ctx);
    const sum = Object.values(proj.parts).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(Math.max(0, sum) - proj.total) < 1e-9, `${p.web_name} breakdown does not reconcile`);
  }
});

test('defensive contribution is a threshold, and keepers are not eligible', () => {
  const s = bootstrap.game_config.scoring;
  assert.equal(s.defensive_contribution.GKP, 0);
  const keeper = players.find((p) => POS[p.element_type] === 'GKP' && p.minutes > 2000);
  assert.equal(projectFixture(keeper, { fdr: 3, home: true }, ctx).parts.defcon, 0);

  // A defender well short of ten actions a match should draw far less than one
  // who clears it comfortably — a rate, applied linearly, would not do this.
  const defs = players
    .filter((p) => POS[p.element_type] === 'DEF' && p.minutes > 1800)
    .map((p) => ({ p, rate: (p.defensive_contribution / p.minutes) * 90 }));
  const low = defs.sort((a, b) => a.rate - b.rate)[0];
  const high = defs[defs.length - 1];
  const lowPts = projectFixture(low.p, { fdr: 3, home: true }, ctx).parts.defcon;
  const highPts = projectFixture(high.p, { fdr: 3, home: true }, ctx).parts.defcon;
  assert.ok(highPts > lowPts * 2, `threshold behaviour missing: ${lowPts} vs ${highPts}`);
});

test('players with no record fall back to a price-implied baseline, and say so', () => {
  const fresh = players.find((p) => p.minutes === 0 && p.now_cost >= 50);
  assert.ok(fresh, 'expected at least one player with no minutes');
  const proj = projections.get(fresh.id);
  assert.equal(proj.provisional, true, 'must be flagged as an estimate rather than a measurement');
  assert.ok(proj.epTotal > 0, 'a promoted-club starter must not silently project zero');
});

test('a promoted club is not deleted from consideration', () => {
  // 187 of 587 players have no Premier League minutes. Scoring them from their
  // stats gives zero, which would quietly remove three whole squads.
  const noMinutes = players.filter((p) => p.minutes === 0);
  assert.ok(noMinutes.length > 100, `expected many, got ${noMinutes.length}`);
  const projected = noMinutes.filter((p) => (projections.get(p.id)?.epTotal ?? 0) > 0);
  assert.ok(
    projected.length > noMinutes.length * 0.5,
    `only ${projected.length} of ${noMinutes.length} new players project above zero`
  );
});

test('unavailable players project to nothing', () => {
  const injured = players.find((p) => p.status === 'i');
  if (injured) assert.equal(projections.get(injured.id).epNext, 0);
});

test('projections decay across the horizon rather than treating week six like week one', () => {
  const p = byName('Haaland');
  const short = projectPlayer(p, ctx, { horizon: 1 });
  const long = projectPlayer(p, ctx, { horizon: 6 });
  assert.ok(long.epTotal > short.epTotal);
  assert.ok(long.epTotal < short.epNext * 6, 'later gameweeks must be discounted');
});

test('blanks and doubles are counted per gameweek', () => {
  const p = byName('Haaland');
  const proj = projectPlayer(p, ctx, { horizon: 6 });
  assert.equal(proj.gws.length, 6);
  for (const g of proj.gws) {
    assert.equal(g.blank, g.fixtures.length === 0);
    assert.equal(g.double, g.fixtures.length > 1);
    if (g.blank) assert.equal(g.ep, 0, 'a blank gameweek must score nothing');
  }
});

test('the clean-sheet dispersion still matches the season it was fitted to', () => {
  // Guards the constant against drift. If a rules change or a new snapshot
  // moves the true value, this fails loudly rather than quietly mispricing
  // every defender and keeper in the game.
  const def = bootstrap.elements.filter(
    (p) => p.minutes >= 1500 && (p.element_type === 1 || p.element_type === 2)
  );
  let actual = 0;
  for (const p of def) actual += p.clean_sheets / (p.minutes / 90);
  actual /= def.length;

  let best = null;
  for (let d = 0.5; d <= 1.5; d += 0.005) {
    let s = 0;
    for (const p of def) s += Math.exp(-(parseFloat(p.expected_goals_conceded_per_90) || 1.35) * d);
    const diff = Math.abs(s / def.length - actual);
    if (!best || diff < best.diff) best = { d, diff };
  }
  assert.ok(
    Math.abs(best.d - _internals.CS_DISPERSION) < 0.05,
    `CS_DISPERSION is ${_internals.CS_DISPERSION} but the data fits ${best.d.toFixed(3)}`
  );
});

test('the model is unbiased against the players it can fairly be judged on', () => {
  // Only ever-present starters can be compared per 90: a substitute banks his
  // appearance point over a fraction of a match, which inflates his actual
  // points-per-90 for reasons that have nothing to do with the model. See the
  // long note in calibrate.mjs.
  const FULL = { p60: 1, pAppear: 1, expMinutes: 90 };
  const errs = [];
  for (const p of bootstrap.elements) {
    if (p.starts < 25 || p.minutes / p.starts < 87) continue;
    const rates = _internals.ratesFor(p, ctx);
    if (rates.provisional) continue;
    const h = projectFixture(p, { fdr: 3, home: true }, ctx, { rates, mins: FULL }).total;
    const a = projectFixture(p, { fdr: 3, home: false }, ctx, { rates, mins: FULL }).total;
    errs.push((h + a) / 2 - (p.total_points / p.minutes) * 90);
  }
  assert.ok(errs.length > 50, `only ${errs.length} comparable players`);
  const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
  const mae = errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length;
  assert.ok(Math.abs(bias) < 0.15, `bias drifted to ${bias.toFixed(3)} points per 90`);
  assert.ok(mae < 0.35, `mean absolute error drifted to ${mae.toFixed(3)}`);
});

test('scoring values are read from the payload, not hardcoded', () => {
  // A mid-season rules change should follow automatically. Doubling a scoring
  // value in the config must move the projection.
  const patched = structuredClone(bootstrap);
  patched.game_config.scoring.goals_scored.FWD *= 2;
  const patchedCtx = buildContext(patched, fixtures);
  const striker = byName('Haaland');
  const before = projectFixture(striker, { fdr: 3, home: true }, ctx).parts.goals;
  const after = projectFixture(striker, { fdr: 3, home: true }, patchedCtx).parts.goals;
  assert.ok(Math.abs(after - before * 2) < 1e-9, 'goal points did not follow the config');
});
