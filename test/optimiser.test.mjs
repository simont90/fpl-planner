/**
 * Squad selection.
 *
 * Two very different things are being checked here. Legality is absolute: a
 * squad that breaks a rule is not a slightly worse answer, it is one FPL will
 * refuse to accept, so those tests assert exactly. Optimality cannot be
 * asserted the same way — the search is a search — so it is checked the two
 * ways that are actually available: the eleven is verified against exhaustive
 * enumeration, and the fifteen is verified by independent restarts agreeing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { POS } from '../js/model.js';
import {
  optimiseSquad, bestXI, squadScore, violation, candidatePool,
  FORMATIONS, SQUAD, BUDGET, MAX_PER_CLUB,
} from '../js/optimiser.js';
import { projections, players, pool, optimal } from './fixtures.mjs';

test('the eight legal formations are exactly the ones FPL allows', () => {
  assert.equal(FORMATIONS.length, 8);
  for (const f of FORMATIONS) {
    assert.equal(1 + f.DEF + f.MID + f.FWD, 11);
    assert.ok(f.DEF >= 3 && f.DEF <= 5);
    assert.ok(f.MID >= 2 && f.MID <= 5);
    assert.ok(f.FWD >= 1 && f.FWD <= 3);
  }
  const names = new Set(FORMATIONS.map((f) => f.name));
  assert.equal(names.size, 8, 'formations must be distinct');
});

test('an optimised squad is one FPL would accept', () => {
  const r = optimal();
  assert.equal(r.violation, null, `illegal squad: ${r.violation}`);
  assert.equal(r.squad.length, 15);

  const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = new Map();
  for (const p of r.squad) {
    counts[POS[p.element_type]]++;
    clubs.set(p.team, (clubs.get(p.team) || 0) + 1);
  }
  assert.deepEqual(counts, SQUAD);
  for (const [, n] of clubs) assert.ok(n <= MAX_PER_CLUB, 'club cap breached');
  assert.ok(r.cost <= BUDGET, `spent ${r.cost} of ${BUDGET}`);
  assert.equal(new Set(r.squad.map((p) => p.id)).size, 15, 'a player was picked twice');
});

test('violation names the specific rule that was broken', () => {
  const r = optimal();
  assert.match(violation(r.squad.slice(0, 14)), /14 players/);

  // Four from one club.
  const bigClub = [...r.squad].sort((a, b) => a.team - b.team)[0].team;
  const four = players.filter((p) => p.team === bigClub).slice(0, 4);
  if (four.length === 4) {
    const bad = [...four, ...r.squad.filter((p) => !four.some((f) => f.id === p.id))].slice(0, 15);
    const v = violation(bad);
    assert.ok(v, 'expected some violation');
  }

  assert.match(violation(r.squad, { budget: 500 }), /budget/);
});

test('bestXI matches exhaustive enumeration of every legal eleven', () => {
  // 1365 ways to pick eleven from fifteen. Small enough to check all of them,
  // which is the only way to know the formation enumeration is not missing one.
  const squad = optimal().squad;
  const ep = (p) => projections.get(p.id)?.epNext ?? 0;

  let bruteBest = -Infinity;
  const n = squad.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    let bits = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) bits++;
    if (bits !== 11) continue;

    const xi = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) xi.push(squad[i]);
    const c = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of xi) c[POS[p.element_type]]++;
    if (c.GKP !== 1 || c.DEF < 3 || c.DEF > 5 || c.MID < 2 || c.MID > 5 || c.FWD < 1 || c.FWD > 3) continue;

    const total = xi.reduce((a, p) => a + ep(p), 0);
    if (total > bruteBest) bruteBest = total;
  }

  const got = bestXI(squad, ep);
  assert.ok(Math.abs(got.xiPoints - bruteBest) < 1e-9, `bestXI got ${got.xiPoints}, exhaustive best is ${bruteBest}`);
});

test('the eleven, bench and reserve keeper together account for the whole squad', () => {
  const squad = optimal().squad;
  const ep = (p) => projections.get(p.id)?.epNext ?? 0;
  const xi = bestXI(squad, ep);
  const all = [...xi.xi, ...xi.bench, ...(xi.benchKeeper ? [xi.benchKeeper] : [])];
  assert.equal(all.length, 15);
  assert.equal(new Set(all.map((p) => p.id)).size, 15, 'a player appears in two places');
  assert.equal(xi.xi.filter((p) => POS[p.element_type] === 'GKP').length, 1);
});

test('the captain is the highest projected starter, and is counted twice', () => {
  const squad = optimal().squad;
  const ep = (p) => projections.get(p.id)?.epNext ?? 0;
  const xi = bestXI(squad, ep);
  for (const p of xi.xi) assert.ok(ep(xi.captain) >= ep(p) - 1e-9, 'a starter outscores the captain');
  assert.ok(ep(xi.captain) >= ep(xi.vice) - 1e-9, 'the vice outscores the captain');
  assert.ok(Math.abs(xi.total - (xi.xiPoints + ep(xi.captain))) < 1e-9, 'the armband is not doubled');
});

test('the bench is ranked, because autosubs come on in order', () => {
  const squad = optimal().squad;
  const ep = (p) => projections.get(p.id)?.epNext ?? 0;
  const xi = bestXI(squad, ep);
  for (let i = 1; i < xi.bench.length; i++) {
    assert.ok(ep(xi.bench[i - 1]) >= ep(xi.bench[i]) - 1e-9, 'bench is out of order');
  }
});

test('the same question gets the same answer', () => {
  const a = optimiseSquad(players, projections, { restarts: 8, pool, seed: 4242 });
  const b = optimiseSquad(players, projections, { restarts: 8, pool, seed: 4242 });
  assert.deepEqual(a.squad.map((p) => p.id).sort(), b.squad.map((p) => p.id).sort());
  assert.equal(a.score, b.score);
});

test('independent restarts agree on the optimum', () => {
  // The strongest evidence available that the search is finding the best squad
  // rather than a good one. Seeds that share no starting point should not land
  // on the same score by accident.
  const scores = [];
  for (const seed of [11, 2027, 55501, 909090]) {
    scores.push(optimiseSquad(players, projections, { restarts: 12, pool, seed }).score);
  }
  const spread = Math.max(...scores) - Math.min(...scores);
  assert.ok(spread < 0.01, `restarts disagreed by ${spread.toFixed(3)}: ${scores.map((s) => s.toFixed(2))}`);
});

test('paired swaps are what make the search work', () => {
  // Documents why the expensive move exists. With a spent budget, every
  // upgrade needs a matching downgrade, and a search that only ever changes
  // one player at a time stops several points short. If this ever stops being
  // true the paired pass can go.
  const withPairs = optimiseSquad(players, projections, { restarts: 12, pool, seed: 777, pairs: true });
  const withoutPairs = optimiseSquad(players, projections, { restarts: 12, pool, seed: 777, pairs: false });
  assert.ok(
    withPairs.score > withoutPairs.score,
    `pairs ${withPairs.score.toFixed(2)} did not beat singles ${withoutPairs.score.toFixed(2)}`
  );
});

test('a locked player is kept and a banned one is never bought', () => {
  const cheapKeeper = players
    .filter((p) => POS[p.element_type] === 'GKP' && (projections.get(p.id)?.epTotal ?? 0) > 0)
    .sort((a, b) => a.now_cost - b.now_cost)[0];
  const star = optimal().squad.find((p) => POS[p.element_type] === 'MID');

  const r = optimiseSquad(players, projections, {
    restarts: 8, pool, seed: 5, lock: [cheapKeeper.id], ban: [star.id],
  });
  assert.ok(r.squad.some((p) => p.id === cheapKeeper.id), 'locked player was dropped');
  assert.ok(!r.squad.some((p) => p.id === star.id), 'banned player was bought');
  assert.equal(r.violation, null);
});

test('a tighter budget produces a cheaper but still legal squad', () => {
  const poor = optimiseSquad(players, projections, { restarts: 10, pool, seed: 3, budget: 880 });
  assert.equal(poor.violation, null);
  assert.ok(poor.cost <= 880, `spent ${poor.cost}`);
  assert.ok(poor.score < optimal().score, 'less money should not buy more points');
});

test('the pool keeps the cheap enablers a budget squad is built from', () => {
  // A pool taken purely on projection contains no £4.0m defenders, and without
  // them there is no affordable fifteen at all.
  const cheap = pool.filter((p) => p.now_cost <= 45);
  assert.ok(cheap.length >= 8, `only ${cheap.length} players at 4.5m or under`);
  for (const code of ['GKP', 'DEF', 'MID', 'FWD']) {
    assert.ok(pool.some((p) => POS[p.element_type] === code && p.now_cost <= 50), `no cheap ${code}`);
  }
});

test('squadScore prefers the squad that scores more', () => {
  const r = optimal();
  const ep = (p) => projections.get(p.id)?.epTotal ?? 0;
  const good = squadScore(r.squad, ep);

  // Swap the best player for a much worse one of the same position.
  const worse = [...r.squad];
  const i = worse.findIndex((p) => POS[p.element_type] === 'MID');
  const dud = players
    .filter((p) => POS[p.element_type] === 'MID' && !worse.some((s) => s.id === p.id))
    .sort((a, b) => ep(a) - ep(b))[0];
  worse[i] = dud;
  assert.ok(squadScore(worse, ep) < good);
});

test('candidatePool never returns a player who cannot be selected', () => {
  const p = candidatePool(players, projections);
  for (const c of p) {
    assert.ok((projections.get(c.id)?.availability ?? 0) > 0, `${c.web_name} is unavailable`);
  }
});
