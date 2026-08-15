/**
 * Matches FBref/Stathead basic-stats rows (fbref/raw/*) to FPL players and
 * writes two outputs:
 *
 *   data/fbref.json     — goals/assists/minutes for players with no Premier
 *                          League record (promoted clubs, new signings),
 *                          used as a fallback for their scoring rate. See
 *                          js/model.js.
 *   data/fbref-pl.json  — shots/conversion/tackles/interceptions for every
 *                          current PL player, this season only. Display-only:
 *                          it is shown in the player detail modal as extra
 *                          profile context, not blended into the scoring
 *                          model. Tkl+Int is not the same definition FPL uses
 *                          for defensive_contribution (no clearances, blocks
 *                          or recoveries), and folding shot volume into the
 *                          already-calibrated goals rate risks moving the
 *                          bias/MAE the model's tests hold it to — both are
 *                          real enough risks that this stays informational
 *                          until it's been back-tested against a season.
 *
 * FBref/Stathead's advanced data (xG, xA, defensive actions) was deleted
 * site-wide in January 2026 after their data provider pulled the license — see
 * https://www.sports-reference.com/blog/2026/01/fbref-stathead-data-update/.
 * What is captured here is what remains: goals, assists, shots, tackles,
 * interceptions, minutes, starts — all 2025-2026 only, by design: last
 * season's form, not a multi-year history.
 *
 * The raw files are not a scrape — they were captured once, by hand, from a
 * paying Stathead subscriber's own browser session (Player Season Finder),
 * well under the site's 10 req/min bot policy. Refresh by repeating that
 * manual capture; there is no live fetch here.
 *
 * Usage: node fbref/match.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(DIR, 'raw');
const BOOTSTRAP_URL = 'https://fpl-planner.simontariq.workers.dev/bootstrap';

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** Rk,Player,Gls,Season,Age,Nation,Team,Comp,MP,Min,90s,Starts,Subs,unSub,Gls,Ast,G+A,G-PK,PK,PKatt,PKm,Pos */
export function parseCsv(text) {
  const lines = text.trim().split('\n').slice(1); // drop header
  const rows = [];
  for (const line of lines) {
    const c = line.split(',');
    if (c.length < 22) continue;
    rows.push({
      player: c[1],
      team: c[6],
      comp: c[7],
      mp: Number(c[8]),
      minutes: Number(c[9]),
      starts: Number(c[11]),
      goals: Number(c[14]),
      assists: Number(c[15]),
    });
  }
  return rows;
}

/**
 * Space-delimited table dump: "Rk Player Min Season Age Nation Team Comp MP
 * Min 90s Starts Subs unSub Gls Ast G+A G-PK PK PKatt PKm Pos". Age and
 * Nation are both sometimes absent, so this parses from both ends inward
 * rather than by fixed position: Pos is the last token, the 13 tokens before
 * it are always numeric (MP..PKm), the two tokens before that are always the
 * literal "eng Championship", everything between Nation (if present) and
 * that literal is the team name, and Player is everything up to the first
 * purely-numeric token (the duplicated Min column).
 */
export function parseChampionshipDump(text) {
  const lines = text.trim().split('\n').slice(1);
  const rows = [];
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t.length < 17) continue;

    const pos = t[t.length - 1];
    const nums = t.slice(t.length - 14, t.length - 1); // MP,Min,90s,Starts,Subs,unSub,Gls,Ast,G+A,G-PK,PK,PKatt,PKm
    if (nums.length !== 13 || !nums.every((x) => /^-?\d+(\.\d+)?$/.test(x))) continue;
    const [mp, minutes, , starts, , , goals, assists] = nums;

    // "eng Championship" immediately precedes the numeric block.
    const compEnd = t.length - 14;
    if (t[compEnd - 2] !== 'eng' || t[compEnd - 1] !== 'Championship') continue;
    const teamEnd = compEnd - 2;

    // Player name runs from index 1 (index 0 is Rk) up to the first numeric
    // token — the season-total minutes, duplicated as the sort column right
    // after Rk.
    let i = 1;
    while (i < t.length && !/^\d+$/.test(t[i])) i++;
    const player = t.slice(1, i).join(' ');
    let j = i + 2; // skip Min, Season ("2025-2026")

    // Age: an optional bare 2-digit number.
    if (j < teamEnd && /^\d{1,2}$/.test(t[j])) j++;
    // Nation: an optional "xx XXX" pair.
    if (j + 1 < teamEnd && /^[a-z]{2,3}$/.test(t[j]) && /^[A-Z]{2,4}$/.test(t[j + 1])) j += 2;

    const team = t.slice(j, teamEnd).join(' ');
    rows.push({
      player,
      team,
      comp: 'eng Championship',
      mp: Number(mp),
      minutes: Number(minutes),
      starts: Number(starts),
      goals: Number(goals),
      assists: Number(assists),
      pos,
    });
  }
  return rows;
}

