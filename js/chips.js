/**
 * Chip strategy.
 *
 * Each chip is worth the points it adds over playing the same gameweek without
 * it, so all four are scored on one scale and can be compared directly:
 *
 *   Bench Boost    the bench actually counts, so its value is the bench
 *   Triple Captain the armband pays triple not double, so one more captain
 *   Free Hit       a different squad for one week, then everything reverts
 *   Wildcard       a permanent rebuild, so it is worth the horizon not a week
 *
 * The first three are one-week chips and are scored gameweek by gameweek. The
 * Wildcard is not — it changes the squad for the rest of the season, so it is
 * measured against the whole horizon and against the transfers you would have
 * made anyway.
 *
 * Blank and double gameweeks are what make these decisions large, and they are
 * created by cup progression and postponements during the season rather than
 * being in the fixture list at the outset. `gameweekShape` reports what the
 * calendar currently says; early in a season that is every team playing once
 * every week, and this module says so rather than inventing a recommendation.
 */

import { POS } from './model.js';
import { bestXI, squadScore, optimiseSquad, BUDGET } from './optimiser.js';
import { squadValue } from './transfers.js';

/**
 * Per-gameweek projection for one player, pulled out of the horizon the model
 * already built. Returns 0 for a gameweek outside that horizon rather than
 * guessing.
 */
export function epAtGw(projection, gw) {
  if (!projection) return 0;
  const row = projection.gws.find((g) => g.gw === gw);
  return row ? row.ep : 0;
}

/**
 * A view of the projections as though a single gameweek were the whole
 * horizon, so the squad optimiser can be pointed at one week — which is
 * exactly what a Free Hit is.
 */
export function projectionsForGw(projections, gw) {
  const out = new Map();
  for (const [id, pr] of projections) {
    const ep = epAtGw(pr, gw);
    out.set(id, { ...pr, epTotal: ep, epNext: ep });
  }
  return out;
}

/**
 * How many fixtures each team has in each gameweek of the horizon.
 *
 * Blanks and doubles are the whole reason chips have a best week, so this
 * reports them explicitly rather than leaving callers to infer them.
 */
