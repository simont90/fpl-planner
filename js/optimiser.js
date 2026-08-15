/**
 * Squad selection.
 *
 * The model says what every player is worth. This decides which fifteen to own,
 * which eleven to start, and who to captain — under rules that make the problem
 * genuinely combinatorial rather than a matter of taking the best players:
 *
 *   - fifteen players: 2 GKP, 5 DEF, 5 MID, 3 FWD
 *   - £100.0m budget
 *   - at most three from any one club
 *   - the eleven that start must form a legal formation
 *
 * The club cap is what stops this being a knapsack. Without it the answer would
 * be a simple efficient-frontier sweep; with it, taking the best three Arsenal
 * players forecloses the fourth, and the cost of that foreclosure depends on
 * every other pick. So this searches rather than solves: many greedy seeds,
 * each driven downhill by swaps until nothing improves, keeping the best squad
 * found. `optimiseSquad` reports `converged` — how many independent restarts
 * reached the winning score — which is the honest signal of whether the answer
 * is the optimum or merely the best seen.
 *
 * The eleven, by contrast, IS solved exactly: there are only eight legal
 * formations, so `bestXI` enumerates all of them.
 */

import { POS } from './model.js';

/** Squad composition FPL requires. */
export const SQUAD = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

/** Budget in tenths of a million, matching `now_cost`. */
export const BUDGET = 1000;

export const MAX_PER_CLUB = 3;

export const CODES = ['GKP', 'DEF', 'MID', 'FWD'];

/**
 * Every legal formation: one keeper, 3-5 defenders, 2-5 midfielders, 1-3
 * forwards, ten outfield in total. Generated rather than listed so the set
 * cannot drift out of step with the bounds.
 */
export const FORMATIONS = (() => {
  const out = [];
  for (let d = 3; d <= 5; d++) {
    for (let m = 2; m <= 5; m++) {
      const f = 10 - d - m;
      if (f >= 1 && f <= 3) out.push({ DEF: d, MID: m, FWD: f, name: `${d}-${m}-${f}` });
    }
  }
  return out;
})();

/**
 * What a bench place is worth relative to a starting one.
 *
 * A benched outfielder scores only when a starter does not play, so his points
 * arrive multiplied by the chance of an autosub — call it one week in six. He
 * is not worthless, though, and setting this to zero produces squads with four
 * unplayable £4.0m defenders that collapse the moment anyone is rested.
 *
 * The backup keeper is worth far less again: he only ever plays if the first
 * choice is dropped or injured, and two keepers cannot both return in a week.
 * Weighting him near zero is what produces the £4.0m backup that every good
 * squad carries, rather than spending £5.5m on a second starter.
 */
export const BENCH_WEIGHT = { outfield: 0.16, keeper: 0.03 };

const byPos = (players) => {
  const m = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const p of players) m[POS[p.element_type]].push(p);
  return m;
};

/* ------------------------------------------------------------------ *
 * Best eleven
 * ------------------------------------------------------------------ */

/**
 * The highest-scoring legal eleven from a fifteen, solved exactly.
 *
 * Within a formation the choice is trivial — take the highest projected
 * players position by position — so enumerating the eight formations and
 * keeping the best is optimal, not a heuristic.
 *
 * @param {Array} squad  fifteen bootstrap elements
 * @param {(p)=>number} ep  projected points for the gameweek being started
 * @returns {{ xi, bench, benchKeeper, formation, captain, vice, xiPoints, total }}
 */
