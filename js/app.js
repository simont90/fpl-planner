/**
 * The interface.
 *
 * All the reasoning lives in model.js, optimiser.js, transfers.js, chips.js and
 * market.js. This file does no arithmetic of its own beyond formatting: it
 * holds the loaded data and the current squad, calls into those modules when a
 * control changes, and renders what comes back.
 *
 * One rule runs through the rendering: never show a number without letting the
 * user find out where it came from. Every player is clickable and opens the
 * component breakdown behind their projection, and anything the model
 * estimated rather than measured is marked as an estimate.
 */

import * as api from './api.js';
import { buildContext, projectAll, projectFixture, POS } from './model.js';
import { optimiseSquad, candidatePool, bestXI, BUDGET } from './optimiser.js';
import { planTransfers, pickTeam } from './transfers.js';
import { planChips } from './chips.js';
import { squadSuggestions } from './insights.js';
import { effectiveOwnership, versusField, templateSquad, predictPriceChanges } from './market.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const m = (tenths) => `£${(tenths / 10).toFixed(1)}m`;
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const signed = (x) => (x >= 0 ? `+${x.toFixed(2)}` : x.toFixed(2));

/** FPL's own five-step scale: 1 (easiest) green through 5 (hardest) red. */
const fdrClass = (fdr) => `fdr-${Math.min(5, Math.max(1, Math.round(fdr)))}`;

/**
 * A row of small colored cells, one per upcoming gameweek, on FPL's own FDR
 * scale — the fixture-difficulty ticker every FPL player already recognizes.
 * A blank gameweek renders as a grey cell; a double gameweek's cell takes the
 * harder of its two fixtures, with both named in the tooltip.
 */
function fdrTicker(pr, { max = 5, labeled = false } = {}) {
  if (!pr?.gws?.length) return null;
  return el('div', { class: `fdr-ticker${labeled ? ' labeled' : ''}` },
    pr.gws.slice(0, max).map((g) => {
      if (g.blank || !g.fixtures.length) {
        return el('span', { class: 'fdr-cell fdr-blank', title: `GW${g.gw}: blank` }, labeled ? '–' : null);
      }
      const worst = Math.max(...g.fixtures.map((f) => f.fdr));
      const label = g.fixtures.map((f) => `${f.opponent} (${f.home ? 'H' : 'A'})`).join(' + ');
      return el('span', { class: `fdr-cell ${fdrClass(worst)}`, title: `GW${g.gw}: ${label}` },
        labeled ? (g.fixtures.length > 1 ? '2 FIX' : g.fixtures[0].opponent) : null);
    })
  );
}

/**
 * `measured` (real PL data) renders no tag. `fbref-Championship` and
 * `fbref-Big5` are real goals/assists from last season elsewhere, discounted
 * for league strength — worth distinguishing from a bare price guess.
 */
