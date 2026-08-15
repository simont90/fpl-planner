/**
 * fbref/match.mjs — parsing and matching are the two places this pipeline can
 * silently produce nonsense: a shifted column, or a name paired with the
 * wrong row. Both fail quietly (a plausible-looking wrong number, not a
 * crash), so they're worth pinning down against fixtures shaped like the
 * real captures rather than trusting a passing run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, parseCsv, parseChampionshipDump, matchPlayers,
  parsePLShotsDump, parsePLDefenseDump, matchProfiles,
} from '../fbref/match.mjs';
import { buildContext, projectFixture, _internals } from '../js/model.js';
import { bootstrap, fixtures } from './fixtures.mjs';

test('normalize strips diacritics, case and punctuation to a comparable key', () => {
  assert.equal(normalize('Kylian Mbappé'), 'kylian mbappe');
  assert.equal(normalize('Dušan Vlahović'), 'dusan vlahovic');
  assert.equal(normalize('  Jean-Philippe  Mateta '), 'jeanphilippe mateta');
});

test('parseCsv reads Stathead\'s export shape, including the duplicated Gls/Min columns', () => {
  const csv =
    'Rk,Player,Gls,Season,Age,Nation,Team,Comp,MP,Min,90s,Starts,Subs,unSub,Gls,Ast,G+A,G-PK,PK,PKatt,PKm,Pos\n' +
    '1,Test Player,10,2025-2026,25,eng ENG,Test Town,eng Premier League,20,1800,20.0,20,0,0,10,3,13,8,2,2,0,FW\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    player: 'Test Player', team: 'Test Town', comp: 'eng Premier League',
    mp: 20, minutes: 1800, starts: 20, goals: 10, assists: 3,
  });
});

test('parseChampionshipDump handles a normal row, and both the missing-age and missing-nation cases', () => {
  const header = 'Rk Player Min Season Age Nation Team Comp MP Min 90s Starts Subs unSub Gls Ast G+A G-PK PK PKatt PKm Pos';
  const text = [
    header,
    "1 Dara O'Shea 4140 2025-2026 26 ie IRL Ipswich Town eng Championship 46 4140 46.0 46 0 0 1 1 2 1 0 0 0 DF",
    '2 Gabriel Otegbayo 2515 2025-2026 Sheffield Weds eng Championship 35 2515 27.9 28 7 9 1 0 1 1 0 0 0 DF',
    '3 Radek Vítek 3690 2025-2026 21 Bristol City eng Championship 41 3690 41.0 41 0 0 0 0 0 0 0 0 0 GK',
    '4 Jay Dasilva 3544 2025-2026 27 wls WAL Coventry City eng Championship 42 3544 39.4 41 1 0 0 3 3 0 0 0 0 DF',
  ].join('\n');

  const rows = parseChampionshipDump(text);
  assert.equal(rows.length, 4);

  assert.deepEqual(rows[0], {
    player: "Dara O'Shea", team: 'Ipswich Town', comp: 'eng Championship',
    mp: 46, minutes: 4140, starts: 46, goals: 1, assists: 1, pos: 'DF',
  });
  assert.equal(rows[1].player, 'Gabriel Otegbayo', 'no nation, no age');
  assert.equal(rows[1].team, 'Sheffield Weds');
  assert.equal(rows[2].player, 'Radek Vítek', 'age present, nation absent');
  assert.equal(rows[2].team, 'Bristol City');
  assert.equal(rows[3].team, 'Coventry City', 'a two-word club name with both age and nation present');
});

test('matchPlayers resolves a same-name collision by the player\'s current club', () => {
  const teamNameById = new Map([[1, 'Hull City'], [2, 'Coventry City']]);
  const noRecord = [
    { id: 101, first_name: 'John', second_name: 'Egan', web_name: 'Egan', team: 1 },
  ];
  const fbrefRows = [
    { player: 'John Egan', team: 'Hull City', comp: 'eng Championship', mp: 42, minutes: 3416, starts: 39, goals: 3, assists: 0 },
    { player: 'John Egan', team: 'Coventry City', comp: 'eng Championship', mp: 10, minutes: 900, starts: 9, goals: 0, assists: 1 },
  ];

  const { matched, unmatched, ambiguous } = matchPlayers(noRecord, fbrefRows, teamNameById);
  assert.equal(unmatched.length, 0);
  assert.equal(ambiguous.length, 0);
  assert.equal(matched[101].fbrefTeam, 'Hull City', 'must pick the row matching his current club, not either row arbitrarily');
  assert.equal(matched[101].source, 'fbref-Championship');
});

test('matchPlayers leaves a genuine collision ambiguous rather than guessing', () => {
  const teamNameById = new Map([[3, 'Sunderland']]);
  const noRecord = [{ id: 202, first_name: 'Alex', second_name: 'Smith', web_name: 'Smith', team: 3 }];
  const fbrefRows = [
    { player: 'Alex Smith', team: 'Watford', comp: 'eng Championship', mp: 10, minutes: 900, starts: 9, goals: 1, assists: 0 },
    { player: 'Alex Smith', team: 'Norwich City', comp: 'eng Championship', mp: 8, minutes: 700, starts: 7, goals: 0, assists: 0 },
  ];

  const { matched, ambiguous } = matchPlayers(noRecord, fbrefRows, teamNameById);
  assert.equal(Object.keys(matched).length, 0, 'must not guess between two players sharing a name at neither of whom he currently plays');
  assert.equal(ambiguous.length, 1);
});

test('a matched FBref record replaces the price-guessed goals/assists rate, discounted for league strength', () => {
  const ctx = buildContext(bootstrap, fixtures);
  const noRecordPlayer = bootstrap.elements.find((p) => p.minutes === 0);
  if (!noRecordPlayer) return; // nothing to test against in this snapshot

  const withoutFbref = _internals.ratesFor(noRecordPlayer, ctx);
  assert.equal(withoutFbref.source, 'price');

  const fb = { source: 'fbref-Championship', minutes: 3600, mp: 40, starts: 38, goals: 18, assists: 6 };
  const ctxWithFbref = buildContext(bootstrap, fixtures, new Map([[noRecordPlayer.id, fb]]));
  const withFbref = _internals.ratesFor(noRecordPlayer, ctxWithFbref);

  assert.equal(withFbref.source, 'fbref-Championship');
  const expectedGoals90 = (fb.goals / fb.minutes) * 90 * 0.72; // LEAGUE_STRENGTH['fbref-Championship']
  assert.ok(Math.abs(withFbref.goals - expectedGoals90) < 1e-9);
  assert.notEqual(withFbref.goals, withoutFbref.goals, 'the price guess must actually be replaced, not just relabeled');

  // The rest of the shape — conceded, bonus, cards — must be untouched: FBref's
  // basic-stats export has no equivalent for them.
  assert.equal(withFbref.concededPer90, withoutFbref.concededPer90);
  assert.equal(withFbref.bonus, withoutFbref.bonus);
});

test('a thin FBref record — below the minutes floor — is not trusted over the price baseline', () => {
  const ctx = buildContext(bootstrap, fixtures);
  const noRecordPlayer = bootstrap.elements.find((p) => p.minutes === 0);
  if (!noRecordPlayer) return;

  const withoutFbref = _internals.ratesFor(noRecordPlayer, ctx);
  const thin = { source: 'fbref-Championship', minutes: 120, mp: 4, starts: 1, goals: 2, assists: 0 };
  const ctxWithThin = buildContext(bootstrap, fixtures, new Map([[noRecordPlayer.id, thin]]));
  const withThin = _internals.ratesFor(noRecordPlayer, ctxWithThin);

  assert.equal(withThin.source, 'price');
  assert.equal(withThin.goals, withoutFbref.goals);
});

test('projectFixture still reconciles parts to total for an FBref-sourced player', () => {
  const noRecordPlayer = bootstrap.elements.find((p) => p.minutes === 0);
  if (!noRecordPlayer) return;
  const fb = { source: 'fbref-Big5', minutes: 2000, mp: 25, starts: 22, goals: 8, assists: 5 };
  const ctx = buildContext(bootstrap, fixtures, new Map([[noRecordPlayer.id, fb]]));
  const proj = projectFixture(noRecordPlayer, { fdr: 3, home: true }, ctx);
  const sum = Object.values(proj.parts).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(Math.max(0, sum) - proj.total) < 1e-9);
});

/* -------------------------------------------------------------------- *
 * PL-wide profile captures (shots/conversion, tackles+interceptions) —
 * display-only data, but parsed the same fragile way, so worth the same
 * fixture-based scrutiny. "eng Premier League" is three tokens where
 * "eng Championship" is two, which is exactly the bug this caught the first
 * time round: every field past Assists silently shifted by one.
 * ------------------------------------------------------------------- */