export function bestXI(squad, ep) {
  const pos = byPos(squad);
  for (const code of CODES) pos[code].sort((a, b) => ep(b) - ep(a));

  let best = null;
  for (const f of FORMATIONS) {
    if (pos.GKP.length < 1 || pos.DEF.length < f.DEF || pos.MID.length < f.MID || pos.FWD.length < f.FWD) {
      continue;
    }
    const xi = [
      pos.GKP[0],
      ...pos.DEF.slice(0, f.DEF),
      ...pos.MID.slice(0, f.MID),
      ...pos.FWD.slice(0, f.FWD),
    ];
    const xiPoints = xi.reduce((a, p) => a + ep(p), 0);
    if (!best || xiPoints > best.xiPoints) best = { xi, xiPoints, formation: f };
  }
  if (!best) return null;

  const starting = new Set(best.xi.map((p) => p.id));
  // Autosubs come on in the order you list them, so the bench is ranked by
  // projection. The reserve keeper sits outside that order — he can only ever
  // replace the other keeper.
  const bench = squad
    .filter((p) => !starting.has(p.id) && POS[p.element_type] !== 'GKP')
    .sort((a, b) => ep(b) - ep(a));
  const benchKeeper = squad.find((p) => !starting.has(p.id) && POS[p.element_type] === 'GKP') || null;

  const ranked = [...best.xi].sort((a, b) => ep(b) - ep(a));
  const captain = ranked[0] || null;
  const vice = ranked[1] || null;

  return {
    xi: best.xi,
    bench,
    benchKeeper,
    formation: best.formation,
    captain,
    vice,
    xiPoints: best.xiPoints,
    // The armband doubles one player, so his projection is counted twice.
    total: best.xiPoints + (captain ? ep(captain) : 0),
  };
}

/**
 * What a fifteen is worth: the eleven that would start, the captain's double,
 * and a discounted contribution from the bench.
 */
export function squadScore(squad, ep, { bench = BENCH_WEIGHT } = {}) {
  const xi = bestXI(squad, ep);
  if (!xi) return -Infinity;
  const benchPts =
    xi.bench.reduce((a, p) => a + ep(p), 0) * bench.outfield +
    (xi.benchKeeper ? ep(xi.benchKeeper) * bench.keeper : 0);
  return xi.total + benchPts;
}

/* ------------------------------------------------------------------ *
 * Legality
 * ------------------------------------------------------------------ */

export function squadCost(squad, priceOf) {
  return squad.reduce((a, p) => a + priceOf(p), 0);
}

/**
 * Why a fifteen is not enterable, or null if it is. Returns the reason rather
 * than a boolean so the UI can say what is wrong with a squad the user built.
 */
export function violation(squad, { budget = BUDGET, priceOf = (p) => p.now_cost } = {}) {
  if (squad.length !== 15) return `squad has ${squad.length} players, needs 15`;
  const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = new Map();
  const seen = new Set();
  for (const p of squad) {
    if (seen.has(p.id)) return `${p.web_name} is picked twice`;
    seen.add(p.id);
    counts[POS[p.element_type]]++;
    clubs.set(p.team, (clubs.get(p.team) || 0) + 1);
  }
  for (const code of CODES) {
    if (counts[code] !== SQUAD[code]) return `${counts[code]} ${code}, needs ${SQUAD[code]}`;
  }
  for (const [team, n] of clubs) {
    if (n > MAX_PER_CLUB) return `${n} players from team ${team}, max ${MAX_PER_CLUB}`;
  }
  const cost = squadCost(squad, priceOf);
  if (cost > budget) return `costs ${(cost / 10).toFixed(1)}m, budget ${(budget / 10).toFixed(1)}m`;
  return null;
}

/* ------------------------------------------------------------------ *
 * Candidate pool
 * ------------------------------------------------------------------ */

/**
 * Cut the 587 selectable players down to those that could plausibly appear in
 * an optimal squad.
 *
 * Two kinds survive. The obvious one is raw projection — the best players at
 * each position. The other is price: a squad is fifteen players inside one
 * budget, so the cheapest credible body at each position is as structurally
 * important as the best, because he is what funds the players who score. A
 * pool taken purely on projection contains no £4.0m defenders and therefore
 * cannot build an affordable squad at all.
 *
 * So the pool keeps the top `perPosition` by projection plus, at every
 * individual price point, the best few players available at that price.
 */
