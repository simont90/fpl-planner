/**
 * Transfers, chips and the market.
 *
 * The arithmetic these modules do is the arithmetic a manager gets wrong: what
 * a player actually sells for, whether a four-point hit pays for itself, what
 * a chip is worth against not playing it. Each has an obvious wrong answer
 * that looks right — sell at market price, compare a hit against zero, count
 * Triple Captain as three lots of the captain rather than one more — so these
 * pin down the correct one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { POS } from '../js/model.js';
import { bestXI } from '../js/optimiser.js';
import {
  planTransfers, pickTeam, sellingPrice, squadValue, HIT_COST, MAX_FREE_TRANSFERS,
} from '../js/transfers.js';
import {
  planChips, gameweekShape, benchBoostValue, tripleCaptainValue, wildcardValue, epAtGw,
} from '../js/chips.js';
import {
  predictPriceChanges, effectiveOwnership, fieldExpectation, versusField, templateSquad,
} from '../js/market.js';
import { bootstrap, ctx, projections, players, pool, optimal } from './fixtures.mjs';

/* ---------------------------- transfers ---------------------------- */

test('you keep only half of a price rise, rounded down', () => {
  assert.equal(sellingPrice(70, 75), 72, 'a 0.5 rise returns 0.2 of profit');
  assert.equal(sellingPrice(70, 74), 72);
  assert.equal(sellingPrice(70, 71), 70, 'a single 0.1 rise is not yet worth anything');
  assert.equal(sellingPrice(70, 70), 70);
  assert.equal(sellingPrice(70, 65), 65, 'a fall is taken in full');
  assert.equal(sellingPrice(120, 131), 125);
});

test('squad value uses selling prices, not market prices', () => {
  const squad = optimal().squad;
  const paid = new Map(squad.map((p) => [p.id, p.now_cost - 5])); // each rose 0.5
  const market = squad.reduce((a, p) => a + p.now_cost, 0);
  const sale = squadValue(squad, paid, 0);
  assert.ok(sale < market, 'selling at market price would overstate the budget');
  assert.equal(sale, squad.reduce((a, p) => a + sellingPrice(p.now_cost - 5, p.now_cost), 0));
});

test('doing nothing is always an option, and banking a transfer is worth something', () => {
  const plan = planTransfers(optimal().squad, projections, pool, { bank: 0, freeTransfers: 1 });
  const roll = plan.options.find((o) => o.transfers === 0);
  assert.ok(roll, 'no roll option offered');
  assert.ok(roll.net > 0, 'a bankable free transfer should be worth more than nothing');

  const maxed = planTransfers(optimal().squad, projections, pool, {
    bank: 0, freeTransfers: MAX_FREE_TRANSFERS,
  });
  assert.equal(maxed.options.find((o) => o.transfers === 0).net, 0,
    'rolling at the cap banks nothing and must not be credited');
});

test('hits are charged only beyond the free allowance', () => {
  const squad = optimal().squad;
  for (const ft of [1, 2, 3]) {
    const plan = planTransfers(squad, projections, pool, { bank: 20, freeTransfers: ft });
    for (const o of plan.options) {
      assert.equal(o.hit, Math.max(0, o.transfers - ft) * HIT_COST, `${o.transfers} transfers on ${ft} free`);
      assert.ok(Math.abs(o.net - (o.gain - o.hit)) < 1e-9 || o.transfers === 0);
    }
  }
});

test('the recommendation is the option with the best net, not the best gain', () => {
  const plan = planTransfers(optimal().squad, projections, pool, { bank: 20, freeTransfers: 1 });
  for (const o of plan.options) assert.ok(plan.recommendation.net >= o.net - 1e-9);

  const deepest = plan.options[plan.options.length - 1];
  const best = plan.recommendation;
  if (deepest.transfers > best.transfers) {
    assert.ok(deepest.gain >= best.gain - 1e-9, 'more transfers should not gain less before costs');
  }
});