test('parsePLShotsDump reads the 18-field shooting block correctly', () => {
  const header = 'Rk Player SoT Season Age Nation Team Comp MP Min 90s Starts Subs unSub Gls Ast G+A G-PK PK PKatt PKm Sh G/Sh G/SoT SoT SoT% Pos';
  const text = [
    header,
    '173 Jurriën Timber 7 2025-2026 24 nl NED Arsenal eng Premier League 30 2454 27.3 28 2 0 3 5 8 3 0 0 0 25 0.12 0.43 7 28.0 DF',
  ].join('\n');
  const rows = parsePLShotsDump(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    player: 'Jurriën Timber', team: 'Arsenal', comp: 'eng Premier League',
    mp: 30, minutes: 2454, starts: 28, goals: 3, assists: 5,
    shots: 25, goalsPerShot: 0.12, sot: 7, sotPct: 28, pos: 'DF',
  });
});

test('parsePLDefenseDump reads the 16-field defensive-actions block correctly', () => {
  const header = 'Rk Player Tkl+Int Season Age Nation Team Comp MP Min 90s Starts Subs unSub Gls Ast G+A G-PK PK PKatt PKm TklW Int Tkl+Int Pos';
  const text = [
    header,
    '173 Jurriën Timber 0 2025-2026 24 nl NED Arsenal eng Premier League 30 2454 27.3 28 2 0 3 5 8 3 0 0 0 35 24 0 DF',
  ].join('\n');
  const rows = parsePLDefenseDump(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    player: 'Jurriën Timber', team: 'Arsenal', comp: 'eng Premier League',
    mp: 30, minutes: 2454, starts: 28, goals: 3, assists: 5,
    tacklesWon: 35, interceptions: 24, pos: 'DF',
  });
});