export function candidatePool(players, projections, { perPosition = 45, perPriceBucket = 3 } = {}) {
  const ep = (p) => projections.get(p.id)?.epTotal ?? 0;
  const pos = byPos(players.filter((p) => (projections.get(p.id)?.availability ?? 0) > 0));

  const pool = new Set();
  for (const code of CODES) {
    const list = [...pos[code]].sort((a, b) => ep(b) - ep(a));
    for (const p of list.slice(0, perPosition)) pool.add(p);

    const buckets = new Map();
    for (const p of list) {
      if (!buckets.has(p.now_cost)) buckets.set(p.now_cost, []);
      buckets.get(p.now_cost).push(p);
    }
    for (const bucket of buckets.values()) {
      for (const p of bucket.slice(0, perPriceBucket)) pool.add(p);
    }
  }
  return [...pool];
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/**
 * A deterministic pseudo-random source.
 *
 * The search uses randomness to seed its restarts, but a squad optimiser that
 * answers differently each time it is asked the same question is impossible to
 * test and unnerving to use. Seeding it explicitly keeps restarts independent
 * of each other while keeping the run reproducible.
 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Running position/club/cost tallies, so a swap can be checked in O(1). */
function tally(squad, priceOf) {
  const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = new Map();
  let cost = 0;
  for (const p of squad) {
    counts[POS[p.element_type]]++;
    clubs.set(p.team, (clubs.get(p.team) || 0) + 1);
    cost += priceOf(p);
  }
  return { counts, clubs, cost };
}

/**
 * Build a starting fifteen by taking the best available player at each slot,
 * while keeping enough money back to fill the slots still empty.
 *
 * The reserve is what makes the seed feasible. Picking greedily on projection
 * alone spends the budget on the first eight names and then cannot afford a
 * fifteenth player at any price, so the seed has to hold back at least the
 * cheapest remaining body for every unfilled slot.
 */
function greedySeed(pool, ep, priceOf, opts, rand, rank = ep) {
  const { budget, locked, banned, noise } = opts;
  const squad = [...locked];
  const t = tally(squad, priceOf);
  const taken = new Set(squad.map((p) => p.id));

  const pos = byPos(pool.filter((p) => !taken.has(p.id) && !banned.has(p.id)));
  // Cheapest-first, so the funds a seed must hold back can be read off directly.
  const byPrice = {};
  for (const code of CODES) byPrice[code] = [...pos[code]].sort((a, b) => priceOf(a) - priceOf(b));

  /**
   * What it costs to fill `k` more slots at this position, at the very least.
   *
   * Two things make this less obvious than a minimum price times a count.
   *
   * You cannot buy the same £4.0m defender five times, so the reserve has to
   * be the sum of the `k` cheapest distinct players, not the cheapest one
   * repeated. Reserving that way understates what the seed must keep back, so
   * it spends down to a floor it cannot actually afford.
   *
   * And the cheapest players are not all buyable. The club cap means a squad
   * that already holds three from a club cannot take a fourth however cheap he
   * is, and the bargain end of the list clusters heavily in a few squads — so
   * a reserve built from raw prices sets money aside for players that are not
   * legally available. That is what stranded the fill on its final slot with
   * exactly enough money and no one to spend it on.
   *
   * Walking cheapest-first while respecting the cap can overstate the reserve,
   * because it assumes this position alone competes for those club places.
   * Overstating is the safe direction: it keeps more money back than strictly
   * needed, where understating fails outright.
   */
  const reserveFor = (code, k, clubs) => {
    if (k <= 0) return 0;
    const used = new Map(clubs);
    let sum = 0;
    let n = 0;
    for (const p of byPrice[code]) {
      if (taken.has(p.id)) continue;
      const held = used.get(p.team) || 0;
      if (held >= MAX_PER_CLUB) continue;
      used.set(p.team, held + 1);
      sum += priceOf(p);
      if (++n === k) return sum;
    }
    return Infinity; // not enough legally available bodies at this position
  };

  const order = [];
  for (const code of CODES) for (let i = t.counts[code]; i < SQUAD[code]; i++) order.push(code);
  // Fill the expensive positions first: they are the ones the budget actually
  // binds on, and leaving them to last is what strands a squad with £30m
  // unspent and only keepers left to buy.
  order.sort((a, b) => SQUAD[a] - SQUAD[b]);

  for (let i = 0; i < order.length; i++) {
    const code = order[i];
    // Money that must survive this pick to fill every slot after it.
    const remaining = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
    for (let j = i + 1; j < order.length; j++) remaining[order[j]]++;
    let reserve = 0;
    for (const c of CODES) reserve += reserveFor(c, remaining[c], t.clubs);
    const ceiling = budget - t.cost - reserve;

    const legal = pos[code].filter(
      (p) => !taken.has(p.id) && (t.clubs.get(p.team) || 0) < MAX_PER_CLUB
    );
    if (!legal.length) return null; // no bodies left at all: genuinely stuck

    const affordable = legal.filter((p) => priceOf(p) <= ceiling);

    // The reserve is an estimate, and it errs in both directions — it cannot
    // know which club places the positions still to be filled will compete
    // for. When it turns out to have been too cautious there is nothing
    // affordable left, and the fill would otherwise abandon a squad that is
    // still perfectly reachable. Dropping to the cheapest legal player keeps
    // it feasible; the improvement pass is what turns a feasible squad into a
    // good one, so a conservative pick here costs nothing but a little search.
    const options = affordable.length ? affordable : [minBy(legal, priceOf)];

    // Rank by projection, jittered so restarts explore different squads.
    const scored = options.map((p) => ({ p, k: rank(p) * (1 + (rand() - 0.5) * noise) }));
    scored.sort((a, b) => b.k - a.k);
    const pick = scored[0].p;

    squad.push(pick);
    taken.add(pick.id);
    t.counts[code]++;
    t.clubs.set(pick.team, (t.clubs.get(pick.team) || 0) + 1);
    t.cost += priceOf(pick);
  }

  // The fallback above can only ever have spent less than the ceiling allowed,
  // but the ceiling itself was an estimate, so the total is checked rather
  // than assumed.
  return squad.length === 15 && t.cost <= budget ? squad : null;
}

const minBy = (xs, f) => xs.reduce((a, b) => (f(b) < f(a) ? b : a));

/**
 * The single best one-for-one swap, or null if none improves the squad.
 *
 * Steepest descent rather than first-improvement — it costs a full sweep per
 * step but lands on better optima, and at this problem size a sweep is cheap.
 */
function singlePass(current, score, byCode, ep, priceOf, opts) {
  const { budget, lockedIds, bench } = opts;
  const t = tally(current, priceOf);
  const inSquad = new Set(current.map((p) => p.id));
  let best = null;

  for (let i = 0; i < current.length; i++) {
    const out = current[i];
    if (lockedIds.has(out.id)) continue;
    const spare = budget - t.cost + priceOf(out);
    const clubAfterOut = (t.clubs.get(out.team) || 0) - 1;

    for (const cand of byCode[POS[out.element_type]]) {
      if (inSquad.has(cand.id)) continue;
      if (priceOf(cand) > spare) continue;
      const club = cand.team === out.team ? clubAfterOut : t.clubs.get(cand.team) || 0;
      if (club >= MAX_PER_CLUB) continue;

      const trial = current.slice();
      trial[i] = cand;
      const s = squadScore(trial, ep, { bench });
      if (s > score + 1e-9 && (!best || s > best.score)) best = { score: s, trial };
    }
  }
  return best;
}

/**
 * The single best two-for-two swap, or null if none improves the squad.
 *
 * This move is what makes the search work at all. A squad that has spent its
 * budget sits in a local optimum that one-for-one swaps cannot leave: every
 * upgrade costs money there is none of, so each individual swap is rejected
 * and the search reports itself finished several points short. Reaching the
 * better squad requires downgrading one player to fund another — two changes
 * that are only worth making together, and neither of which a one-at-a-time
 * search will ever take the first half of.
 *
 * Enumerating both replacements in full is far too much work, so each side is
 * capped: the strongest `WIDE` candidates for the first slot, and for each of
 * those the strongest `NARROW` still affordable for the second. Both lists are
 * ordered by projection, which is not the objective itself but tracks it
 * closely enough to put the real answer inside the cap.
 */
const PAIR_WIDE = 18;
const PAIR_NARROW = 6;

function pairPass(current, score, byCode, ep, priceOf, opts) {
  const { budget, lockedIds, bench } = opts;
  const t = tally(current, priceOf);
  const inSquad = new Set(current.map((p) => p.id));
  let best = null;

  for (let i = 0; i < current.length; i++) {
    const outI = current[i];
    if (lockedIds.has(outI.id)) continue;

    for (let j = i + 1; j < current.length; j++) {
      const outJ = current[j];
      if (lockedIds.has(outJ.id)) continue;

      // Money freed by vacating both slots, and the club tallies without them.
      const spare = budget - t.cost + priceOf(outI) + priceOf(outJ);
      const clubs = new Map(t.clubs);
      clubs.set(outI.team, clubs.get(outI.team) - 1);
      clubs.set(outJ.team, clubs.get(outJ.team) - 1);

      const listI = byCode[POS[outI.element_type]];
      const listJ = byCode[POS[outJ.element_type]];

      let triedA = 0;
      for (const a of listI) {
        if (triedA >= PAIR_WIDE) break;
        if (inSquad.has(a.id)) continue;
        if (priceOf(a) > spare) continue;
        if ((clubs.get(a.team) || 0) >= MAX_PER_CLUB) continue;
        triedA++;

        const left = spare - priceOf(a);
        let triedB = 0;
        for (const b of listJ) {
          if (triedB >= PAIR_NARROW) break;
          if (b.id === a.id || inSquad.has(b.id)) continue;
          if (priceOf(b) > left) continue;
          const cap = (clubs.get(b.team) || 0) + (b.team === a.team ? 1 : 0);
          if (cap >= MAX_PER_CLUB) continue;
          triedB++;

          const trial = current.slice();
          trial[i] = a;
          trial[j] = b;
          const s = squadScore(trial, ep, { bench });
          if (s > score + 1e-9 && (!best || s > best.score)) best = { score: s, trial };
        }
      }
    }
  }
  return best;
}

/**
 * Drive a squad downhill until neither move set can improve it.
 *
 * One-for-one swaps are swept first because they are an order of magnitude
 * cheaper; the paired move is only reached once the cheap one is exhausted,
 * and any improvement it finds sends the search back to the cheap sweep.
 */
function improve(squad, pool, ep, priceOf, opts, { pairs = true } = {}) {
  const byCode = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const p of pool) byCode[POS[p.element_type]].push(p);
  for (const code of CODES) byCode[code].sort((a, b) => ep(b) - ep(a));

  let current = [...squad];
  let score = squadScore(current, ep, { bench: opts.bench });

  for (let step = 0; step < 200; step++) {
    let move = singlePass(current, score, byCode, ep, priceOf, opts);
    if (!move && pairs) move = pairPass(current, score, byCode, ep, priceOf, opts);
    if (!move) break;
    current = move.trial;
    score = move.score;
  }
  return { squad: current, score };
}

