/**
 * Transfer planning.
 *
 * Once a squad exists the weekly question stops being "who are the best
 * players" and becomes "is this change worth what it costs" — and the cost is
 * rarely just the four points. Three things have to be priced together:
 *
 *   - the four-point hit, charged once, against a gain that accrues over weeks
 *   - the free transfer itself, which is bankable and so has a value even when
 *     it is not used
 *   - selling prices, which are not what a player is worth today
 *
 * Everything here is measured in points over the planning horizon, so a hit
 * and a gain are directly comparable. `planTransfers` returns the best move at
 * each depth along with the marginal value of going one deeper, which is the
 * number that actually answers "should I take the hit".
 */

import { POS } from './model.js';
import { bestXI, squadScore, BENCH_WEIGHT, MAX_PER_CLUB } from './optimiser.js';

/** A points hit, charged per transfer beyond the free allowance. */
export const HIT_COST = 4;

/** FPL lets you bank free transfers, but no more than this many. */
export const MAX_FREE_TRANSFERS = 5;

/**
 * What FPL pays you for a player.
 *
 * You keep only half of any rise, rounded down to the nearest £0.1m, so a
 * player bought at £7.0m and now worth £7.5m sells for £7.2m rather than
 * £7.5m. Falls are taken in full. Using `now_cost` here instead would quietly
 * hand the planner money it does not have and let it recommend transfers that
 * cannot actually be made.
 */
export function sellingPrice(purchase, now) {
  if (now <= purchase) return now;
  return purchase + Math.floor((now - purchase) / 2);
}

/**
 * The value of a free transfer you do not spend.
 *
 * Rolling is not free-of-charge inaction: next week you hold two transfers and
 * can make a move that needs two, or take one for nothing that would otherwise
 * have cost four. That optionality is worth real points, so a marginal move
 * has to beat it rather than merely beat zero. It is deliberately well below
 * the four-point hit — a banked transfer is worth having, not worth hoarding —
 * and it is a judgement rather than a measurement, which is why it is a named
 * constant the caller can override.
 */
export const ROLL_VALUE = 1.2;

const idsOf = (squad) => new Set(squad.map((p) => p.id));

/**
 * Club counts for a squad, so a candidate move can be checked without
 * rebuilding the tally each time.
 */
export function clubTally(squad) {
  const m = new Map();
  for (const p of squad) m.set(p.team, (m.get(p.team) || 0) + 1);
  return m;
}

/**
 * Candidate replacements for a slot, ranked by projection.
 *
 * Filtered down to the legal and affordable before scoring, because the
 * expensive part is `squadScore` and most of the pool fails a cheap test.
 */
export function replacementsFor(out, pool, ep, ctx) {
  const { inSquad, budgetFor, clubs, sellOf } = ctx;
  const code = POS[out.element_type];
  const spare = budgetFor + sellOf(out);
  const clubAfterOut = (clubs.get(out.team) || 0) - 1;

  const list = [];
  for (const cand of pool) {
    if (inSquad.has(cand.id)) continue;
    if (POS[cand.element_type] !== code) continue;
    if (cand.now_cost > spare) continue;
    const club = cand.team === out.team ? clubAfterOut : clubs.get(cand.team) || 0;
    if (club >= MAX_PER_CLUB) continue;
    list.push(cand);
  }
  list.sort((a, b) => ep(b) - ep(a));
  return list;
}

/**
 * Best single transfer, searched exhaustively.
 *
 * Fifteen slots against a few hundred candidates is small enough to check
 * every legal move, so this is the true best one-for-one rather than an
 * approximation.
 */
function bestSingle(squad, pool, ep, opts) {
  const { bank, sellOf, bench } = opts;
  const base = squadScore(squad, ep, { bench });
  const inSquad = idsOf(squad);
  const clubs = clubTally(squad);
  const ctx = { inSquad, budgetFor: bank, clubs, sellOf };

  const moves = [];
  for (let i = 0; i < squad.length; i++) {
    const out = squad[i];
    for (const cand of replacementsFor(out, pool, ep, ctx)) {
      const trial = squad.slice();
      trial[i] = cand;
      const score = squadScore(trial, ep, { bench });
      if (score > base) {
        moves.push({
          out: [out],
          in: [cand],
          squad: trial,
          score,
          gain: score - base,
          bankAfter: bank + sellOf(out) - cand.now_cost,
        });
      }
    }
  }
  moves.sort((a, b) => b.gain - a.gain);
  return { base, moves };
}

