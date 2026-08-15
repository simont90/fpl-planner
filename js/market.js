/**
 * The market: what players cost, and who else owns them.
 *
 * Two things here that the expected-points model deliberately ignores, because
 * neither changes how many points a player scores — only what owning him is
 * worth to you.
 *
 * PRICE. Team value is a slow compounding advantage: a squad that gains £3m
 * over a season can afford a player the field cannot. Prices move on transfer
 * volume, not on performance.
 *
 * OWNERSHIP. Fantasy football is scored on rank, not on points. A captain
 * haul that 70% of managers also have gains you nothing; the same haul from a
 * 3%-owned player gains you the field. Expected points and expected *rank*
 * are different objectives, and this module is what lets the tool talk about
 * the second one.
 *
 * A note on what is measured and what is inferred, because the difference
 * matters for a tool that claims to be data-driven:
 *
 *   measured   ownership (`selected_by_percent`), total managers, price
 *              moves, transfer volumes — all straight from the API
 *   inferred   captaincy rates and starting-XI rates, which the public API
 *              does not expose at all and which this module models
 *
 * Every inferred figure is flagged `modelled: true` where it is returned.
 */

import { POS } from './model.js';
import { bestXI } from './optimiser.js';

/* ------------------------------------------------------------------ *
 * Price changes
 * ------------------------------------------------------------------ */

/**
 * FPL never published the rule that moves prices, and it is not derivable from
 * the payload — the API reports that a price changed, never the threshold it
 * crossed. What is well established is the shape: a player rises when net
 * transfers in, measured against how many managers already own him, run far
 * enough ahead; and the count resets on each change.
 *
 * This is that shape with a threshold that has to be fitted from observed
 * changes. `calibratePriceModel` does the fitting once a season has produced
 * any, and until then `predictPriceChanges` reports itself dormant rather than
 * dressing up a prior as a forecast.
 */
export const PRICE_PRIOR = {
  // Net transfers, as a share of all managers, needed to move a player 0.1m.
  // A starting guess only — the real value is fitted.
  threshold: 0.0075,
  // Owned players need proportionally more movement to shift, because the
  // count that matters is net flow against an existing holding.
  ownershipDamping: 0.35,
};

/**
 * Momentum for one player: net transfers this gameweek as a share of the
 * active manager base, damped by how widely he is already owned.
 */
export function priceMomentum(player, totalManagers, prior = PRICE_PRIOR) {
  const net = (player.transfers_in_event || 0) - (player.transfers_out_event || 0);
  if (!totalManagers) return 0;
  const share = net / totalManagers;
  const owned = Math.max(0.001, parseFloat(player.selected_by_percent) / 100 || 0.001);
  return share / Math.pow(owned, prior.ownershipDamping);
}

/**
 * Fit the rise/fall threshold to price changes that have actually happened.
 *
 * Uses this gameweek's movers as the training set: every player whose price
 * moved is a point where the threshold was crossed, and every player whose
 * price held is a point where it was not. The fitted threshold is the one that
 * separates the two with the fewest mistakes.
 *
 * @returns {{ fitted: boolean, threshold, risers, fallers, accuracy }}
 */
export function calibratePriceModel(elements, totalManagers, prior = PRICE_PRIOR) {
  const rows = elements
    .filter((p) => (p.transfers_in_event || 0) + (p.transfers_out_event || 0) > 0)
    .map((p) => ({ m: priceMomentum(p, totalManagers, prior), moved: Math.sign(p.cost_change_event || 0) }));

  const risers = rows.filter((r) => r.moved > 0);
  const fallers = rows.filter((r) => r.moved < 0);
  if (risers.length < 3 || fallers.length < 3) {
    return { fitted: false, threshold: prior.threshold, risers: risers.length, fallers: fallers.length, accuracy: null };
  }

  let best = { t: prior.threshold, wrong: Infinity };
  const candidates = rows.map((r) => Math.abs(r.m)).sort((a, b) => a - b);
  for (const t of candidates) {
    let wrong = 0;
    for (const r of rows) {
      const pred = r.m >= t ? 1 : r.m <= -t ? -1 : 0;
      if (pred !== r.moved) wrong++;
    }
    if (wrong < best.wrong) best = { t, wrong };
  }
  return {
    fitted: true,
    threshold: best.t,
    risers: risers.length,
    fallers: fallers.length,
    accuracy: 1 - best.wrong / rows.length,
  };
}