/**
 * The best fifteen this search can find.
 *
 * @param {Array}  players      selectable bootstrap elements
 * @param {Map}    projections  id → projectPlayer output
 * @param {object} opts
 *   budget      spend limit in tenths (default £100.0m)
 *   horizon     'epTotal' to build for a run of weeks, 'epNext' for one
 *   lock        player ids that must be in the squad
 *   ban         player ids that must not be
 *   restarts    independent seeds to drive downhill
 *   polish      how many leading squads get the expensive paired-swap finish
 *   pairs       whether to use paired swaps at all; off is faster and worse
 *   priceOf     what a player costs (selling price differs from `now_cost`)
 * @returns {{ squad, score, xi, cost, converged, finalists, restarts, violation }}
 */
export function optimiseSquad(players, projections, opts = {}) {
  const {
    budget = BUDGET,
    horizon = 'epTotal',
    lock = [],
    ban = [],
    restarts = 40,
    polish = 8,
    pairs = true,
    seed = 12345,
    bench = BENCH_WEIGHT,
    priceOf = (p) => p.now_cost,
    pool: givenPool,
  } = opts;

  const ep = (p) => projections.get(p.id)?.[horizon] ?? 0;
  const banned = new Set(ban);
  const lockedIds = new Set(lock);
  const byId = new Map(players.map((p) => [p.id, p]));
  const locked = lock.map((id) => byId.get(id)).filter(Boolean);

  let pool = givenPool || candidatePool(players, projections);
  // Locked players are kept in the pool even if the filter would have cut them
  // — the user asked for them by name.
  const poolIds = new Set(pool.map((p) => p.id));
  for (const p of locked) if (!poolIds.has(p.id)) pool = [...pool, p];
  pool = pool.filter((p) => !banned.has(p.id));

  const rand = rng(seed);
  const searchOpts = { budget, locked, lockedIds, banned, bench, noise: 0 };

  // Phase one: drive every restart downhill on one-for-one swaps only. This is
  // cheap enough to run dozens of times and its job is breadth — landing in as
  // many different basins as possible, not finishing any of them.
  const rough = [];
  for (let r = 0; r < restarts; r++) {
    // The first seed is pure greedy; the rest are jittered to land elsewhere.
    searchOpts.noise = r === 0 ? 0 : 0.15 + 0.5 * rand();
    const start = greedySeed(pool, ep, priceOf, searchOpts, rand);
    if (!start) continue;
    rough.push(improve(start, pool, ep, priceOf, searchOpts, { pairs: false }));
  }

  // Chasing projection can spend a tight budget before the squad is full, and
  // no amount of restarting fixes that — every seed makes the same mistake in
  // a different order. Building cheapest-first instead cannot overspend, so it
  // finds a squad whenever one exists, and the improvement pass has a feasible
  // squad to work up from. Only needed as a rescue, so it runs only when the
  // projection-driven seeds have all failed.
  if (!rough.length) {
    searchOpts.noise = 0;
    const cheap = greedySeed(pool, ep, priceOf, searchOpts, rand, (p) => -priceOf(p));
    if (cheap) rough.push(improve(cheap, pool, ep, priceOf, searchOpts, { pairs: false }));
  }
  if (!rough.length) {
    return {
      squad: null, score: -Infinity, xi: null, cost: 0,
      converged: 0, finalists: 0, restarts,
      // Deliberately not "no such squad exists" — the search failing and the
      // problem being infeasible are different claims, and only the first one
      // is observed here. Near the very cheapest legal fifteen the fill order
      // can spend club places on keepers that the cheap defenders needed and
      // give up a few hundred thousand short. Real budgets are nowhere near
      // that edge, so it is left alone rather than papered over.
      violation: `could not build a legal squad within ${(budget / 10).toFixed(1)}m`,
    };
  }

  // Phase two: finish the most promising basins properly, paired moves and all.
  // Only the leaders are worth the cost, and a squad that phase one left well
  // adrift does not become the winner once budget is reallocated.
  rough.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const finalists = [];
  for (const cand of rough) {
    const key = cand.squad.map((p) => p.id).sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    finalists.push(cand);
    if (finalists.length >= Math.max(1, polish)) break;
  }

  let best = null;
  let converged = 0;
  for (const cand of finalists) {
    const res = improve(cand.squad, pool, ep, priceOf, searchOpts, { pairs });
    if (!best || res.score > best.score + 1e-9) {
      best = res;
      converged = 1;
    } else if (Math.abs(res.score - best.score) < 1e-9) {
      converged++;
    }
  }

  const xiEp = (p) => projections.get(p.id)?.epNext ?? 0;
  return {
    squad: best.squad,
    score: best.score,
    xi: bestXI(best.squad, xiEp),
    cost: squadCost(best.squad, priceOf),
    // How many of the fully-polished finalists independently reached this
    // score. All of them agreeing is the strongest evidence available here
    // that the squad is optimal rather than merely the best one seen.
    converged,
    finalists: finalists.length,
    restarts,
    violation: violation(best.squad, { budget, priceOf }),
  };
}
