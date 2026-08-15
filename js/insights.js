/**
 * Squad suggestions.
 *
 * Not a separate model, and nothing here is an LLM call — this is a
 * rule-based reading of the projections, fixtures and transfer machinery
 * every other view already computed. Every suggestion traces back to a
 * number already on screen elsewhere in the app: a fixture run about to
 * turn (paired with the specific replacement it's worth timing against), a
 * blank inside the horizon, a bench player who has quietly overtaken a
 * starter, and a squad player still resting entirely on a price guess.
 *
 * Each entry carries an optional `playerId` so the Squad view can badge the
 * card it's about, not just list it separately below the pitch.
 */

import { POS } from './model.js';
import { replacementsFor, clubTally, sellingPrice } from './transfers.js';

/** FPL's own scale: 4 and 5 are the two "hard" fixture ratings. */
const HARD_FDR = 4;

/** How much higher a bench player's next-GW projection must be to flag a swap. */
const LINEUP_GAP = 0.5;

/** A named replacement has to clear this margin — from the swing gameweek
 * onward, not overall — to be worth surfacing over "no clear upgrade". */
const SWAP_GAP = 1.0;

const worstFdr = (g) => (g.fixtures.length ? Math.max(...g.fixtures.map((f) => f.fdr)) : 0);

/** Points a player is projected from gameweek `fromGw` to the end of the
 * horizon already computed into `pr.gws` — what actually matters for timing
 * a transfer against a specific future fixture swing, not his full-horizon
 * total which is dominated by the weeks before it. */
function valueFrom(pr, fromGw) {
  return pr.gws.filter((g) => g.gw >= fromGw).reduce((a, g) => a + g.ep, 0);
}

/**
 * @param squad         the 15
 * @param xi            pickTeam(squad, projections) result, reused from the
 *                       Squad view so the lineup check agrees with what's on
 *                       the pitch rather than recomputing its own answer
 * @param projections   id → projectPlayer() result
 * @param nextGw
 * @param market        { pool, bank, purchasePrice } — omit to skip named
 *                       replacement suggestions (still works, just without
 *                       naming who to bring in)
 * @returns {{ text: string, playerId?: number, gw?: number }[]}
 */
export function squadSuggestions(squad, xi, projections, nextGw, market = null) {
  const notes = [];
  const clubs = market ? clubTally(squad) : null;
  const inSquad = new Set(squad.map((p) => p.id));
  const sellOf = market
    ? (p) => sellingPrice(market.purchasePrice?.get(p.id) ?? p.now_cost, p.now_cost)
    : null;

  for (const p of squad) {
    const pr = projections.get(p.id);
    if (!pr) continue;

    // A fixture run that turns hard partway through the horizon is worth
    // timing a transfer against — reacting after it starts is a week late.
    for (let i = 0; i < pr.gws.length - 1; i++) {
      if (worstFdr(pr.gws[i]) >= HARD_FDR && worstFdr(pr.gws[i + 1]) >= HARD_FDR) {
        const swingGw = pr.gws[i].gw;
        if (swingGw > nextGw) {
          notes.push(swapNote(p, pr, swingGw, market, { clubs, inSquad, sellOf }));
        }
        break;
      }
    }

    const blankGw = pr.gws.find((g) => g.blank);
    if (blankGw) {
      notes.push({ text: `${p.web_name} has no fixture in GW${blankGw.gw} — make sure your bench covers that week.`, playerId: p.id, gw: blankGw.gw });
    }

    if (pr.provisional && pr.source === 'price') {
      notes.push({ text: `${p.web_name} has no record at all yet, not even from FBref — his projection is a price guess. Reassess once he's actually played.`, playerId: p.id });
    }
  }

  // Two or more swings worth timing — check whether bunching them into one
  // double transfer beats taking a hit for each separately.
  notes.push(...bankingNote(notes));

  // A bench player projecting higher than the weakest starter in his
  // position, for the very next gameweek only — a lineup call, not a
  // transfer one.
  if (xi?.xi && xi?.bench) {
    for (const code of ['GKP', 'DEF', 'MID', 'FWD']) {
      const starters = xi.xi.filter((p) => POS[p.element_type] === code);
      const benchPool = [...xi.bench, xi.benchKeeper].filter(Boolean).filter((p) => POS[p.element_type] === code);
      if (!starters.length || !benchPool.length) continue;
      const epNext = (p) => projections.get(p.id)?.epNext ?? 0;
      const worstStarter = [...starters].sort((a, b) => epNext(a) - epNext(b))[0];
      const bestBench = [...benchPool].sort((a, b) => epNext(b) - epNext(a))[0];
      if (epNext(bestBench) > epNext(worstStarter) + LINEUP_GAP) {
        notes.push({
          text: `${bestBench.web_name} on your bench projects higher than ${worstStarter.web_name} in your ` +
            `starting XI for GW${nextGw} (${epNext(bestBench).toFixed(1)} vs ${epNext(worstStarter).toFixed(1)}) — ` +
            'check your lineup before the deadline.',
          playerId: bestBench.id,
        });
      }
    }
  }

  // What to watch in the next two gameweeks: the hardest and easiest single
  // fixture among players who will actually be on the pitch. Scanning the
  // full 15 here was wrong — it surfaced the reserve keeper's fixture
  // alongside the starter's as if the two were comparable, when he only
  // plays at all if the starter doesn't. Whoever's currently in the XI is a
  // reasonable stand-in for "will play" even into future gameweeks; it isn't
  // exact if the lineup changes, but it's a far better guess than "owned".
  const likelyToPlay = xi?.xi?.length ? xi.xi : squad;
  for (const gw of [nextGw, nextGw + 1]) {
    const fixturesThisGw = likelyToPlay
      .map((p) => {
        const g = projections.get(p.id)?.gws.find((g) => g.gw === gw);
        if (!g?.fixtures.length) return null;
        const worst = g.fixtures.reduce((a, b) => (b.fdr > a.fdr ? b : a));
        return { p, fdr: worst.fdr, opponent: worst.opponent, home: worst.home };
      })
      .filter(Boolean);
    if (!fixturesThisGw.length) continue;
    const hardest = fixturesThisGw.reduce((a, b) => (b.fdr > a.fdr ? b : a));
    const easiest = fixturesThisGw.reduce((a, b) => (b.fdr < a.fdr ? b : a));
    notes.push({
      text: `GW${gw} — toughest: ${hardest.p.web_name} ${hardest.home ? 'vs' : 'at'} ${hardest.opponent} (FDR ${hardest.fdr}). ` +
        (easiest.p.id !== hardest.p.id
          ? `Best: ${easiest.p.web_name} ${easiest.home ? 'vs' : 'at'} ${easiest.opponent} (FDR ${easiest.fdr}).`
          : ''),
      gw,
    });
  }

  return notes;
}