/**
 * Best pair of transfers.
 *
 * Checking every pair exhaustively is hundreds of thousands of squad
 * evaluations, so the first leg is capped to the strongest candidates and the
 * second is searched properly given that choice. The cap is on the first leg
 * rather than the second because a two-transfer move is nearly always one
 * clear upgrade plus whatever funds it.
 */
function bestPair(squad, pool, ep, opts, { width = 12 } = {}) {
  const { bank, sellOf, bench } = opts;
  const base = squadScore(squad, ep, { bench });
  const single = bestSingle(squad, pool, ep, opts);

  const moves = [];
  const seen = new Set();

  // Seed from the leading single moves, plus the moves that free the most
  // money — the second leg of a good pair is often funded by selling someone
  // the one-transfer search had no reason to touch.
  const seeds = single.moves.slice(0, width);

  for (const first of seeds) {
    const inSquad = idsOf(first.squad);
    const clubs = clubTally(first.squad);
    const ctx = { inSquad, budgetFor: first.bankAfter, clubs, sellOf };

    for (let i = 0; i < first.squad.length; i++) {
      const out = first.squad[i];
      if (out.id === first.in[0].id) continue; // do not immediately resell
      for (const cand of replacementsFor(out, pool, ep, ctx)) {
        const trial = first.squad.slice();
        trial[i] = cand;
        const score = squadScore(trial, ep, { bench });
        if (score <= first.score) continue;

        const key = [first.in[0].id, cand.id].sort((a, b) => a - b).join(',') + '|' +
                    [first.out[0].id, out.id].sort((a, b) => a - b).join(',');
        if (seen.has(key)) continue;
        seen.add(key);

        moves.push({
          out: [first.out[0], out],
          in: [first.in[0], cand],
          squad: trial,
          score,
          gain: score - base,
          bankAfter: first.bankAfter + sellOf(out) - cand.now_cost,
        });
      }
    }
  }
  moves.sort((a, b) => b.gain - a.gain);
  return { base, moves };
}

/**
 * Rank this week's options, from doing nothing up to a three-transfer raid.
 *
 * @param {Array} squad        the fifteen currently owned
 * @param {Map}   projections  id → projectPlayer output
 * @param {Array} pool         candidate replacements
 * @param {object} opts
 *   bank            money in hand, tenths
 *   freeTransfers   how many are free this week
 *   purchasePrice   id → what you paid, for selling prices
 *   horizon         'epTotal' (a run of weeks) or 'epNext' (this week only)
 *   maxTransfers    how deep to search
 * @returns {{ baseline, options, recommendation }}
 */