/**
 * Who is about to rise or fall.
 *
 * Returns `dormant: true` before a season has generated any transfer traffic.
 * That is the honest answer in preseason — every transfer field in the payload
 * is zero, so there is no signal to read, and a list of confident predictions
 * built on zeroes would be worse than no list at all.
 */
export function predictPriceChanges(elements, totalManagers, opts = {}) {
  const { prior = PRICE_PRIOR, calibration = null, limit = 20 } = opts;

  const active = elements.filter(
    (p) => (p.transfers_in_event || 0) + (p.transfers_out_event || 0) > 0
  );
  if (!active.length) {
    return {
      dormant: true,
      reason:
        'No transfer activity in the payload yet — every transfer count is zero, ' +
        'which is what preseason looks like. Price movement cannot be predicted ' +
        'from nothing, and this will start working on its own once the season ' +
        'opens and managers begin transferring.',
      rises: [],
      falls: [],
      calibration: null,
    };
  }

  const cal = calibration || calibratePriceModel(elements, totalManagers, prior);
  const threshold = cal.threshold;

  const scored = active.map((p) => {
    const m = priceMomentum(p, totalManagers, prior);
    return {
      id: p.id,
      name: p.web_name,
      pos: POS[p.element_type],
      cost: p.now_cost,
      ownership: parseFloat(p.selected_by_percent) || 0,
      net: (p.transfers_in_event || 0) - (p.transfers_out_event || 0),
      momentum: m,
      // Distance past the threshold, as a rough confidence. Not a probability:
      // it is a monotone score, and calling it one would overstate it.
      pressure: threshold ? m / threshold : 0,
    };
  });

  return {
    dormant: false,
    calibration: cal,
    rises: scored.filter((s) => s.pressure >= 1).sort((a, b) => b.pressure - a.pressure).slice(0, limit),
    falls: scored.filter((s) => s.pressure <= -1).sort((a, b) => a.pressure - b.pressure).slice(0, limit),
  };
}

/* ------------------------------------------------------------------ *
 * Ownership
 * ------------------------------------------------------------------ */

/**
 * `selected_by_percent` counts squad membership, not selection. A player owned
 * by 40% of managers might start for nearly all of them or be a bench filler
 * for most, and those are very different things when the question is what the
 * field will score this week.
 *
 * The split is not in the API, so it is modelled: a player is assumed to start
 * for his owners in proportion to how clearly he is worth starting, which the
 * projection already measures. Rated against the typical starter's projection
 * so the mapping does not drift when scoring rules change.
 */
function startRate(ep, benchmark) {
  if (ep <= 0) return 0;
  const r = ep / Math.max(0.1, benchmark);
  // Saturating rather than linear: past a point a player is simply nailed on,
  // and doubling his projection does not make him start twice as often.
  return Math.min(0.98, 1 - Math.exp(-1.9 * r));
}

/**
 * Estimated captaincy share.
 *
 * Managers captain the highest-projected player they own, so captaincy
 * concentrates far more sharply than ownership does — the armband is close to
 * winner-take-all among the handful of premiums. Modelled as ownership
 * weighted by an exponential in projection, then normalised so the shares sum
 * to one armband per manager.
 */
function captaincyShares(players, projections, gw = 'epNext') {
  const rows = players.map((p) => {
    const ep = projections.get(p.id)?.[gw] ?? 0;
    const own = (parseFloat(p.selected_by_percent) || 0) / 100;
    return { p, ep, own, weight: own * Math.exp(1.35 * ep) };
  });
  const total = rows.reduce((a, r) => a + r.weight, 0) || 1;
  const map = new Map();
  for (const r of rows) map.set(r.p.id, r.weight / total);
  return map;
}

/**
 * Effective ownership: the share of the field's points a player accounts for,
 * counting the armband twice.
 *
 * EO is the number that decides whether a haul helps or hurts your rank. A
 * 70%-owned captain is effectively owned at 140%: if he blanks you gain
 * ground, and if he hauls you lose it despite scoring well.
 *
 * @returns Map id → { ownership, startRate, captaincy, eo, modelled: true }
 */
