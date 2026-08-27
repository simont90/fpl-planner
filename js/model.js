/**
 * The expected-points model.
 *
 * Everything the optimiser ranks on comes out of `projectPlayer`. The model
 * builds a points-per-match figure from component parts — appearance, goals,
 * assists, clean sheet, defensive contribution, saves, bonus, cards — and
 * then scales each part by the difficulty of the actual fixture in front of
 * the player. Nothing here is a black box: `projectPlayer` returns the
 * breakdown alongside the total so any number in the UI can be taken apart.
 *
 * Point values are read from `game_config.scoring` in the bootstrap payload
 * rather than hardcoded, so a mid-season rule change follows automatically.
 * The tuning constants below are heuristics and are marked as such.
 */

export const SEASON_GAMES = 38;

/** element_type id → the short code `game_config.scoring` keys itself by. */
export const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/**
 * Divisors FPL applies that the scoring config does not carry: a keeper earns
 * `saves` points per three saves made, and a keeper or defender loses
 * `goals_conceded` points per two goals shipped.
 */
const SAVES_PER_POINT = 3;
const CONCEDED_PER_PENALTY = 2;

/**
 * Below three full matches, a measured rate is a small enough sample that it
 * needs propping up by the price-implied prior rather than trusted outright.
 * This used to be a hard switch — below it, ignore the measured data
 * entirely and use price instead — which was fine in preseason, where
 * `minutes` meant an entire completed season and "below 270" genuinely meant
 * "no usable record". The moment a live season's first ball is kicked,
 * `minutes` resets to mean *this season so far*, and every player in the
 * league — including established starters with a full history — reads as
 * "below 270" until gameweek three finishes. A hard switch then discards
 * real signal (a nailed-on starter's actual GW1 line) for a guess for the
 * entire league, every August.
 *
 * So this is a blend weight, not a gate: `trust = clamp(minutes / this, 0,
 * 1)`. A player with zero minutes still gets the pure price/FBref fallback
 * below — he has no record to blend in. A player with 90 gets roughly a
 * third measured, two-thirds price; by three full matches he's fully on his
 * own numbers. Both the rate and the minutes model use the same weight, so a
 * player is never given a measured rate but a guessed minutes share, or the
 * other way round.
 */
const MIN_MINUTES_FOR_RATES = 270;

/**
 * The minutes floor `priceBaselines`, `minutesBaselines` and
 * `expectedGoalsCalibration` require before trusting a player's rate enough
 * to feed the league-wide fit. Fixed at 450 in preseason, where `minutes` is
 * last season's total and 450 reliably separates squad players from bit-part
 * ones. Early in a live season almost nobody clears a preseason-sized bar —
 * demanding it would empty the fit out to its flat fallback for the first
 * five gameweeks of every season, which is exactly the failure this whole
 * function exists to avoid. Scaled down to what's actually obtainable so
 * far, floored at one full match so a single substitute appearance still
 * can't qualify.
 *
 * @param currentGw  gameweeks completed this season so far — 0 in preseason,
 *                    where `minutes` means the whole of last season instead.
 */
function sampleFloor(currentGw) {
  const played = currentGw || 0;
  return played === 0 ? 450 : clamp(played * 90, 90, 450);
}

/**
 * Games actually played so far this season — the denominator that matches
 * what `minutes`/`starts` count once a season is live, instead of the fixed
 * 38-game season those fields count against in preseason. Used everywhere a
 * playing-time *share* is computed from raw minutes, so a nailed-on starter
 * with one start out of one possible game reads as ~100% rather than 1/38.
 */
function gamesPlayed(currentGw) {
  return currentGw ? clamp(currentGw, 1, SEASON_GAMES) : SEASON_GAMES;
}

/**
 * League-strength discount applied to a no-record player's goals/assists rate
 * when it comes from FBref rather than price. Heuristic, not fitted — there
 * is no PL record yet to fit it against. The Championship gap is wider than
 * Big-5-to-PL because squad and pressing quality differ more between tiers of
 * the same country than between the top flight of comparable leagues. Below
 * this many FBref minutes the rate is too thin to trust over the price
 * baseline.
 */
const LEAGUE_STRENGTH = { 'fbref-Championship': 0.72, 'fbref-Big5': 0.92 };
const MIN_FBREF_MINUTES = 450;

