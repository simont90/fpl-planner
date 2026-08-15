/**
 * Shared setup for the tests.
 *
 * Building the context and projecting 568 players takes long enough that doing
 * it per test file is noticeable, and every test wants the same objects, so it
 * happens once here.
 *
 * The fixtures are a real snapshot of the FPL API rather than hand-written
 * stubs. That is deliberate: most of what can go wrong in this codebase is a
 * wrong assumption about the shape of the payload — a stat that is a season
 * count where the code expects a rate, a field that is a string where it
 * expects a number — and invented fixtures agree with whatever the code
 * already believes.
 */

import { readFileSync } from 'node:fs';
import { buildContext, projectAll } from '../js/model.js';
import { candidatePool, optimiseSquad } from '../js/optimiser.js';

export const bootstrap = JSON.parse(readFileSync(new URL('./fixtures/bootstrap.json', import.meta.url)));
export const fixtures = JSON.parse(readFileSync(new URL('./fixtures/fixtures.json', import.meta.url)));

export const ctx = buildContext(bootstrap, fixtures);
export const projections = projectAll(bootstrap, ctx, { horizon: 6 });
export const players = bootstrap.elements.filter((p) => projections.has(p.id));
export const pool = candidatePool(players, projections);

let cached = null;
/** An optimal squad, built once and shared — several suites need one to poke at. */
export function optimal() {
  if (!cached) cached = optimiseSquad(players, projections, { restarts: 20, pool });
  return cached;
}

export const byName = (name) => players.find((p) => p.web_name === name);