test('a squad with an obvious hole gets it filled', () => {
  // Replace a starter with the worst available player of his position; the
  // planner should propose putting him back.
  const squad = [...optimal().squad];
  const ep = (p) => projections.get(p.id)?.epTotal ?? 0;
  const i = squad.findIndex((p) => POS[p.element_type] === 'MID');
  const original = squad[i];
  const dud = pool
    .filter((p) => POS[p.element_type] === 'MID' && !squad.some((s) => s.id === p.id)
      && p.now_cost <= original.now_cost)
    .sort((a, b) => ep(a) - ep(b))[0];
  squad[i] = dud;

  const bank = 1000 - squad.reduce((a, p) => a + p.now_cost, 0);
  const plan = planTransfers(squad, projections, pool, { bank, freeTransfers: 1 });
  assert.ok(plan.recommendation.transfers >= 1, 'planner declined an obvious upgrade');
  assert.ok(plan.recommendation.out.some((p) => p.id === dud.id), 'planner did not sell the weak link');
  assert.ok(plan.recommendation.gain > 0);
});

test('proposed transfers keep the squad legal and affordable', () => {
  const squad = [...optimal().squad];
  const bank = 30;
  const plan = planTransfers(squad, projections, pool, { bank, freeTransfers: 2 });
  for (const o of plan.options) {
    if (!o.transfers) continue;
    assert.equal(o.squad.length, 15);
    assert.equal(new Set(o.squad.map((p) => p.id)).size, 15);

    const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
    const clubs = new Map();
    for (const p of o.squad) {
      counts[POS[p.element_type]]++;
      clubs.set(p.team, (clubs.get(p.team) || 0) + 1);
    }
    assert.deepEqual(counts, { GKP: 2, DEF: 5, MID: 5, FWD: 3 }, 'position counts broken');
    for (const [, n] of clubs) assert.ok(n <= 3, 'club cap breached by a transfer');
    assert.ok(o.bankAfter >= 0, `transfer leaves ${o.bankAfter} in the bank`);

    // Transfers must be like-for-like by position.
    for (let k = 0; k < o.out.length; k++) {
      assert.equal(POS[o.out[k].element_type], POS[o.in[k].element_type]);
    }
  }
});

test('marginal value answers whether the next transfer is worth its hit', () => {
  const plan = planTransfers(optimal().squad, projections, pool, { bank: 20, freeTransfers: 1 });
  for (let i = 1; i < plan.options.length; i++) {
    assert.ok(Math.abs(plan.options[i].marginal - (plan.options[i].net - plan.options[i - 1].net)) < 1e-9);
  }
});

test('pickTeam names a captain and prices the armband decision', () => {
  const t = pickTeam(optimal().squad, projections);
  assert.ok(t.captain && t.vice);
  assert.notEqual(t.captain.id, t.vice.id);
  assert.ok(t.captaincyEdge >= 0, 'the vice cannot outscore the captain');
  assert.equal(t.xi.length, 11);
});

/* ------------------------------ chips ------------------------------ */

test('the gameweek calendar is read, not assumed', () => {
  const shape = gameweekShape(ctx, ctx.nextGw, 6);
  assert.equal(shape.length, 6);
  for (const s of shape) {
    assert.equal(s.blanks.length + s.doubles.length === 0, s.normal);
    assert.ok(s.fixtures >= 0 && s.fixtures <= 20);
  }
});

test('Bench Boost is worth exactly the bench', () => {
  const squad = optimal().squad;
  const gw = ctx.nextGw;
  const ep = (p) => epAtGw(projections.get(p.id), gw);
  const xi = bestXI(squad, ep);
  const expected = [...xi.bench, xi.benchKeeper].filter(Boolean).reduce((a, p) => a + ep(p), 0);
  assert.ok(Math.abs(benchBoostValue(squad, projections, gw).value - expected) < 1e-9);
});

test('Triple Captain adds one more captain, not two', () => {
  const squad = optimal().squad;
  const gw = ctx.nextGw;
  const ep = (p) => epAtGw(projections.get(p.id), gw);
  const xi = bestXI(squad, ep);
  const tc = tripleCaptainValue(squad, projections, gw);
  assert.ok(Math.abs(tc.value - ep(xi.captain)) < 1e-9,
    'the captain is already doubled, so the chip is worth exactly one more of him');
  assert.equal(tc.captain.id, xi.captain.id);
});