export function planTransfers(squad, projections, pool, opts = {}) {
  const {
    bank = 0,
    freeTransfers = 1,
    purchasePrice = new Map(),
    horizon = 'epTotal',
    maxTransfers = 3,
    bench = BENCH_WEIGHT,
    rollValue = ROLL_VALUE,
  } = opts;

  const ep = (p) => projections.get(p.id)?.[horizon] ?? 0;
  const sellOf = (p) => sellingPrice(purchasePrice.get(p.id) ?? p.now_cost, p.now_cost);

  const searchOpts = { bank, sellOf, bench };
  const baseline = squadScore(squad, ep, { bench });

  const options = [
    {
      transfers: 0,
      out: [],
      in: [],
      squad,
      gain: 0,
      hit: 0,
      // Doing nothing banks a transfer, which is worth something in itself.
      net: freeTransfers < MAX_FREE_TRANSFERS ? rollValue : 0,
      note:
        freeTransfers < MAX_FREE_TRANSFERS
          ? `roll to ${freeTransfers + 1} free transfers`
          : 'free transfers already at the maximum, rolling banks nothing',
    },
  ];

  const single = bestSingle(squad, pool, ep, searchOpts);
  if (single.moves.length) {
    options.push(withCost(single.moves[0], 1, freeTransfers));
  }

  if (maxTransfers >= 2) {
    const pair = bestPair(squad, pool, ep, searchOpts);
    if (pair.moves.length) options.push(withCost(pair.moves[0], 2, freeTransfers));

    // A third transfer is only searched from the best pair, which is a real
    // restriction and is reported as such rather than presented as exhaustive.
    if (maxTransfers >= 3 && pair.moves.length) {
      const from = pair.moves[0];
      const third = bestSingle(from.squad, pool, ep, { ...searchOpts, bank: from.bankAfter });
      if (third.moves.length) {
        const m = third.moves[0];
        options.push(
          withCost(
            {
              out: [...from.out, ...m.out],
              in: [...from.in, ...m.in],
              squad: m.squad,
              score: m.score,
              gain: m.score - baseline,
              bankAfter: m.bankAfter,
            },
            3,
            freeTransfers
          )
        );
      }
    }
  }

  // The marginal value of each extra transfer — the number that answers
  // "is the hit worth it" directly, rather than making you subtract.
  for (let i = 1; i < options.length; i++) {
    options[i].marginal = options[i].net - options[i - 1].net;
  }

  const recommendation = options.reduce((a, b) => (b.net > a.net ? b : a));

  return {
    baseline,
    horizon,
    freeTransfers,
    options,
    recommendation,
    // Named so the UI can explain a "do nothing" recommendation, which is
    // otherwise the one output a user assumes is a bug.
    verdict: describe(recommendation, options),
  };
}

function withCost(move, transfers, freeTransfers) {
  const paid = Math.max(0, transfers - freeTransfers);
  const hit = paid * HIT_COST;
  return {
    transfers,
    out: move.out,
    in: move.in,
    squad: move.squad,
    gain: move.gain,
    hit,
    net: move.gain - hit,
    bankAfter: move.bankAfter,
    note: paid ? `${paid} hit${paid > 1 ? 's' : ''} at -${HIT_COST}` : 'within free transfers',
  };
}

function describe(rec, options) {
  if (rec.transfers === 0) {
    const best = options.find((o) => o.transfers === 1);
    if (!best) return 'No transfer improves the squad. Roll.';
    return (
      `No move clears the bar. The best single transfer gains ` +
      `${best.gain.toFixed(2)} points over the horizon` +
      (best.hit ? ` but costs a ${best.hit}-point hit` : '') +
      `, against ${rec.net.toFixed(2)} for banking the transfer. Roll.`
    );
  }
  const names = (xs) => xs.map((p) => p.web_name).join(' + ');
  return (
    `${names(rec.out)} → ${names(rec.in)}: ` +
    `${rec.gain.toFixed(2)} points over the horizon` +
    (rec.hit ? `, less a ${rec.hit}-point hit, net ${rec.net.toFixed(2)}` : ` (free), net ${rec.net.toFixed(2)}`)
  );
}

/**
 * What the squad is worth if sold — the budget a wildcard would rebuild with.
 */
export function squadValue(squad, purchasePrice = new Map(), bank = 0) {
  return (
    bank +
    squad.reduce((a, p) => a + sellingPrice(purchasePrice.get(p.id) ?? p.now_cost, p.now_cost), 0)
  );
}

/**
 * The eleven to start and who to captain, for a squad already owned.
 *
 * Separate from the transfer search because it is the one decision that must
 * be made every single week, transfers or not, and it is the cheapest points
 * in the game to get right.
 */
export function pickTeam(squad, projections, { gw = 'epNext' } = {}) {
  const ep = (p) => projections.get(p.id)?.[gw] ?? 0;
  const xi = bestXI(squad, ep);
  if (!xi) return null;
  return {
    ...xi,
    // Captaincy is worth stating explicitly: it is a doubling, so the gap
    // between the best and second-best pick is paid twice over.
    captaincyEdge: xi.captain && xi.vice ? ep(xi.captain) - ep(xi.vice) : 0,
  };
}