/**
 * Space-delimited Premier-League-wide capture, shooting shape: "Rk Player SoT
 * Season Age Nation Team Comp MP Min 90s Starts Subs unSub Gls Ast G+A G-PK
 * PK PKatt PKm Sh G/Sh G/SoT SoT SoT% Pos" — 18 numeric fields (13 standard +
 * Sh, G/Sh, G/SoT, SoT, SoT%) before Pos. Only captured for players with
 * SoT >= 2, so the trailing shooting block is never dropped for a zero here
 * the way it is for keepers in the full capture.
 */
export function parsePLShotsDump(text) {
  const lines = text.trim().split('\n').slice(1);
  const rows = [];
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t.length < 22) continue;

    const pos = t[t.length - 1];
    const nums = t.slice(t.length - 19, t.length - 1); // 18 numeric fields
    if (nums.length !== 18 || !nums.every((x) => /^-?\d+(\.\d+)?$/.test(x))) continue;
    // 18 fields: MP,Min,90s,Starts,Subs,unSub,Gls,Ast,G+A,G-PK,PK,PKatt,PKm,Sh,G/Sh,G/SoT,SoT,SoT%
    const [mp, minutes, , starts, , , goals, assists, , , , , , shots, goalsPerShot, , sot, sotPct] = nums;

    // "eng Premier League" is three tokens, unlike "eng Championship"'s two.
    const compEnd = t.length - 19;
    if (t[compEnd - 3] !== 'eng' || t[compEnd - 2] !== 'Premier' || t[compEnd - 1] !== 'League') continue;
    const teamEnd = compEnd - 3;

    let i = 1;
    while (i < t.length && !/^\d+$/.test(t[i])) i++;
    const player = t.slice(1, i).join(' ');
    let j = i + 2;
    if (j < teamEnd && /^\d{1,2}$/.test(t[j])) j++;
    if (j + 1 < teamEnd && /^[a-z]{2,3}$/.test(t[j]) && /^[A-Z]{2,4}$/.test(t[j + 1])) j += 2;
    const team = t.slice(j, teamEnd).join(' ');

    rows.push({
      player, team, comp: 'eng Premier League',
      mp: Number(mp), minutes: Number(minutes), starts: Number(starts),
      goals: Number(goals), assists: Number(assists),
      shots: Number(shots), goalsPerShot: Number(goalsPerShot),
      sot: Number(sot), sotPct: Number(sotPct), pos,
    });
  }
  return rows;
}

/**
 * Same shape, defensive-actions capture: "... Gls Ast G+A G-PK PK PKatt PKm
 * TklW Int Tkl+Int Pos" — 16 numeric fields before Pos. Unlike the shooting
 * capture, this one includes keepers and zero rows, since tackles/
 * interceptions don't get dropped for a zero value the way shot ratios do.
 */