export function gameweekShape(ctx, from = ctx.nextGw, horizon = 8) {
  const out = [];
  for (let i = 0; i < horizon; i++) {
    const gw = from + i;
    const blanks = [];
    const doubles = [];
    let fixtures = 0;
    for (const [teamId, list] of ctx.fixturesByTeam) {
      const n = list.filter((f) => f.gw === gw && !f.finished).length;
      fixtures += n;
      const name = ctx.teams.get(teamId)?.short_name || String(teamId);
      if (n === 0) blanks.push(name);
      if (n > 1) doubles.push(name);
    }
    out.push({
      gw,
      fixtures: fixtures / 2, // each fixture is counted by both sides
      blanks,
      doubles,
      normal: blanks.length === 0 && doubles.length === 0,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * One-week chips
 * ------------------------------------------------------------------ */

/**
 * What Bench Boost would add in a given gameweek: the bench, which normally
 * scores nothing, scoring in full.
 *
 * Note this uses the eleven that would start *that* week, not this week's —
 * an autosub-heavy bench in a double gameweek is the entire point of the chip.
 */
export function benchBoostValue(squad, projections, gw) {
  const ep = (p) => epAtGw(projections.get(p.id), gw);
  const xi = bestXI(squad, ep);
  if (!xi) return { gw, value: 0, detail: [] };
  const benched = [...xi.bench, ...(xi.benchKeeper ? [xi.benchKeeper] : [])];
  return {
    gw,
    value: benched.reduce((a, p) => a + ep(p), 0),
    detail: benched.map((p) => ({ id: p.id, name: p.web_name, pos: POS[p.element_type], ep: ep(p) })),
  };
}

/**
 * What Triple Captain would add: one further copy of the captain's points.
 *
 * The captain is already doubled, so the chip is worth exactly one more of
 * him — not two, and not three.
 */
export function tripleCaptainValue(squad, projections, gw) {
  const ep = (p) => epAtGw(projections.get(p.id), gw);
  const xi = bestXI(squad, ep);
  if (!xi || !xi.captain) return { gw, value: 0, captain: null };
  return {
    gw,
    value: ep(xi.captain),
    captain: { id: xi.captain.id, name: xi.captain.web_name, ep: ep(xi.captain) },
  };
}

/**
 * What Free Hit would add: the best legal squad for that one week, against
 * what the current squad would score in it.
 *
 * The budget is the squad's sale value, because a Free Hit spends the money
 * you have rather than a fresh £100m.
 */
export function freeHitValue(squad, projections, players, gw, opts = {}) {
  const { pool, budget, restarts = 12, polish = 4 } = opts;
  const gwProj = projectionsForGw(projections, gw);
  const ep = (p) => epAtGw(projections.get(p.id), gw);

  const current = bestXI(squad, ep);
  const best = optimiseSquad(players, gwProj, {
    budget: budget ?? BUDGET,
    horizon: 'epTotal',
    pool,
    restarts,
    polish,
  });

  const currentTotal = current ? current.total : 0;
  const bestTotal = best.squad ? best.xi.total : 0;
  return {
    gw,
    value: Math.max(0, bestTotal - currentTotal),
    current: currentTotal,
    best: bestTotal,
    squad: best.squad,
  };
}

/* ------------------------------------------------------------------ *
 * Wildcard
 * ------------------------------------------------------------------ */

/**
 * What a Wildcard is worth: an unlimited rebuild, measured over the horizon
 * rather than a single week because the new squad is kept.
 *
 * The budget is the squad's sale value plus the bank, not a fresh £100m — a
 * wildcard frees you from transfer limits, not from the money you actually
 * have.
 *
 * The gain is stated before crediting the transfers you would have made
 * anyway, and labelled as such. A wildcard that reaches a squad two free
 * transfers could also have reached has earned only the difference, and the
 * honest comparison is against the transfer planner's own recommendation
 * rather than against doing nothing at all.
 */
export function wildcardValue(squad, projections, players, opts = {}) {
  const {
    pool,
    purchasePrice = new Map(),
    bank = 0,
    horizon = 'epTotal',
    restarts = 24,
    polish = 6,
  } = opts;

  const budget = squadValue(squad, purchasePrice, bank);
  const rebuilt = optimiseSquad(players, projections, { budget, horizon, pool, restarts, polish });
  if (!rebuilt.squad) return null;

  const ep = (p) => projections.get(p.id)?.[horizon] ?? 0;
  const current = squadScore(squad, ep);

  return {
    budget,
    squad: rebuilt.squad,
    xi: rebuilt.xi,
    current,
    rebuilt: rebuilt.score,
    gain: rebuilt.score - current,
    converged: rebuilt.converged,
    finalists: rebuilt.finalists,
  };
}

/* ------------------------------------------------------------------ *
 * Putting it together
 * ------------------------------------------------------------------ */

/**
 * Score every chip across the horizon and say which, if any, is worth playing.
 *
 * @returns {{ shape, benchBoost, tripleCaptain, freeHit, wildcard, advice }}
 */
export function planChips(squad, projections, players, ctx, opts = {}) {
  const {
    pool,
    horizon = 6,
    from = ctx.nextGw,
    available = { benchBoost: true, tripleCaptain: true, freeHit: true, wildcard: true },
    purchasePrice = new Map(),
    bank = 0,
    freeTransfers = 1,
  } = opts;

  const shape = gameweekShape(ctx, from, horizon);
  const gws = shape.map((s) => s.gw);

  const benchBoost = available.benchBoost
    ? gws.map((gw) => benchBoostValue(squad, projections, gw)).sort((a, b) => b.value - a.value)
    : [];
  const tripleCaptain = available.tripleCaptain
    ? gws.map((gw) => tripleCaptainValue(squad, projections, gw)).sort((a, b) => b.value - a.value)
    : [];

  // Free Hit is the expensive one — it optimises a whole squad per gameweek —
  // so it is only evaluated where it could plausibly win: a week the current
  // squad is short of bodies, or the best week by raw projection.
  const freeHitGws = available.freeHit ? pickFreeHitWeeks(squad, projections, shape) : [];
  const freeHit = freeHitGws
    .map((gw) =>
      freeHitValue(squad, projections, players, gw, {
        pool,
        budget: squadValue(squad, purchasePrice, bank),
      })
    )
    .sort((a, b) => b.value - a.value);

  const wildcard = available.wildcard
    ? wildcardValue(squad, projections, players, { pool, purchasePrice, bank })
    : null;

  return {
    shape,
    benchBoost,
    tripleCaptain,
    freeHit,
    wildcard,
    advice: chipAdvice({ shape, benchBoost, tripleCaptain, freeHit, wildcard }),
  };
}

/**
 * Gameweeks where a Free Hit could pay: any week the squad has players who
 * cannot field a full eleven, plus the single best week otherwise.
 */
function pickFreeHitWeeks(squad, projections, shape) {
  const interesting = [];
  for (const s of shape) {
    const playing = squad.filter((p) => epAtGw(projections.get(p.id), s.gw) > 0).length;
    if (playing < 14 || s.blanks.length || s.doubles.length) interesting.push(s.gw);
  }
  if (!interesting.length) return [shape[0]?.gw].filter((g) => g != null);
  return interesting.slice(0, 4);
}

function chipAdvice({ shape, benchBoost, tripleCaptain, freeHit, wildcard }) {
  const notes = [];
  const anyIrregular = shape.some((s) => !s.normal);

  if (!anyIrregular) {
    notes.push(
      'Every team plays exactly once in each gameweek of this horizon. Blank and ' +
      'double gameweeks are created later by cup progression and postponements, ' +
      'so there is no calendar edge to time a chip against yet — these values are ' +
      'what each chip is worth on a normal week, which is close to its floor.'
    );
  }

  if (benchBoost[0]) {
    notes.push(
      `Bench Boost is worth most in GW${benchBoost[0].gw} at ` +
      `${benchBoost[0].value.toFixed(1)} points — the value of your bench that week.`
    );
  }
  if (tripleCaptain[0]) {
    notes.push(
      `Triple Captain is worth most in GW${tripleCaptain[0].gw} at ` +
      `${tripleCaptain[0].value.toFixed(1)} points ` +
      `(${tripleCaptain[0].captain?.name ?? 'no captain'}).`
    );
  }
  if (freeHit[0]) {
    notes.push(
      freeHit[0].value > 0
        ? `Free Hit is worth most in GW${freeHit[0].gw} at ${freeHit[0].value.toFixed(1)} points.`
        : 'Free Hit gains nothing on this horizon — your squad is already close to the best available for every week in it.'
    );
  }
  if (wildcard) {
    notes.push(
      wildcard.gain > 0
        ? `A Wildcard rebuild is worth ${wildcard.gain.toFixed(1)} points over the horizon, before counting the transfers you could make anyway.`
        : 'A Wildcard would not improve on your current squad over this horizon.'
    );
  }
  return notes;
}
