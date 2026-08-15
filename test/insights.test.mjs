/**
 * squadSuggestions is a rule-based reading of projections/fixtures other
 * views already computed, so these tests build minimal fixtures directly
 * rather than pulling in the full bootstrap snapshot — the point is the
 * rules, not the data. Each suggestion is now a structured object
 * ({ text, playerId?, gw? }), not a bare string, so the Squad view can badge
 * the specific card a suggestion is about.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { squadSuggestions } from '../js/insights.js';

const gw = (n, fdr, { blank = false, ep = 3 } = {}) => ({
  gw: n,
  blank,
  ep,
  fixtures: blank ? [] : [{ fdr, opponent: 'OPP', home: true }],
});

test('flags a fixture run turning hard partway through the horizon', () => {
  const p = { id: 1, web_name: 'Testman', element_type: 3 };
  const projections = new Map([
    [1, { provisional: false, gws: [gw(1, 2), gw(2, 2), gw(3, 4), gw(4, 5)] }],
  ]);
  const notes = squadSuggestions([p], null, projections, 1);
  assert.ok(notes.some((n) => n.text.includes('Testman') && n.text.includes('GW3') && n.playerId === 1));
});

test('does not flag a run that is already hard at the next gameweek — nothing to time it against', () => {
  const p = { id: 1, web_name: 'Testman', element_type: 3 };
  const projections = new Map([
    [1, { provisional: false, gws: [gw(1, 5), gw(2, 5), gw(3, 2)] }],
  ]);
  const notes = squadSuggestions([p], null, projections, 1);
  assert.ok(!notes.some((n) => n.text.includes('turn hard')));
});

test('flags a squad player with no record at all, but not one with an FBref-sourced estimate', () => {
  const guess = { id: 1, web_name: 'PriceGuess', element_type: 4 };
  const fbref = { id: 2, web_name: 'FbrefBacked', element_type: 4 };
  const projections = new Map([
    [1, { provisional: true, source: 'price', gws: [gw(1, 3)] }],
    [2, { provisional: true, source: 'fbref-Championship', gws: [gw(1, 3)] }],
  ]);
  const notes = squadSuggestions([guess, fbref], null, projections, 1);
  assert.ok(notes.some((n) => n.text.includes('PriceGuess') && n.text.includes('price guess')));
  assert.ok(!notes.some((n) => n.text.includes('FbrefBacked')));
});

test('reports the hardest and easiest fixture actually in the squad for the next gameweek', () => {
  const easy = { id: 1, web_name: 'Easy', element_type: 2 };
  const hard = { id: 2, web_name: 'Hard', element_type: 2 };
  const projections = new Map([
    [1, { provisional: false, gws: [gw(1, 2)] }],
    [2, { provisional: false, gws: [gw(1, 5)] }],
  ]);
  const notes = squadSuggestions([easy, hard], null, projections, 1);
  const summary = notes.find((n) => n.text.startsWith('GW1'));
  assert.ok(summary.text.includes('Hard') && summary.text.includes('toughest'));
  assert.ok(summary.text.includes('Easy') && summary.text.includes('Best'));
});

test('the toughest/easiest fixture note only looks at the starting XI, not a benched reserve who rarely plays', () => {
  const starter = { id: 1, web_name: 'Starter', element_type: 1 };
  const reserveGk = { id: 2, web_name: 'ReserveGK', element_type: 1 };
  const projections = new Map([
    [1, { provisional: false, gws: [gw(1, 4)] }],
    [2, { provisional: false, gws: [gw(1, 2)] }], // a much easier fixture, but he won't play it
  ]);
  const xi = { xi: [starter], bench: [], benchKeeper: reserveGk };
  const notes = squadSuggestions([starter, reserveGk], xi, projections, 1);
  const summary = notes.find((n) => n.text.startsWith('GW1'));
  assert.ok(!summary.text.includes('ReserveGK'), 'the bench keeper is not a real alternative just because his fixture is easier');
  assert.ok(summary.text.includes('Starter'));
});

test('flags a bench player projecting well above the weakest starter in his position', () => {
  const weakStarter = { id: 1, web_name: 'WeakStarter', element_type: 3 };
  const strongBench = { id: 2, web_name: 'StrongBench', element_type: 3 };
  const projections = new Map([
    [1, { provisional: false, epNext: 1.0, gws: [gw(1, 3)] }],
    [2, { provisional: false, epNext: 4.0, gws: [gw(1, 3)] }],
  ]);
  const xi = { xi: [weakStarter], bench: [strongBench], benchKeeper: null };
  const notes = squadSuggestions([weakStarter, strongBench], xi, projections, 1);
  assert.ok(notes.some((n) => n.text.includes('StrongBench') && n.text.includes('WeakStarter')));
});

test('a fixture-swing note names a specific, affordable replacement when market data is provided', () => {
  const out = { id: 1, web_name: 'Testman', element_type: 3, team: 1, now_cost: 60 };
  const cand = { id: 2, web_name: 'Replacement', element_type: 3, team: 2, now_cost: 55 };
  const projections = new Map([
    [1, { provisional: false, gws: [gw(1, 2), gw(2, 2), gw(3, 4, { ep: 1 }), gw(4, 5, { ep: 1 })] }],
    [2, { provisional: false, gws: [gw(1, 2), gw(2, 2), gw(3, 2, { ep: 4 }), gw(4, 2, { ep: 4 })] }],
  ]);
  const market = { pool: [cand], bank: 0, purchasePrice: new Map(), projections };
  const notes = squadSuggestions([out], null, projections, 1, market);
  const swing = notes.find((n) => n.text.includes('turn hard'));
  assert.ok(swing.text.includes('Replacement'), 'must name the specific replacement');
  assert.ok(swing.text.includes('GW3'));
});

test('a fixture-swing note says so plainly when no affordable upgrade exists', () => {
  const out = { id: 1, web_name: 'Testman', element_type: 3, team: 1, now_cost: 60 };
  const worse = { id: 2, web_name: 'Worse', element_type: 3, team: 2, now_cost: 55 };
  const projections = new Map([
    [1, { provisional: false, gws: [gw(1, 2), gw(2, 2), gw(3, 4, { ep: 3 }), gw(4, 5, { ep: 3 })] }],
    [2, { provisional: false, gws: [gw(1, 2), gw(2, 2), gw(3, 2, { ep: 1 }), gw(4, 2, { ep: 1 })] }],
  ]);
  const market = { pool: [worse], bank: 0, purchasePrice: new Map(), projections };
  const notes = squadSuggestions([out], null, projections, 1, market);
  const swing = notes.find((n) => n.text.includes('turn hard'));
  assert.ok(swing.text.includes('no clear affordable upgrade'));
  assert.ok(!swing.text.includes('Worse'));
});

test('suggests banking a transfer to double up when two swings fall in different but nearby gameweeks', () => {
  const a = { id: 1, web_name: 'PlayerA', element_type: 3 };
  const b = { id: 2, web_name: 'PlayerB', element_type: 4 };
  const projections = new Map([
    [1, { provisional: false, gws: [gw(1, 2), gw(2, 2), gw(3, 4), gw(4, 5)] }],
    [2, { provisional: false, gws: [gw(1, 2), gw(2, 2), gw(3, 2), gw(4, 4), gw(5, 5)] }],
  ]);
  const notes = squadSuggestions([a, b], null, projections, 1);
  const note = notes.find((n) => n.text.includes('PlayerA') && n.text.includes('PlayerB'));
  assert.ok(note.text.includes('double') && note.text.includes('banking'));
  assert.ok(!note.text.includes('GW3 and GW3'), 'must not report the same gameweek twice');
});

test('suggests one double transfer, not a nonsensical "GWX and GWX", when two swings land in the same gameweek', () => {
  const a = { id: 1, web_name: 'PlayerA', element_type: 3 };
  const b = { id: 2, web_name: 'PlayerB', element_type: 4 };
  const projections = new Map([
    [1, { provisional: false, gws: [gw(1, 2), gw(2, 2), gw(3, 4), gw(4, 5)] }],
    [2, { provisional: false, gws: [gw(1, 2), gw(2, 2), gw(3, 4), gw(4, 5)] }],
  ]);
  const notes = squadSuggestions([a, b], null, projections, 1);
  const note = notes.find((n) => n.text.includes('PlayerA') && n.text.includes('PlayerB'));
  assert.ok(note.text.includes('GW3'));
  assert.ok(!note.text.includes('GW3 and GW3'), 'must not report the same gameweek twice');
  assert.ok(!note.text.includes('banking'), 'nothing to bank — both swings land the same week');
});