test('a Wildcard on an already-optimal squad gains nothing', () => {
  // The sharpest consistency check available: rebuilding an optimal squad with
  // the same budget and the same projections must not find anything better. A
  // positive number here would mean the optimiser disagrees with itself.
  const r = optimal();
  const wc = wildcardValue(r.squad, projections, players, {
    pool, bank: 1000 - r.cost, restarts: 12, polish: 4,
  });
  assert.ok(wc, 'wildcard evaluation failed');
  assert.ok(wc.gain < 0.5, `rebuild claimed ${wc.gain.toFixed(2)} points over an optimal squad`);
});

test('chip planning reports what it can and cannot see', () => {
  const plan = planChips(optimal().squad, projections, players, ctx, { pool, horizon: 4 });
  assert.ok(plan.benchBoost.length && plan.tripleCaptain.length);
  assert.ok(Array.isArray(plan.advice) && plan.advice.length);
  // Sorted best-first so the caller can take the head.
  for (let i = 1; i < plan.benchBoost.length; i++) {
    assert.ok(plan.benchBoost[i - 1].value >= plan.benchBoost[i].value);
  }
  if (plan.shape.every((s) => s.normal)) {
    assert.ok(
      plan.advice.some((a) => /blank and double/i.test(a)),
      'a horizon with no blanks or doubles should say so rather than imply a timing edge'
    );
  }
});

/* ----------------------------- market ------------------------------ */

test('the price model refuses to predict from an empty market', () => {
  const p = predictPriceChanges(players, bootstrap.total_players);
  const anyTransfers = players.some(
    (x) => (x.transfers_in_event || 0) + (x.transfers_out_event || 0) > 0
  );
  if (!anyTransfers) {
    assert.equal(p.dormant, true, 'predicted price moves with no transfer data to read');
    assert.equal(p.rises.length, 0);
    assert.equal(p.falls.length, 0);
    assert.ok(p.reason);
  } else {
    assert.equal(p.dormant, false);
  }
});

test('captaincy shares account for exactly one armband per manager', () => {
  const eo = effectiveOwnership(players, projections);
  const total = [...eo.values()].reduce((a, v) => a + v.captaincy, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `captaincy sums to ${total.toFixed(2)}%`);
});

test('effective ownership counts the armband on top of selection', () => {
  const eo = effectiveOwnership(players, projections);
  for (const [id, v] of eo) {
    assert.ok(v.eo >= 0);
    assert.ok(Math.abs(v.eo - (v.ownership * v.startRate + v.captaincy)) < 1e-9);
    assert.ok(v.startRate >= 0 && v.startRate <= 1);
    assert.equal(v.modelled, true, 'inferred figures must be flagged as inferred');
  }
  // The most-owned premium should clear 100% EO — that is the whole point of
  // the measure, and a model that cannot produce it is not measuring EO.
  const top = [...eo.values()].sort((a, b) => b.eo - a.eo)[0];
  assert.ok(top.eo > 100, `highest EO is only ${top.eo.toFixed(1)}%`);
});

test('the field expectation is a plausible gameweek score', () => {
  const eo = effectiveOwnership(players, projections);
  const field = fieldExpectation(players, projections, eo);
  assert.ok(field > 25 && field < 90, `average manager projected at ${field.toFixed(1)} points`);
});

test('a squad is measured against the field, not in isolation', () => {
  const eo = effectiveOwnership(players, projections);
  const vf = versusField(optimal().squad, players, projections, eo);
  assert.ok(Math.abs(vf.margin - (vf.you - vf.field)) < 1e-9);
  assert.ok(vf.differentials.every((d) => d.edge > 0));
  assert.ok(vf.risks.every((d) => d.edge < 0));
  // Every risk is a player the squad does not own.
  const owned = new Set(optimal().squad.map((p) => p.id));
  for (const r of vf.risks) assert.ok(!owned.has(r.id), `${r.name} is owned but listed as a risk`);
});

test('the template is reported as a reference, not as a squad you could buy', () => {
  const t = templateSquad(players, projections);
  assert.equal(t.squad.length, 15);
  assert.equal(typeof t.buildable, 'boolean');
  if (t.cost > 1000) {
    assert.equal(t.buildable, false, 'an unaffordable template must not be presented as buildable');
  }
});