function provenanceTag(pr) {
  if (!pr?.provisional) return null;
  if (pr.source === 'fbref-Championship' || pr.source === 'fbref-Big5') {
    return el('span', { class: 'tag prov fbref' }, 'fbref');
  }
  return el('span', { class: 'tag prov' }, 'est');
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const S = {
  boot: null, fixtures: null, fbref: new Map(), fbrefPL: new Map(), ctx: null,
  projections: null, players: [], pool: [],
  squad: null,          // the fifteen currently under discussion
  purchase: new Map(),  // id → price paid, when a real team is loaded
  bank: 0,
  horizon: 6,
  budget: BUDGET,
  loadedFrom: null,     // 'optimiser' | 'entry'
};

function banner(message, kind = 'warn') {
  const b = $('#banner');
  if (!message) { b.hidden = true; return; }
  b.hidden = false;
  b.className = `banner ${kind === 'error' ? 'error' : ''}`;
  b.textContent = message;
}

/**
 * Run something slow without the page appearing to have died.
 *
 * The optimiser takes a second or two of solid computation, which blocks the
 * main thread completely. Yielding twice before starting lets the browser
 * actually paint the disabled button and its label first — without it the user
 * clicks and nothing visibly happens until the answer arrives.
 */
async function busy(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    return await work();
  } catch (e) {
    banner(e.message || String(e), 'error');
    throw e;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function init() {
  try {
    const [boot, fx] = await Promise.all([api.bootstrap(), api.fixtures()]);
    S.boot = boot;
    S.fixtures = fx;
  } catch (e) {
    banner(e.message, 'error');
    $('#season-note').textContent = 'could not load data';
    return;
  }

  // A local, hand-refreshed dataset (see fbref/match.mjs) — optional, so its
  // absence must not block the page. A missing or empty file just means every
  // no-record player falls back to the price estimate, as before.
  try {
    const res = await fetch('./data/fbref.json');
    const json = res.ok ? await res.json() : {};
    S.fbref = new Map(Object.entries(json).map(([k, v]) => [Number(k), v]));
  } catch {
    S.fbref = new Map();
  }

  // Shots/conversion/tackles for every current PL player, this season only —
  // display context in the player modal, not a model input. See the note at
  // the top of fbref/match.mjs for why.
  try {
    const res = await fetch('./data/fbref-pl.json');
    const json = res.ok ? await res.json() : {};
    S.fbrefPL = new Map(Object.entries(json).map(([k, v]) => [Number(k), v]));
  } catch {
    S.fbrefPL = new Map();
  }

  reproject();

  const next = S.ctx.events.find((e) => e.id === S.ctx.nextGw);
  const deadline = next?.deadline_time ? new Date(next.deadline_time) : null;
  $('#season-note').textContent =
    (S.ctx.preSeason
      ? `Preseason — every stat below is last season's. `
      : `Gameweek ${S.ctx.currentGw} played. `) +
    `Next deadline GW${S.ctx.nextGw}` +
    (deadline ? ` · ${deadline.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '');

  if (S.ctx.preSeason) {
    banner(
      'Preseason: no matches have been played, so every projection is built from last season ' +
      'plus each squad\'s fixture list. Players with no Premier League record — promoted clubs ' +
      'and new signings — draw on real Championship or other-league form where a match was found ' +
      '(marked "fbref"), and fall back to a price estimate otherwise (marked "est").'
    );
  }
  wire();
}

function reproject() {
  S.ctx = buildContext(S.boot, S.fixtures, S.fbref);
  S.projections = projectAll(S.boot, S.ctx, { horizon: S.horizon });
  S.players = S.boot.elements.filter((p) => S.projections.has(p.id));
  S.pool = candidatePool(S.players, S.projections);
}

/* ------------------------------------------------------------------ *
 * Squad view
 * ------------------------------------------------------------------ */

function playerCard(p, { captain, vice, dimmed, flag } = {}) {
  const pr = S.projections.get(p.id);
  const team = S.ctx.teams.get(p.team)?.short_name ?? '';
  return el('div', { class: `card${dimmed ? ' out' : ''}`, onclick: () => showPlayer(p) },
    el('div', { class: 'nm' },
      p.web_name,
      captain ? el('span', { class: 'tag' }, 'C') : null,
      vice ? el('span', { class: 'tag' }, 'V') : null,
      provenanceTag(pr),
      flag ? el('span', { class: 'tag watch', title: flag }, '!') : null),
    el('div', { class: 'meta' }, `${POS[p.element_type]} · ${team} · ${m(p.now_cost)}`),
    el('div', { class: 'ep' }, f2(pr?.epNext ?? 0)),
    fdrTicker(pr, { max: 5 }),
  );
}

function renderSquad() {
  const pitch = $('#pitch');
  const bench = $('#bench');
  pitch.replaceChildren();
  bench.replaceChildren();
  if (!S.squad) {
    pitch.append(el('p', { class: 'note', style: 'color:#fff;text-align:center' },
      'Press “Build optimal squad”, or load your real team below.'));
    $('#s-suggestions').hidden = true;
    return;
  }

  const xi = pickTeam(S.squad, S.projections);

  // Computed before the cards so a flagged player can be badged directly on
  // the pitch, not just listed separately below it. Market data (pool, bank,
  // purchase prices) lets fixture-swing notes name a specific, affordable
  // replacement rather than just saying "consider transferring him".
  const notes = squadSuggestions(S.squad, xi, S.projections, S.ctx.nextGw, {
    pool: S.pool, bank: S.bank, purchasePrice: S.purchase, projections: S.projections,
  });
  const flagById = new Map(notes.filter((n) => n.playerId).map((n) => [n.playerId, n.text]));

  for (const code of ['GKP', 'DEF', 'MID', 'FWD']) {
    const line = xi.xi.filter((p) => POS[p.element_type] === code);
    if (!line.length) continue;
    pitch.append(el('div', { class: 'line' }, line.map((p) =>
      playerCard(p, { captain: p.id === xi.captain?.id, vice: p.id === xi.vice?.id, flag: flagById.get(p.id) }))));
  }
  bench.append(
    ...xi.bench.map((p) => playerCard(p, { dimmed: true, flag: flagById.get(p.id) })),
    ...(xi.benchKeeper ? [playerCard(xi.benchKeeper, { dimmed: true, flag: flagById.get(xi.benchKeeper.id) })] : []),
  );

  const cost = S.squad.reduce((a, p) => a + p.now_cost, 0);
  const ep = (p) => S.projections.get(p.id)?.epTotal ?? 0;
  $('#s-score').textContent = f1(bestXI(S.squad, ep).total);
  $('#s-cost').textContent = m(cost);
  $('#s-bank').textContent = `bank ${m(S.bank)}`;
  $('#s-next').textContent = f2(xi.total);
  $('#s-formation').textContent = `${xi.formation.name} · C ${xi.captain?.web_name ?? '—'}`;

  $('#s-suggestions').hidden = notes.length === 0;
  $('#s-suggestions-list').replaceChildren(...notes.map((n) => el('li', {}, n.text)));
}

async function doOptimise() {
  await busy($('#optimise'), 'Optimising…', async () => {
    const r = optimiseSquad(S.players, S.projections, {
      budget: S.budget, pool: S.pool, restarts: 28, polish: 8,
    });
    if (!r.squad) {
      banner(r.violation, 'error');
      return;
    }
    S.squad = r.squad;
    S.purchase = new Map(r.squad.map((p) => [p.id, p.now_cost]));
    S.bank = S.budget - r.cost;
    S.loadedFrom = 'optimiser';
    banner('');
    renderSquad();
    $('#s-converged').textContent = `${r.converged}/${r.finalists}`;
    $('#t-bank').value = (S.bank / 10).toFixed(1);
  });
}

/* ------------------------------------------------------------------ *
 * Loading a real team
 * ------------------------------------------------------------------ */

async function doLoadTeam() {
  const id = Number($('#entry-id').value);
  if (!id) { $('#load-status').textContent = 'Enter your numeric FPL team id.'; return; }

  await busy($('#load-team'), 'Loading…', async () => {
    const res = await api.loadSquad(id, S.boot);
    if (!res.ok) { $('#load-status').textContent = res.message; return; }

    const byId = new Map(S.players.map((p) => [p.id, p]));
    const squad = res.picks.map((pk) => byId.get(pk.element)).filter(Boolean);
    if (squad.length !== 15) {
      $('#load-status').textContent =
        `FPL returned ${squad.length} of 15 players — some are no longer selectable this season.`;
      return;
    }
    S.squad = squad;
    S.purchase = new Map(res.picks.map((pk) => [pk.element, pk.purchase_price ?? pk.selling_price]));
    S.bank = res.bank;
    S.loadedFrom = 'entry';
    $('#t-bank').value = (S.bank / 10).toFixed(1);
    $('#load-status').textContent =
      `Loaded ${res.profile.name} (${res.profile.player_first_name} ${res.profile.player_last_name}) ` +
      `after GW${res.gw}. Squad value ${m(res.value)}, bank ${m(res.bank)}.`;
    $('#s-converged').textContent = '—';
    renderSquad();
  });
}

/* ------------------------------------------------------------------ *
 * Transfers
 * ------------------------------------------------------------------ */

async function doTransfers() {
  if (!requireSquad()) return;
  await busy($('#t-run'), 'Searching…', async () => {
    const plan = planTransfers(S.squad, S.projections, S.pool, {
      bank: Math.round(Number($('#t-bank').value) * 10),
      freeTransfers: Number($('#t-ft').value),
      purchasePrice: S.purchase,
      horizon: 'epTotal',
    });

    $('#t-verdict').textContent = plan.verdict;

    const rows = plan.options.map((o) => el('tr', { onclick: () => o.squad && applySquad(o.squad) },
      el('td', {}, o.transfers === 0 ? 'Roll' : `${o.transfers} transfer${o.transfers > 1 ? 's' : ''}`),
      el('td', {}, o.transfers === 0 ? '—' : o.out.map((p) => p.web_name).join(' + ')),
      el('td', {}, o.transfers === 0 ? '—' : o.in.map((p) => p.web_name).join(' + ')),
      el('td', { class: 'num' }, f2(o.gain)),
      el('td', { class: 'num' }, o.hit ? `−${o.hit}` : '0'),
      el('td', { class: `num ${o.net >= 0 ? 'good' : 'bad'}` }, f2(o.net)),
      el('td', { class: `num ${(o.marginal ?? 0) >= 0 ? 'good' : 'bad'}` },
        o.marginal === undefined ? '—' : signed(o.marginal)),
      el('td', {}, o === plan.recommendation ? '◀ best' : ''),
    ));

    $('#t-options').replaceChildren(el('div', { class: 'scroll' },
      el('table', {},
        el('caption', {}, 'Click a row to adopt that squad'),
        el('thead', {}, el('tr', {},
          el('th', {}, 'Depth'), el('th', {}, 'Out'), el('th', {}, 'In'),
          el('th', { class: 'num' }, 'Gain'), el('th', { class: 'num' }, 'Hit'),
          el('th', { class: 'num' }, 'Net'), el('th', { class: 'num' }, 'Marginal'), el('th', {}, ''))),
        el('tbody', {}, rows))));
  });
}

function applySquad(squad) {
  S.squad = squad;
  renderSquad();
  showTab('squad');
}

/* ------------------------------------------------------------------ *
 * Chips
 * ------------------------------------------------------------------ */

async function doChips() {
  if (!requireSquad()) return;
  await busy($('#c-run'), 'Scoring…', async () => {
    const plan = planChips(S.squad, S.projections, S.players, S.ctx, {
      pool: S.pool, horizon: S.horizon, purchasePrice: S.purchase, bank: S.bank,
    });

    $('#c-advice').replaceChildren(el('ul', { class: 'advice' },
      plan.advice.map((a) => el('li', {}, a))));

    const tables = [];
    tables.push(table('Bench Boost — worth the bench that week',
      ['Gameweek', 'Points added', 'Bench'],
      plan.benchBoost.slice(0, 6).map((b) => [
        `GW${b.gw}`, f2(b.value), b.detail.map((d) => `${d.name} ${f1(d.ep)}`).join(', ')]),
      [1]));

    tables.push(table('Triple Captain — one further copy of the captain',
      ['Gameweek', 'Points added', 'Captain'],
      plan.tripleCaptain.slice(0, 6).map((t) => [`GW${t.gw}`, f2(t.value), t.captain?.name ?? '—']),
      [1]));

    if (plan.freeHit.length) {
      tables.push(table('Free Hit — best one-week squad, then everything reverts',
        ['Gameweek', 'Points added', 'Your XI', 'Best available'],
        plan.freeHit.map((f) => [`GW${f.gw}`, f2(f.value), f2(f.current), f2(f.best)]),
        [1, 2, 3]));
    }

    if (plan.wildcard) {
      tables.push(table('Wildcard — a permanent rebuild, measured over the horizon',
        ['Budget', 'Current squad', 'Rebuilt', 'Points added'],
        [[m(plan.wildcard.budget), f2(plan.wildcard.current), f2(plan.wildcard.rebuilt), f2(plan.wildcard.gain)]],
        [1, 2, 3]));
    }

    tables.push(table('Fixture calendar',
      ['Gameweek', 'Fixtures', 'Blanks', 'Doubles'],
      plan.shape.map((s) => [`GW${s.gw}`, s.fixtures, s.blanks.join(' ') || '—', s.doubles.join(' ') || '—']),
      [1]));

    $('#c-tables').replaceChildren(...tables);
  });
}

/* ------------------------------------------------------------------ *
 * Vs field
 * ------------------------------------------------------------------ */

async function doField() {
  if (!requireSquad()) return;
  await busy($('#f-run'), 'Comparing…', async () => {
    const eo = effectiveOwnership(S.players, S.projections);
    const vf = versusField(S.squad, S.players, S.projections, eo);
    const tpl = templateSquad(S.players, S.projections);

    $('#f-summary').replaceChildren(
      stat('Your XI', f2(vf.you), `gameweek ${S.ctx.nextGw} projection`),
      stat('Average manager', f2(vf.field), 'ownership-weighted'),
      stat('Margin', signed(vf.margin), vf.margin >= 0 ? 'ahead of the field' : 'behind the field'),
    );

    const tables = [];
    tables.push(table('Where you gain on the field',
      ['Player', 'Pos', 'Projection', 'You', 'Field', 'Edge'],
      vf.differentials.map((d) => [d.name, d.pos, f2(d.ep), d.yours, f2(d.field), signed(d.edge)]),
      [2, 3, 4, 5]));

    tables.push(table('Where the field gains on you — players you do not own',
      ['Player', 'Pos', 'Projection', 'You', 'Field', 'Edge'],
      vf.risks.map((d) => [d.name, d.pos, f2(d.ep), d.yours, f2(d.field), signed(d.edge)]),
      [2, 3, 4, 5]));

    const price = predictPriceChanges(S.players, S.boot.total_players);
    tables.push(price.dormant
      ? el('p', { class: 'verdict' }, `Price changes: ${price.reason}`)
      : table('Price pressure',
          ['Player', 'Ownership', 'Net transfers', 'Pressure'],
          [...price.rises.slice(0, 8), ...price.falls.slice(0, 8)]
            .map((r) => [r.name, `${f1(r.ownership)}%`, r.net.toLocaleString(), f2(r.pressure)]),
          [1, 2, 3]));

    tables.push(table(
      `The template — what the field owns${tpl.buildable ? '' : ` (${m(tpl.cost)}, not a squad anyone can actually buy)`}`,
      ['Player', 'Pos', 'Ownership', 'Projection'],
      tpl.ownership.map((o) => [o.name, o.pos, `${f1(o.ownership)}%`, f2(o.ep)]),
      [2, 3]));

    $('#f-tables').replaceChildren(...tables);
  });
}

/* ------------------------------------------------------------------ *
 * Players
 * ------------------------------------------------------------------ */

function renderPlayers() {
  const q = $('#p-search').value.trim().toLowerCase();
  const posFilter = $('#p-pos').value;
  const sort = $('#p-sort').value;
  const availOnly = $('#p-avail').checked;

  const key = (p) => {
    const pr = S.projections.get(p.id);
    switch (sort) {
      case 'epNext': return pr.epNext;
      case 'value': return pr.epTotal / (p.now_cost / 10);
      case 'ownership': return parseFloat(p.selected_by_percent) || 0;
      case 'cost': return p.now_cost;
      default: return pr.epTotal;
    }
  };

  const rows = S.players
    .filter((p) => !posFilter || POS[p.element_type] === posFilter)
    .filter((p) => !availOnly || (S.projections.get(p.id)?.availability ?? 0) > 0)
    .filter((p) => {
      if (!q) return true;
      const team = S.ctx.teams.get(p.team)?.name?.toLowerCase() ?? '';
      const short = S.ctx.teams.get(p.team)?.short_name?.toLowerCase() ?? '';
      return p.web_name.toLowerCase().includes(q) || team.includes(q) || short.includes(q);
    })
    .sort((a, b) => key(b) - key(a))
    .slice(0, 120);

  const body = rows.map((p) => {
    const pr = S.projections.get(p.id);
    const owned = S.squad?.some((s) => s.id === p.id);
    return el('tr', { onclick: () => showPlayer(p) },
      el('td', {}, p.web_name, provenanceTag(pr),
        owned ? el('span', { class: 'tag' }, 'owned') : null),
      el('td', {}, el('span', { class: 'pos' }, POS[p.element_type])),
      el('td', {}, S.ctx.teams.get(p.team)?.short_name ?? ''),
      el('td', {}, fdrTicker(pr, { max: 5, labeled: true })),
      el('td', { class: 'num' }, m(p.now_cost)),
      el('td', { class: 'num' }, f2(pr.epNext)),
      el('td', { class: 'num' }, f2(pr.epTotal)),
      el('td', { class: 'num' }, f2(pr.epTotal / (p.now_cost / 10))),
      el('td', { class: 'num' }, `${f1(parseFloat(p.selected_by_percent) || 0)}%`),
      el('td', { class: 'num' }, `${Math.round(pr.availability * 100)}%`),
    );
  });

  $('#p-table').replaceChildren(el('div', { class: 'scroll' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Player'), el('th', {}, 'Pos'), el('th', {}, 'Club'), el('th', {}, 'Fixtures'),
        el('th', { class: 'num' }, 'Price'), el('th', { class: 'num' }, 'Next GW'),
        el('th', { class: 'num' }, `${S.horizon} GWs`), el('th', { class: 'num' }, 'Per £m'),
        el('th', { class: 'num' }, 'Owned'), el('th', { class: 'num' }, 'Fit'))),
      el('tbody', {}, body))));
}

/* ------------------------------------------------------------------ *
 * Player detail
 * ------------------------------------------------------------------ */

function showPlayer(p) {
  const pr = S.projections.get(p.id);
  const team = S.ctx.teams.get(p.team);

  const parts = nextFixtureBreakdown(p, pr);

  const body = $('#modal-body');
  // Unlike el()'s own kids handling, Node.replaceChildren() does not skip
  // null/undefined children — it stringifies them into a literal "null" text
  // node — so the falsy branches below have to be filtered out first.
  body.replaceChildren(...[
    el('h3', {}, `${p.first_name} ${p.second_name}`),
    el('p', { class: 'note' },
      `${POS[p.element_type]} · ${team?.name} · ${m(p.now_cost)} · owned by ${p.selected_by_percent}%`,
      p.status !== 'a' ? ` · ${p.news || 'flagged'}` : ''),

    pr.provisional
      ? el('p', { class: 'verdict' },
          pr.source === 'fbref-Championship' || pr.source === 'fbref-Big5'
            ? 'This player has no Premier League record to read a rate from — a promoted-club ' +
              `player or a new signing. His goals and assists come from his actual ${pr.source === 'fbref-Championship' ? 'Championship' : 'other-league'} ` +
              'form last season (FBref), discounted for league strength; everything else about ' +
              'his projection still comes from his price.'
            : 'This player has no Premier League record to read a rate from — a promoted-club ' +
              'player or a new signing. His projection is estimated from his price, which is what ' +
              'FPL\'s own compilers expect of him. Treat it as a prior, not a measurement.')
      : null,

    el('div', { class: 'row compact' },
      stat('Next GW', f2(pr.epNext), 'projected points'),
      stat(`${S.horizon} GWs`, f2(pr.epTotal), 'discounted total'),
      stat('Minutes', `${Math.round(pr.minutes.p60 * 100)}%`, 'chance of 60+'),
    ),

    parts ? el('div', {}, el('h3', {}, 'Where the next gameweek comes from'), bars(parts)) : null,

    el('h3', {}, 'Fixtures'),
    el('div', { class: 'scroll' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'GW'), el('th', {}, 'Opponent'), el('th', { class: 'num' }, 'Difficulty'),
        el('th', { class: 'num' }, 'Projected'))),
      el('tbody', {}, pr.gws.map((g) => el('tr', {},
        el('td', {}, `GW${g.gw}`),
        el('td', {}, g.blank ? '— blank —'
          : g.fixtures.map((f) => `${f.opponent} (${f.home ? 'H' : 'A'})`).join(', ')),
        el('td', { class: 'num' },
          g.fixtures.length
            ? g.fixtures.map((f) => el('span', { class: `fdr-badge ${fdrClass(f.fdr)}` }, String(f.fdr)))
            : '—'),
        el('td', { class: 'num' }, f2(g.ep)),
      )))))
  ].filter(Boolean));
  const profileEl = playerProfile(p);
  if (profileEl) body.append(profileEl);
  $('#modal').hidden = false;
}

/**
 * Shots, conversion rate and defensive actions from FBref, this season only
 * — profile context alongside the modelled projection above, not part of it.
 * Only exists for current PL players FBref could be matched to (see
 * fbref/match.mjs); most squads will have this for their nailed-on players
 * and not for fringe ones.
 */
function playerProfile(p) {
  const pf = S.fbrefPL.get(p.id);
  if (!pf) return null;
  const per90 = (v) => (pf.minutes ? (v / pf.minutes) * 90 : 0);

  // The two captures (shots, defensive actions) were trimmed independently,
  // so a player can have one and not the other — shown only where present
  // rather than defaulting a missing stat to a misleading zero.
  const tiles = [];
  if (pf.shots != null) {
    tiles.push(stat('Shots/90', f2(per90(pf.shots)), `${pf.shotsOnTargetPct}% on target`));
    tiles.push(stat('Goals/shot', pf.goalsPerShot.toFixed(2), 'conversion rate'));
  }
  if (pf.tacklesWon != null && pf.interceptions != null) {
    tiles.push(stat('Tkl+Int/90', f2(per90(pf.tacklesWon + pf.interceptions)), `${pf.tacklesWon} tackles, ${pf.interceptions} int.`));
  }
  if (!tiles.length) return null;

  return el('div', {},
    el('h3', {}, 'Underlying (FBref, 2025-26)'),
    el('p', { class: 'note' },
      `From ${pf.minutes} Premier League minutes last season — shown as extra context, not fed into the projection above.`),
    el('div', { class: 'row compact' }, tiles));
}

/**
 * The component parts behind a player's next gameweek: appearance, goals,
 * assists, clean sheet, defensive contribution, saves, bonus, cards.
 *
 * The whole point of the model returning a breakdown alongside a total is that
 * no number in this interface has to be taken on trust, so this re-runs the
 * projection for the actual fixture in front of him and shows the parts. A
 * blank gameweek has no fixture and therefore nothing to break down.
 */
function nextFixtureBreakdown(p, pr) {
  const first = pr.gws.find((g) => g.fixtures.length);
  if (!first) return null;

  const upcoming = (S.ctx.fixturesByTeam.get(p.team) || [])
    .filter((f) => f.gw === first.gw && !f.finished);
  if (!upcoming.length) return null;

  // A double gameweek has two fixtures; the parts add across both, which is
  // exactly how the projection totals them.
  const totals = {};
  for (const f of upcoming) {
    for (const [k, v] of Object.entries(projectFixture(p, f, S.ctx).parts)) {
      totals[k] = (totals[k] || 0) + v;
    }
  }
  return totals;
}

/* ------------------------------------------------------------------ *
 * Small render helpers
 * ------------------------------------------------------------------ */

function stat(k, v, sub) {
  return el('div', { class: 'stat' },
    el('span', { class: 'k' }, k), el('b', {}, v), el('i', {}, sub ?? ''));
}

function bars(parts) {
  const max = Math.max(...Object.values(parts).map((v) => Math.abs(v)), 0.01);
  return el('div', { class: 'bars' }, Object.entries(parts).map(([k, v]) =>
    el('div', { class: 'bar' },
      el('span', {}, k),
      el('span', { class: 'track' },
        el('span', { class: `fill${v < 0 ? ' neg' : ''}`, style: `width:${(Math.abs(v) / max) * 100}%` })),
      el('span', { class: 'v' }, f2(v)))));
}

function table(caption, headers, rows, numericCols = []) {
  return el('div', { class: 'scroll' }, el('table', {},
    el('caption', {}, caption),
    el('thead', {}, el('tr', {}, headers.map((h, i) =>
      el('th', { class: numericCols.includes(i) ? 'num' : '' }, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) =>
      el('td', { class: numericCols.includes(i) ? 'num' : '' }, c)))))));
}

function requireSquad() {
  if (S.squad) return true;
  banner('Build a squad first — press “Build optimal squad”, or load your real team on the Squad tab.');
  showTab('squad');
  return false;
}

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === `tab-${name}`);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function wire() {
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      showTab(b.dataset.tab);
      if (b.dataset.tab === 'players') renderPlayers();
    });
  }

  $('#optimise').addEventListener('click', doOptimise);
  $('#load-team').addEventListener('click', doLoadTeam);
  $('#t-run').addEventListener('click', doTransfers);
  $('#c-run').addEventListener('click', doChips);
  $('#f-run').addEventListener('click', doField);

  $('#horizon').addEventListener('change', (e) => {
    S.horizon = Number(e.target.value);
    reproject();
    // The squad holds element objects from the previous projection pass; they
    // are the same objects, so only the numbers behind them have moved.
    renderSquad();
    if ($('#tab-players').classList.contains('active')) renderPlayers();
  });
  $('#budget').addEventListener('change', (e) => {
    S.budget = Math.round(Number(e.target.value) * 10);
  });

  for (const id of ['#p-search', '#p-pos', '#p-sort', '#p-avail']) {
    $(id).addEventListener('input', renderPlayers);
  }

  $('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').hidden = true; });

  renderSquad();
  renderPlayers();
}

init();