test('matchProfiles merges the two captures per player, and null-fills whichever one is missing', () => {
  const elements = [
    { id: 1, first_name: 'Jurriën', second_name: 'Timber', web_name: 'Timber' },
    { id: 2, first_name: 'Shots', second_name: 'Only', web_name: 'ShotsOnly' },
  ];
  const shotRows = [
    { player: 'Jurriën Timber', minutes: 2454, shots: 25, goalsPerShot: 0.12, sot: 7, sotPct: 28 },
    { player: 'Shots Only', minutes: 1000, shots: 10, goalsPerShot: 0.1, sot: 3, sotPct: 30 },
  ];
  const defenseRows = [
    { player: 'Jurriën Timber', minutes: 2454, tacklesWon: 35, interceptions: 24 },
  ];

  const profiles = matchProfiles(elements, shotRows, defenseRows);
  assert.deepEqual(profiles[1], {
    minutes: 2454, shots: 25, shotsOnTarget: 7, shotsOnTargetPct: 28,
    goalsPerShot: 0.12, tacklesWon: 35, interceptions: 24,
  });
  // No defensive-actions row for this player — must be null, not a false zero.
  assert.equal(profiles[2].tacklesWon, null);
  assert.equal(profiles[2].interceptions, null);
  assert.equal(profiles[2].shots, 10);
});