export function effectiveOwnership(players, projections, { gw = 'epNext' } = {}) {
  const eps = players.map((p) => projections.get(p.id)?.[gw] ?? 0).filter((e) => e > 0).sort((a, b) => b - a);
  // The typical starter, taken from the middle of the players good enough to
  // be picked at all rather than from the whole league.
  const benchmark = eps.length ? eps[Math.floor(eps.length * 0.18)] : 3;
  const caps = captaincyShares(players, projections, gw);

  const out = new Map();
  for (const p of players) {
    const ep = projections.get(p.id)?.[gw] ?? 0;
    const ownership = parseFloat(p.selected_by_percent) || 0;
    const sr = startRate(ep, benchmark);
    const captaincy = (caps.get(p.id) || 0) * 100;
    out.set(p.id, {
      ownership,
      startRate: sr,
      captaincy,
      eo: ownership * sr + captaincy,
      modelled: true,
    });
  }
  return out;
}

/**
 * What the average manager is expected to score this gameweek.
 *
 * The field's score is every player's projection weighted by how much of the
 * field effectively owns him. This is the baseline your own squad is actually
 * competing against — a squad projected at 55 points is a good week or a bad
 * one entirely depending on whether this number is 48 or 58.
 */
export function fieldExpectation(players, projections, eo, { gw = 'epNext' } = {}) {
  let total = 0;
  for (const p of players) {
    const ep = projections.get(p.id)?.[gw] ?? 0;
    total += ep * ((eo.get(p.id)?.eo ?? 0) / 100);
  }
  return total;
}

/**
 * Your squad against the field.
 *
 * Reports the projected margin over the average manager, and breaks it into
 * the picks that generate it: players you own more of than the field
 * (differentials, which gain rank when they score) and players the field owns
 * that you do not (template risks, which cost rank when they score).
 */
export function versusField(squad, players, projections, eo, { gw = 'epNext' } = {}) {
  const ep = (p) => projections.get(p.id)?.[gw] ?? 0;
  const xi = bestXI(squad, ep);
  if (!xi) return null;

  const mine = new Map();
  for (const p of xi.xi) mine.set(p.id, 1);
  if (xi.captain) mine.set(xi.captain.id, 2);

  const field = fieldExpectation(players, projections, eo, { gw });

  const rows = [];
  for (const p of players) {
    const own = mine.get(p.id) || 0;
    const theirs = (eo.get(p.id)?.eo ?? 0) / 100;
    const edge = (own - theirs) * ep(p);
    if (Math.abs(edge) < 0.05) continue;
    rows.push({
      id: p.id,
      name: p.web_name,
      pos: POS[p.element_type],
      ep: ep(p),
      yours: own,
      field: theirs,
      edge,
    });
  }
  rows.sort((a, b) => b.edge - a.edge);

  return {
    you: xi.total,
    field,
    margin: xi.total - field,
    differentials: rows.filter((r) => r.edge > 0).slice(0, 10),
    risks: rows.filter((r) => r.edge < 0).sort((a, b) => a.edge - b.edge).slice(0, 10),
    modelled: true,
  };
}

/**
 * The template: the squad the field actually owns, by raw ownership.
 *
 * Useful as a reference point rather than a target — it is what you are
 * measured against, and every player in it that you do not own is a position
 * you are taking against the field whether you meant to or not.
 */
export function templateSquad(players, projections, { gw = 'epNext' } = {}) {
  const own = (p) => parseFloat(p.selected_by_percent) || 0;
  const pick = (code, n) =>
    players
      .filter((p) => POS[p.element_type] === code)
      .sort((a, b) => own(b) - own(a))
      .slice(0, n);

  const squad = [...pick('GKP', 2), ...pick('DEF', 5), ...pick('MID', 5), ...pick('FWD', 3)];
  const ep = (p) => projections.get(p.id)?.[gw] ?? 0;
  const cost = squad.reduce((a, p) => a + p.now_cost, 0);
  return {
    squad,
    xi: bestXI(squad, ep),
    cost,
    // Assembled position by position from raw ownership, so it routinely
    // breaks the budget and the three-per-club cap: no single manager owns
    // this fifteen, and it is not meant to be bought. It is the shape of what
    // the field holds in aggregate, which is what your rank moves against.
    buildable: cost <= 1000,
    ownership: squad.map((p) => ({ name: p.web_name, pos: POS[p.element_type], ownership: own(p), ep: ep(p) })),
  };
}