/**
 * Defensive-contribution thresholds. A defender needs 10 clearances, blocks,
 * interceptions and tackles in a match; everyone further forward needs 12,
 * with ball recoveries also counting. Keepers are not eligible.
 */
const DEFCON_THRESHOLD = { GKP: Infinity, DEF: 10, MID: 12, FWD: 12 };

/**
 * Fixture-difficulty scaling. FPL rates every fixture 1 (easiest) to 5 for
 * each side. These multipliers are heuristic: attacking output rises against
 * weak opposition and expected goals conceded rises against strong opposition.
 * They are deliberately gentler than the raw rating spread — a difficulty 5
 * fixture suppresses a good striker, it does not erase him.
 */
const ATTACK_BY_FDR = { 1: 1.35, 2: 1.16, 3: 1.0, 4: 0.86, 5: 0.72 };
const CONCEDE_BY_FDR = { 1: 0.68, 2: 0.84, 3: 1.0, 4: 1.18, 5: 1.4 };

/**
 * Expected goals is more predictive of future goals than past goals are, but
 * past goals carry finishing skill that xG throws away. Blend, weighted to xG.
 */
const XG_WEIGHT = 0.7;

/**
 * Clean sheets happen slightly more often than a Poisson draw on expected
 * goals conceded suggests, because goals cluster into blowouts rather than
 * spreading evenly across matches. This shrinks the rate before the Poisson
 * to correct for that overdispersion. Fitted against last season's actual
 * clean sheet counts by test/calibrate.mjs, and asserted in
 * test/model.test.mjs so it fails if the fit drifts.
 */
const CS_DISPERSION = 0.95;

/**
 * Points earned further out are less certain — squads rotate, players get
 * injured, form turns. Each gameweek beyond the first is discounted slightly
 * so a strong fixture now outranks the same fixture five weeks away.
 */
const HORIZON_DECAY = 0.97;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const n = (v) => {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(x) ? x : 0;
};

/* ------------------------------------------------------------------ *
 * Poisson helpers
 * ------------------------------------------------------------------ */

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // Computed in log space: defensive-contribution rates run to ~15 actions
  // per match, where k! overflows the naive form.
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/** P(X >= k) for X ~ Poisson(lambda). */
function poissonAtLeast(k, lambda) {
  if (k <= 0) return 1;
  if (lambda <= 0) return 0;
  let below = 0;
  for (let i = 0; i < k; i++) below += poissonPmf(i, lambda);
  return clamp(1 - below, 0, 1);
}

/**
 * E[floor(X / d)] for X ~ Poisson(lambda) — the goals-conceded deduction is
 * only charged per completed pair, so a team shipping one goal loses nothing.
 * Summed directly rather than approximated because the difference between
 * lambda/2 and the true expectation is a fifth of a point per match, which is
 * the same order as the gaps the optimiser decides on.
 */
function expectedFloorDiv(lambda, d) {
  let total = 0;
  const upper = Math.max(12, Math.ceil(lambda + 6 * Math.sqrt(lambda + 1)));
  for (let k = d; k <= upper; k++) total += Math.floor(k / d) * poissonPmf(k, lambda);
  return total;
}

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

/**
 * Pre-compute everything shared across players: the scoring table, fixtures
 * indexed by team and gameweek, and the price-implied baselines used for
 * players with no Premier League minutes behind them.
 */