/**
 * The fixture-swing note for one player, naming the best legal, affordable
 * replacement — ranked by points from the swing gameweek onward, since
 * that's what the transfer is actually timed against, not his full-horizon
 * total which is dominated by the weeks before the swing.
 */
function swapNote(p, pr, swingGw, market, { clubs, inSquad, sellOf }) {
  const base = { text: `${p.web_name}'s fixtures turn hard from GW${swingGw} (two in a row rated ${HARD_FDR}+)`, playerId: p.id, gw: swingGw, name: p.web_name };
  if (!market) return { ...base, text: base.text + ' — worth lining up his replacement before then rather than after.' };

  // Points from the swing gameweek onward, not the usual full-horizon total
  // — that's what the transfer is actually timed against. Falls back to zero
  // for a candidate with no projection rather than throwing.
  const valueFromGw = (player) => valueFrom(market.projections.get(player.id) || { gws: [] }, swingGw);

  const ctx = { inSquad, budgetFor: market.bank, clubs, sellOf };
  const candidates = replacementsFor(p, market.pool, valueFromGw, ctx);
  const outValue = valueFrom(pr, swingGw);
  const best = candidates.find((c) => valueFromGw(c) > outValue + SWAP_GAP);

  if (!best) {
    return { ...base, text: base.text + ' — no clear affordable upgrade in your pool right now; worth checking again closer to the time.' };
  }
  return {
    ...base,
    text: `${base.text} — consider ${p.web_name} → ${best.web_name} (£${(best.now_cost / 10).toFixed(1)}m, ` +
      `+${(valueFromGw(best) - outValue).toFixed(1)} pts from GW${swingGw}).`,
  };
}

/**
 * When two or more swap suggestions cluster together, taking a separate hit
 * for each is rarely the cheapest way to make all the moves. Two cases:
 * two players swinging in the *same* gameweek are worth transferring
 * together there and then; two swinging in nearby but different gameweeks
 * are worth bunching by banking the nearer one and doubling up at the later
 * date. This is a fixed rule of thumb, not a search over every banking
 * schedule — it only ever proposes bunching the two nearest swings.
 */
function bankingNote(notesSoFar) {
  const swings = notesSoFar
    .filter((n) => n.name && n.text.includes('fixtures turn hard'))
    .sort((a, b) => a.gw - b.gw);
  if (swings.length < 2) return [];

  const sameGw = swings.find((n, i) => i > 0 && n.gw === swings[i - 1].gw);
  if (sameGw) {
    const partner = swings[swings.indexOf(sameGw) - 1];
    return [{
      text: `${partner.name} and ${sameGw.name} both need moving in GW${sameGw.gw} — worth doing as one ` +
        `double transfer that week rather than two separate ones.`,
      gw: sameGw.gw,
    }];
  }

  const [first, second] = swings;
  if (second.gw - first.gw > 4) return []; // too far apart to sensibly bunch
  return [{
    text: `Both ${first.name} and ${second.name} need moving inside a few weeks of ` +
      `each other (GW${first.gw} and GW${second.gw}) — banking this week's transfer and making both as a double ` +
      `in GW${second.gw} costs one 4-point hit instead of two separate ones.`,
    gw: second.gw,
  }];
}