export function parsePLDefenseDump(text) {
  const lines = text.trim().split('\n').slice(1);
  const rows = [];
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t.length < 20) continue;

    const pos = t[t.length - 1];
    const nums = t.slice(t.length - 17, t.length - 1); // 16 numeric fields
    if (nums.length !== 16 || !nums.every((x) => /^-?\d+(\.\d+)?$/.test(x))) continue;
    const [mp, minutes, , starts, , , goals, assists, , , , , , tklW, int] = nums;

    const compEnd = t.length - 17;
    if (t[compEnd - 3] !== 'eng' || t[compEnd - 2] !== 'Premier' || t[compEnd - 1] !== 'League') continue;
    const teamEnd = compEnd - 3;

    let i = 1;
    while (i < t.length && !/^\d+$/.test(t[i])) i++;
    const player = t.slice(1, i).join(' ');
    let j = i + 2;
    if (j < teamEnd && /^\d{1,2}$/.test(t[j])) j++;
    if (j + 1 < teamEnd && /^[a-z]{2,3}$/.test(t[j]) && /^[A-Z]{2,4}$/.test(t[j + 1])) j += 2;
    const team = t.slice(j, teamEnd).join(' ');

    rows.push({
      player, team, comp: 'eng Premier League',
      mp: Number(mp), minutes: Number(minutes), starts: Number(starts),
      goals: Number(goals), assists: Number(assists),
      tacklesWon: Number(tklW), interceptions: Number(int), pos,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Name matching
 * ------------------------------------------------------------------ */

export function normalize(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * De-dupes rows appearing on more than one captured page (the minutes
 * pagination overlaps, and the same player can turn up in both the
 * Championship and Big-5 captures if he played for two clubs).
 */
export function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.player}|${r.team}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Matches FPL players with no PL record to FBref rows by normalized name,
 * disambiguating a name shared by more than one row with the player's
 * current club — decisive for the promoted sides, where several candidates
 * can share a surname. Returns `{ matched, unmatched, ambiguous }`, where
 * `matched` is keyed by FPL element id in the same shape written to
 * data/fbref.json.
 */
export function matchPlayers(noRecordElements, fbrefRows, teamNameById) {
  const byNormName = new Map();
  for (const row of fbrefRows) {
    const key = normalize(row.player);
    if (!byNormName.has(key)) byNormName.set(key, []);
    byNormName.get(key).push(row);
  }

  const matched = {};
  const unmatched = [];
  const ambiguous = [];

  for (const p of noRecordElements) {
    const fullName = `${p.first_name} ${p.second_name}`;
    const candidates = byNormName.get(normalize(fullName)) || byNormName.get(normalize(p.web_name)) || [];

    let row = null;
    if (candidates.length === 1) {
      row = candidates[0];
    } else if (candidates.length > 1) {
      const club = teamNameById.get(p.team);
      row = candidates.find((c) => c.team === club) || null;
      if (!row) {
        ambiguous.push({ id: p.id, name: fullName, team: club, candidates: candidates.map((c) => c.team) });
        continue;
      }
    }

    if (!row) {
      unmatched.push({ id: p.id, name: fullName, team: teamNameById.get(p.team) });
      continue;
    }

    matched[p.id] = {
      source: row.comp === 'eng Championship' ? 'fbref-Championship' : 'fbref-Big5',
      minutes: row.minutes,
      mp: row.mp,
      starts: row.starts,
      goals: row.goals,
      assists: row.assists,
      fbrefTeam: row.team,
    };
  }

  return { matched, unmatched, ambiguous };
}

/**
 * Matches shooting/defensive-action rows to every current PL player (not
 * just the no-record ones) by normalized name, merging the two capture files
 * per player. This is display-only profile data — see the note at the top of
 * this file on why it isn't blended into the scoring model.
 */
export function matchProfiles(elements, shotRows, defenseRows) {
  const byName = new Map();
  for (const row of shotRows) {
    byName.set(normalize(row.player), { ...(byName.get(normalize(row.player)) || {}), ...row });
  }
  for (const row of defenseRows) {
    const key = normalize(row.player);
    byName.set(key, { ...(byName.get(key) || {}), tacklesWon: row.tacklesWon, interceptions: row.interceptions });
  }

  const matched = {};
  for (const p of elements) {
    const row = byName.get(normalize(`${p.first_name} ${p.second_name}`)) || byName.get(normalize(p.web_name));
    if (!row || !row.minutes) continue;
    // The two captures were trimmed independently (see raw/), so a player
    // can appear in one and not the other. null means "not captured", not
    // zero — a defender absent from the defensive-actions file has not
    // actually made zero tackles, and rendering it as a bare 0 would say so.
    matched[p.id] = {
      minutes: row.minutes,
      shots: row.shots ?? null,
      shotsOnTarget: row.sot ?? null,
      shotsOnTargetPct: row.sotPct ?? null,
      goalsPerShot: row.goalsPerShot ?? null,
      tacklesWon: row.tacklesWon ?? null,
      interceptions: row.interceptions ?? null,
    };
  }
  return matched;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const files = readdirSync(RAW);
  const noRecordFiles = files.filter((f) => !f.startsWith('pl-2025-2026-'));
  const fbrefRows = dedupeRows(
    noRecordFiles.flatMap((f) => {
      const text = readFileSync(path.join(RAW, f), 'utf8');
      return f.endsWith('.csv') ? parseCsv(text) : parseChampionshipDump(text);
    })
  );
  console.log(`Parsed ${fbrefRows.length} FBref rows from ${noRecordFiles.length} files (no-record fallback).`);

  const boot = await fetch(BOOTSTRAP_URL).then((r) => r.json());
  const noRecord = boot.elements.filter((p) => p.minutes === 0);
  const teamName = new Map(boot.teams.map((t) => [t.id, t.name]));

  const { matched, unmatched, ambiguous } = matchPlayers(noRecord, fbrefRows, teamName);

  const dataDir = path.join(DIR, '..', 'data');
  writeFileSync(path.join(dataDir, 'fbref.json'), JSON.stringify(matched, null, 2));
  writeFileSync(path.join(DIR, 'unmatched.json'), JSON.stringify({ unmatched, ambiguous }, null, 2));

  console.log(`No-PL-record players: ${noRecord.length}`);
  console.log(`Matched:              ${Object.keys(matched).length}`);
  console.log(`Ambiguous (skipped):  ${ambiguous.length}`);
  console.log(`Unmatched:            ${unmatched.length}`);

  // Player-profile enrichment: shots/conversion/tackles for every current PL
  // player, from the PL-wide captures specifically.
  const shotsFile = files.find((f) => f.includes('shots'));
  const defenseFile = files.find((f) => f.includes('defense'));
  if (shotsFile && defenseFile) {
    const shotRows = parsePLShotsDump(readFileSync(path.join(RAW, shotsFile), 'utf8'));
    const defenseRows = parsePLDefenseDump(readFileSync(path.join(RAW, defenseFile), 'utf8'));
    const profiles = matchProfiles(boot.elements, shotRows, defenseRows);
    writeFileSync(path.join(dataDir, 'fbref-pl.json'), JSON.stringify(profiles, null, 2));
    console.log(`Player profiles:      ${Object.keys(profiles).length} of ${boot.elements.length} PL players`);
  }

  console.log('Wrote data/fbref.json, data/fbref-pl.json and fbref/unmatched.json');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