export function buildContext(bootstrap, fixtures, fbref = new Map()) {
  const teams = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const scoring = bootstrap.game_config.scoring;

  // fixturesByTeam: team id → [{ gw, opponent, home, fdr, kickoff }]
  const fixturesByTeam = new Map(bootstrap.teams.map((t) => [t.id, []]));
  for (const f of fixtures) {
    if (f.event == null) continue; // not yet scheduled into a gameweek
    fixturesByTeam.get(f.team_h)?.push({
      gw: f.event,
      opponent: f.team_a,
      home: true,
      fdr: f.team_h_difficulty,
      kickoff: f.kickoff_time,
      finished: f.finished,
    });
    fixturesByTeam.get(f.team_a)?.push({
      gw: f.event,
      opponent: f.team_h,
      home: false,
      fdr: f.team_a_difficulty,
      kickoff: f.kickoff_time,
      finished: f.finished,
    });
  }
  for (const list of fixturesByTeam.values()) list.sort((a, b) => a.gw - b.gw);

  const events = bootstrap.events;
  const current = events.find((e) => e.is_current);
  const next = events.find((e) => e.is_next);
  const currentGw = current ? current.id : null;
  const floor = sampleFloor(currentGw);

  return {
    teams,
    scoring,
    fixturesByTeam,
    events,
    currentGw,
    nextGw: next ? next.id : (current ? current.id + 1 : 1),
    // Before a ball is kicked, every per-player stat in the payload belongs to
    // last season. The projections still work — they just describe a player's
    // established rate rather than current form — but the UI needs to say so.
    preSeason: !current,
    sampleFloor: floor,
    baseline: priceBaselines(bootstrap.elements, floor),
    minsBaseline: minutesBaselines(bootstrap.elements, gamesPlayed(currentGw)),
    xCal: expectedGoalsCalibration(bootstrap.elements, floor),
    // Last season's goals/assists/minutes for no-record players, from FBref —
    // real numbers for the ~third of no-record players a manual Stathead
    // capture could match, in place of the price-only guess. Keyed by FPL
    // element id. See fbref/match.mjs for provenance and refresh instructions.
    fbref: fbref instanceof Map ? fbref : new Map(Object.entries(fbref).map(([k, v]) => [Number(k), v])),
  };
}

/**
 * How far expected goals and expected assists sit from the returns FPL
 * actually pays out, league-wide.
 *
 * Goals track xG closely — last season 851 against 887, a ratio of 0.96. FPL
 * assists do not: 786 against 572 of expected assists, 37% adrift. That gap
 * is definitional rather than luck. xA scores the quality of the chance
 * created, while FPL pays for the final touch before a goal however the goal
 * arrived — deflections, rebounds, and a defender's error all still credit
 * the passer.
 *
 * Left uncorrected, blending toward xA docks every creative player a fixed
 * fraction of their real output, and it lands hardest on exactly the
 * midfielders a squad is built around. Both ratios are measured here rather
 * than hardcoded so a change in either definition follows automatically.
 */
function expectedGoalsCalibration(elements, floor = 450) {
  let goals = 0;
  let xg = 0;
  let assists = 0;
  let xa = 0;
  for (const p of elements) {
    if (p.minutes < floor) continue;
    goals += p.goals_scored;
    xg += n(p.expected_goals);
    assists += p.assists;
    xa += n(p.expected_assists);
  }
  // Clamped: a ratio far from 1 means the sample is too thin to trust
  // (an early-season payload where nobody has played yet), not that the
  // definition moved.
  return {
    goals: xg > 50 ? clamp(goals / xg, 0.75, 1.35) : 1,
    assists: xa > 50 ? clamp(assists / xa, 0.75, 1.6) : 1,
  };
}

/**
 * Points-per-90 that the market implies at each price point, per position.
 *
 * 187 of 587 players have no Premier League minutes: summer signings and
 * every squad member of the three promoted clubs. Scoring them from their
 * stats gives zero, which would quietly delete a whole promoted side and any
 * new arrival from the optimiser's consideration — the worst possible answer,
 * because a £4.5m nailed-on starter for a promoted club is exactly the kind
 * of enabler a squad is built around.
 *
 * FPL prices new players against what its own compilers expect of them, so
 * price is the one honest signal available. This fits a points-per-90 figure
 * by position and price from the players who *do* have a record, and
 * `projectPlayer` falls back to it — flagged `provisional` so the UI can mark
 * the estimate rather than pass it off as measured.
 */
function priceBaselines(elements, floor = 450) {
  const byPos = new Map();
  for (const code of Object.values(POS)) byPos.set(code, []);

  for (const p of elements) {
    if (p.minutes < floor) continue; // too little to read a rate from
    const per90 = (p.total_points / p.minutes) * 90;
    byPos.get(POS[p.element_type])?.push({ cost: p.now_cost, per90 });
  }

  // Least-squares line of points-per-90 against price, per position, plus the
  // observed mean as the fallback when a position has too few records.
  const fits = new Map();
  for (const [code, rows] of byPos) {
    if (rows.length < 8) {
      fits.set(code, { slope: 0, intercept: rows.length ? mean(rows.map((r) => r.per90)) : 2.5 });
      continue;
    }
    const mx = mean(rows.map((r) => r.cost));
    const my = mean(rows.map((r) => r.per90));
    let num = 0;
    let den = 0;
    for (const r of rows) {
      num += (r.cost - mx) * (r.per90 - my);
      den += (r.cost - mx) ** 2;
    }
    const slope = den ? num / den : 0;
    fits.set(code, { slope, intercept: my - slope * mx });
  }
  return fits;
}

/**
 * Share of available minutes the market implies at each price point.
 *
 * The rate baseline above is only half an answer. A player with no record gets
 * price-implied per-90 rates, but every one of those rates is then scaled by
 * how much he is expected to play — and the minutes model reads that from
 * starts and minutes, which for these players are zero. Zero minutes multiplied
 * by any rate is zero, so without this the price fallback is silently undone
 * and all 187 of them project to nothing, which is the exact failure the rate
 * baseline was written to prevent.
 *
 * Fitted the same way and for the same reason: price is what FPL's own
 * compilers expect of a player, and expectation of minutes is most of what
 * they are pricing.
 *
 * Unlike the per-90 rate baselines above, this one is fit on every player,
 * no minutes floor. A share (0 to 1) doesn't suffer the small-sample-noise
 * problem a per-90 rate does — a player who hasn't played at all is a
 * genuine, informative zero, not a noisy measurement to exclude. Applying
 * the same floor here as the rate baselines actively breaks the fit early
 * in a live season: with one gameweek played, "cleared the floor" means
 * "played the entire game", so every row in the fit would read the same
 * ~100% share regardless of price, flattening the whole regression to a
 * constant right when it's needed most — to tell a nailed-on starter's
 * price-implied share apart from a fringe player's.
 */
function minutesBaselines(elements, games = SEASON_GAMES) {
  const byPos = new Map();
  for (const code of Object.values(POS)) byPos.set(code, []);

  for (const p of elements) {
    byPos.get(POS[p.element_type])?.push({
      cost: p.now_cost,
      share: clamp(p.minutes / (games * 90), 0, 1),
    });
  }

  const fits = new Map();
  for (const [code, rows] of byPos) {
    if (rows.length < 8) {
      fits.set(code, { slope: 0, intercept: rows.length ? mean(rows.map((r) => r.share)) : 0.5 });
      continue;
    }
    const mx = mean(rows.map((r) => r.cost));
    const my = mean(rows.map((r) => r.share));
    let num = 0;
    let den = 0;
    for (const r of rows) {
      num += (r.cost - mx) * (r.share - my);
      den += (r.cost - mx) ** 2;
    }
    const slope = den ? num / den : 0;
    fits.set(code, { slope, intercept: my - slope * mx });
  }
  return fits;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/* ------------------------------------------------------------------ *
 * Availability and minutes
 * ------------------------------------------------------------------ */

/**
 * How likely the player is to feature at all, from FPL's own status flag.
 * `a` available, `d` doubtful, `i` injured, `s` suspended, `u` unavailable
 * (left the league — those are filtered out entirely before this point).
 */
export function availability(player) {
  const chance = player.chance_of_playing_next_round;
  if (chance !== null && chance !== undefined) return clamp(chance / 100, 0, 1);
  switch (player.status) {
    case 'a':
      return 1;
    case 'd':
      return 0.6; // doubtful with no percentage attached
    case 'i':
    case 's':
    case 'n':
    case 'u':
      return 0;
    default:
      return 1;
  }
}

/**
 * Probability the player starts, plays 60 minutes (the clean-sheet and
 * two-point appearance threshold), and appears at all.
 *
 * Two signals are blended because each fails on its own: starts-per-season
 * misses a regular substitute, and minutes-per-season punishes a nailed-on
 * starter who missed six weeks injured but is fit now.
 */
export function minutesModel(player, avail = availability(player), ctx = null) {
  const starts = player.starts || 0;
  const minutes = player.minutes || 0;

  // Price/FBref-implied playing-time share — the whole answer for a player
  // with no minutes at all, and the "prior" half of the blend below for one
  // who has some but not yet enough to trust outright.
  const priorShare = () => {
    const fit = ctx?.minsBaseline?.get(POS[player.element_type]) || { slope: 0, intercept: 0.5 };
    // Floored well above zero and capped below one: the cheapest player in the
    // game is still a squad member who might start, and no one is guaranteed.
    let share = clamp(fit.intercept + fit.slope * player.now_cost, 0.12, 0.88);

    // A matched FBref record carries real minutes played, which is a far
    // better signal of playing-time share than price alone — weighted
    // heavily over the price guess rather than replacing it outright, since
    // a squad role can still change between clubs.
    const fb = ctx?.fbref?.get(player.id);
    if (fb && fb.mp > 0) {
      const fbShare = clamp(fb.minutes / (SEASON_GAMES * 90), 0.12, 0.88);
      share = clamp(0.7 * fbShare + 0.3 * share, 0.12, 0.88);
    }
    return share;
  };

  // Genuinely no record: the price/FBref prior is the entire answer.
  if (minutes === 0) {
    const share = priorShare();
    const rawP60 = clamp(share * 0.98, 0, 0.95);
    return {
      p60: rawP60 * avail,
      pAppear: clamp(rawP60 / 0.88, 0, 0.99) * avail,
      expMinutes: share * 90 * avail,
      provisional: true,
    };
  }

  const gamesSoFar = gamesPlayed(ctx?.currentGw);

  const startShare = clamp(starts / gamesSoFar, 0, 1);
  const minsPerStart = starts > 0 ? Math.min(90, minutes / starts) : 0;
  // A player averaging 90 minutes per start is never withdrawn; one averaging
  // 55 is a regular substitution.
  const startQuality = starts > 0 ? clamp((minsPerStart - 40) / 45, 0.2, 1) : 0;
  const minuteShare = clamp(minutes / (gamesSoFar * 90), 0, 1);

  const rawP60Measured = clamp(0.5 * startShare * startQuality + 0.5 * minuteShare * 1.1, 0, 0.97);
  const expMinutesMeasured = clamp(minuteShare * 90, 0, 90);

  // Below the same three-match trust threshold the rate model uses, blend
  // with the price-implied share rather than trusting a one- or two-game
  // sample outright — a player is never given a measured rate but a guessed
  // minutes share, or the other way round.
  const trust = clamp(minutes / MIN_MINUTES_FOR_RATES, 0, 1);
  let rawP60 = rawP60Measured;
  let expMinutes = expMinutesMeasured;
  if (trust < 1) {
    const share = priorShare();
    rawP60 = trust * rawP60Measured + (1 - trust) * clamp(share * 0.98, 0, 0.95);
    expMinutes = trust * expMinutesMeasured + (1 - trust) * (share * 90);
  }

  const p60 = rawP60 * avail;
  const pAppear = clamp(rawP60 / 0.88, 0, 0.99) * avail;

  return {
    p60,
    pAppear,
    // Expected minutes on the pitch, used to scale the per-90 rates below.
    expMinutes: expMinutes * avail,
    provisional: trust < 1,
  };
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

/**
 * Per-90 rates for everything that scores points. Returns `provisional: true`
 * when the player has no usable record and the rates came from the
 * price-implied baseline instead.
 */
function ratesFor(player, ctx) {
  const code = POS[player.element_type];
  const mins = player.minutes || 0;

  // The price/FBref-implied rates: the whole answer for a player with zero
  // minutes, and the "prior" half of the blend below for one who has some
  // minutes but not yet enough to trust outright.
  const priceRates = () => {
    // Distribute the price-implied points-per-90 across the components in the
    // proportions that position typically earns them, so the breakdown still
    // adds up.
    const fit = ctx.baseline.get(code) || { slope: 0, intercept: 2.5 };
    const per90 = clamp(fit.intercept + fit.slope * player.now_cost, 1.5, 9);
    const rates = { ...syntheticRates(code, per90), source: 'price' };

    // A matched FBref record replaces the price-guessed goals/assists rate
    // with the player's actual rate last season, discounted for league
    // strength. Everything else on this player — clean sheets, bonus, cards —
    // stays on the price-implied shape: FBref's basic-stats export (its
    // advanced data was pulled in Jan 2026) has no equivalent for those.
    const fb = ctx.fbref?.get(player.id);
    if (fb && fb.minutes >= MIN_FBREF_MINUTES) {
      const adjust = LEAGUE_STRENGTH[fb.source] ?? 0.8;
      rates.goals = (fb.goals / fb.minutes) * 90 * adjust;
      rates.assists = (fb.assists / fb.minutes) * 90 * adjust;
      rates.source = fb.source;
    }
    return rates;
  };

  // Genuinely no record — the only case where the price/FBref prior is the
  // entire answer, not blended with anything.
  if (mins === 0) {
    return { ...priceRates(), provisional: true };
  }

  const per90 = (v) => (n(v) / mins) * 90;
  const cal = ctx.xCal || { goals: 1, assists: 1 };
  const measured = {
    goals:
      XG_WEIGHT * n(player.expected_goals_per_90) * cal.goals +
      (1 - XG_WEIGHT) * per90(player.goals_scored),
    assists:
      XG_WEIGHT * n(player.expected_assists_per_90) * cal.assists +
      (1 - XG_WEIGHT) * per90(player.assists),
    concededPer90: n(player.expected_goals_conceded_per_90) || per90(player.goals_conceded),
    defcon: per90(player.defensive_contribution),
    saves: per90(player.saves),
    bonus: per90(player.bonus),
    yellow: per90(player.yellow_cards),
    red: per90(player.red_cards),
    penSaved: per90(player.penalties_saved),
    penMissed: per90(player.penalties_missed),
    ownGoals: per90(player.own_goals),
  };

  const trust = clamp(mins / MIN_MINUTES_FOR_RATES, 0, 1);
  if (trust >= 1) {
    return { ...measured, provisional: false, source: 'measured' };
  }

  const prior = priceRates();
  const blended = {};
  for (const key of Object.keys(measured)) {
    blended[key] = trust * measured[key] + (1 - trust) * prior[key];
  }
  return { ...blended, provisional: true, source: 'blend' };
}

/**
 * Component rates for a player with no record, chosen so that the resulting
 * per-match projection lands near the price-implied `per90` while keeping the
 * shape of a typical player in that position.
 */
function syntheticRates(code, per90) {
  // Attacking share of a position's points, above the ~2 appearance points.
  const attacking = Math.max(0, per90 - 2.2);
  const shape = {
    GKP: { g: 0, a: 0.02, saves: 3.0, conceded: 1.35, defcon: 0 },
    DEF: { g: 0.06, a: 0.06, saves: 0, conceded: 1.35, defcon: 7.5 },
    MID: { g: 0.14, a: 0.14, saves: 0, conceded: 1.4, defcon: 8.0 },
    FWD: { g: 0.3, a: 0.1, saves: 0, conceded: 1.45, defcon: 4.0 },
  }[code];

  const lift = clamp(attacking / 1.5, 0.4, 2.2);
  return {
    goals: shape.g * lift,
    assists: shape.a * lift,
    concededPer90: shape.conceded,
    defcon: shape.defcon,
    saves: shape.saves,
    bonus: 0.12 * lift,
    yellow: 0.15,
    red: 0.004,
    penSaved: 0,
    penMissed: 0,
    ownGoals: 0.01,
  };
}

/**
 * Expected points for one player in one fixture.
 *
 * @param {object} player  bootstrap element
 * @param {object} fixture { fdr, home, opponent }
 * @param {object} ctx     from buildContext
 * @returns {{ total: number, parts: object }}
 */
export function projectFixture(player, fixture, ctx, precomputed) {
  const code = POS[player.element_type];
  const s = ctx.scoring;
  const rates = precomputed?.rates || ratesFor(player, ctx);
  const mins = precomputed?.mins || minutesModel(player, availability(player), ctx);

  const fdr = clamp(fixture?.fdr ?? 3, 1, 5);
  const atkMult = ATTACK_BY_FDR[fdr];
  const concedeMult = CONCEDE_BY_FDR[fdr];
  // Home advantage on top of difficulty, which already leans on venue but
  // does not fully capture it.
  const venue = fixture?.home ? 1.06 : 0.94;

  // Rates are per 90; scale to the minutes this player is expected to get.
  const share = mins.expMinutes / 90;

  const parts = {};

  parts.appearance = s.long_play * mins.p60 + s.short_play * Math.max(0, mins.pAppear - mins.p60);

  parts.goals = rates.goals * share * atkMult * venue * s.goals_scored[code];
  parts.assists = rates.assists * share * atkMult * venue * s.assists;

  // Clean sheet only counts if the player is on for 60 minutes.
  const xgcMatch = Math.max(0.05, rates.concededPer90 * concedeMult * (fixture?.home ? 0.92 : 1.08));
  const pCleanSheet = Math.exp(-xgcMatch * CS_DISPERSION);
  parts.cleanSheet = pCleanSheet * mins.p60 * (s.clean_sheets[code] || 0);

  // The concession deduction applies whenever the player is on the pitch.
  parts.conceded =
    (s.goals_conceded[code] || 0) === 0
      ? 0
      : expectedFloorDiv(xgcMatch * share, CONCEDED_PER_PENALTY) * (s.goals_conceded[code] || 0) * mins.pAppear;

  // A keeper facing a harder fixture makes more saves, not fewer.
  //
  // The remainder is discarded every match rather than carried, so this is
  // E[floor(saves / 3)], not E[saves] / 3. The two are far apart at realistic
  // volumes: a keeper facing 1.6 shots on target a game averages 0.21 save
  // points, where dividing the mean claims 0.54 — a third of a point per
  // match, applied to every keeper, which was enough to rank them above
  // defenders wrongly.
  parts.saves =
    code === 'GKP'
      ? expectedFloorDiv(rates.saves * share * concedeMult, SAVES_PER_POINT) * s.saves
      : 0;

  // Defensive contribution is a threshold, not a rate: the points land only
  // when the player crosses it inside a single match.
  const threshold = DEFCON_THRESHOLD[code];
  if (Number.isFinite(threshold) && (s.defensive_contribution?.[code] || 0) > 0 && rates.defcon > 0) {
    // A defender's actions rise when his side is under pressure, which is
    // exactly when the fixture is hard — the opposite lean to attacking output.
    const defconRate = rates.defcon * share * (1 + (fdr - 3) * 0.06);
    parts.defcon =
      poissonAtLeast(threshold, defconRate) * s.defensive_contribution[code] * mins.p60;
  } else {
    parts.defcon = 0;
  }

  parts.bonus = rates.bonus * share * s.bonus * (1 + (3 - fdr) * 0.05);

  parts.cards = (rates.yellow * share * s.yellow_cards + rates.red * share * s.red_cards);

  parts.penalties =
    rates.penSaved * share * s.penalties_saved +
    rates.penMissed * share * s.penalties_missed +
    rates.ownGoals * share * s.own_goals;

  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: Math.max(0, total), parts };
}

/**
 * Project a player across a run of gameweeks.
 *
 * Handles blanks (no fixture that week — zero points, and the reason the
 * planner exists) and doubles (two fixtures — both counted).
 *
 * @returns {{
 *   id, epNext, epTotal, epPerGame, provisional, availability,
 *   gws: Array<{ gw, fixtures, ep }>
 * }}
 */
export function projectPlayer(player, ctx, { from = ctx.nextGw, horizon = 5, decay = HORIZON_DECAY } = {}) {
  const rates = ratesFor(player, ctx);
  const avail = availability(player);
  const mins = minutesModel(player, avail, ctx);
  const precomputed = { rates, mins };

  const all = ctx.fixturesByTeam.get(player.team) || [];
  const gws = [];
  let epTotal = 0;

  for (let i = 0; i < horizon; i++) {
    const gw = from + i;
    const fixtures = all.filter((f) => f.gw === gw && !f.finished);
    let ep = 0;
    const detail = [];
    for (const f of fixtures) {
      const proj = projectFixture(player, f, ctx, precomputed);
      ep += proj.total;
      detail.push({
        opponent: ctx.teams.get(f.opponent)?.short_name || '?',
        home: f.home,
        fdr: f.fdr,
        ep: proj.total,
      });
    }
    gws.push({ gw, fixtures: detail, ep, blank: fixtures.length === 0, double: fixtures.length > 1 });
    epTotal += ep * Math.pow(decay, i);
  }

  return {
    id: player.id,
    epNext: gws[0]?.ep ?? 0,
    epTotal,
    epPerGame: horizon ? epTotal / horizon : 0,
    provisional: rates.provisional,
    source: rates.source ?? (rates.provisional ? 'price' : 'measured'),
    availability: avail,
    minutes: mins,
    gws,
  };
}

/**
 * Project every selectable player. Players flagged `u` — transferred out of
 * the league — are dropped: they still appear in the payload but cannot be
 * picked, and leaving them in lets the optimiser build a squad you cannot
 * actually enter.
 */
export function projectAll(bootstrap, ctx, opts = {}) {
  const out = new Map();
  for (const p of bootstrap.elements) {
    if (p.status === 'u' || p.can_select === false || p.removed) continue;
    out.set(p.id, projectPlayer(p, ctx, opts));
  }
  return out;
}

export const _internals = {
  poissonPmf,
  poissonAtLeast,
  expectedFloorDiv,
  ratesFor,
  CS_DISPERSION,
  ATTACK_BY_FDR,
};
