/**
 * FPL Planner — Cloudflare Worker
 *
 * The official Fantasy Premier League API serves JSON happily but sends no
 * Access-Control-Allow-Origin header, so a browser cannot call it directly.
 * This worker is a thin, cached, CORS-enabled proxy in front of it. It adds
 * no interpretation of its own: every route returns the upstream body
 * verbatim so the model in the client is the single place that reasons
 * about the numbers.
 *
 * Routes:
 *   GET /health                → "ok"
 *   GET /bootstrap             → players, teams, gameweeks, scoring rules
 *   GET /fixtures[?event=N]    → fixtures, with per-side difficulty ratings
 *   GET /player/:id            → element-summary: upcoming fixtures + past seasons
 *   GET /entry/:id             → a manager's profile and league memberships
 *   GET /picks/:id/:gw         → a manager's 15 picks for a finished gameweek
 *   GET /history/:id           → a manager's season-by-season and per-GW history
 *   GET /league/:id[?page=N]   → classic league standings
 */

const UPSTREAM = 'https://fantasy.premierleague.com/api';

// Upstream rejects requests without a browser-ish UA.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Seconds to cache each route at the edge. Player prices and news move a few
// times a day; fixtures barely move at all; a manager's picks for a gameweek
// are immutable once the deadline passes.
const TTL = {
  bootstrap: 600,
  fixtures: 3600,
  player: 900,
  entry: 300,
  picks: 3600,
  history: 300,
  league: 300,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body, { status = 200, ttl = 0 } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // s-maxage drives the Cloudflare edge; max-age keeps the browser from
      // re-asking on every view switch. stale-while-revalidate means a cold
      // cache never blocks the UI on a full 1.4 MB bootstrap fetch.
      'Cache-Control': ttl
        ? `public, max-age=${Math.min(ttl, 300)}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`
        : 'no-store',
      ...CORS,
    },
  });
}

function err(status, code, message) {
  return json({ error: code, message }, { status });
}

/**
 * Fetch from upstream and hand back the body plus our own cache headers.
 * `cf.cacheTtl` lets Cloudflare hold the upstream response even though FPL
 * marks everything no-cache, which is what keeps us off their rate limiter.
 */
async function upstream(path, ttl) {
  let res;
  try {
    res = await fetch(`${UPSTREAM}${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
  } catch (e) {
    return err(502, 'upstream_unreachable', `Could not reach the FPL API: ${e.message}`);
  }

  if (res.status === 404) {
    return err(404, 'not_found', 'The FPL API has no record with that id.');
  }
  if (res.status === 429) {
    return err(429, 'rate_limited', 'The FPL API is rate limiting this worker. Try again shortly.');
  }
  if (!res.ok) {
    return err(502, 'upstream_error', `The FPL API returned ${res.status}.`);
  }

  // A maintenance window or a bot wall returns HTML with a 200. Passing that
  // through would surface as a JSON parse error in the client with no clue
  // as to why, so name it here instead.
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) {
    return err(503, 'upstream_not_json', 'The FPL API returned a non-JSON body — it is likely in a maintenance window.');
  }

  return json(await res.text(), { ttl });
}

const num = (s) => (/^\d+$/.test(s) ? Number(s) : null);

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return err(405, 'method_not_allowed', 'This worker only serves GET.');
    }

    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean);

    switch (seg[0]) {
      case undefined:
      case 'health':
        return new Response('ok', {
          headers: { 'Content-Type': 'text/plain', ...CORS },
        });

      case 'bootstrap':
        return upstream('/bootstrap-static/', TTL.bootstrap);

      case 'fixtures': {
        const ev = url.searchParams.get('event');
        if (ev !== null && num(ev) === null) {
          return err(400, 'bad_event', 'event must be a gameweek number.');
        }
        return upstream(ev ? `/fixtures/?event=${num(ev)}` : '/fixtures/', TTL.fixtures);
      }

      case 'player': {
        const id = num(seg[1] || '');
        if (id === null) return err(400, 'bad_id', 'Expected /player/<element id>.');
        return upstream(`/element-summary/${id}/`, TTL.player);
      }

      case 'entry': {
        const id = num(seg[1] || '');
        if (id === null) return err(400, 'bad_id', 'Expected /entry/<team id>.');
        return upstream(`/entry/${id}/`, TTL.entry);
      }

      case 'picks': {
        const id = num(seg[1] || '');
        const gw = num(seg[2] || '');
        if (id === null || gw === null) return err(400, 'bad_id', 'Expected /picks/<team id>/<gameweek>.');
        return upstream(`/entry/${id}/event/${gw}/picks/`, TTL.picks);
      }

      case 'history': {
        const id = num(seg[1] || '');
        if (id === null) return err(400, 'bad_id', 'Expected /history/<team id>.');
        return upstream(`/entry/${id}/history/`, TTL.history);
      }

      case 'league': {
        const id = num(seg[1] || '');
        if (id === null) return err(400, 'bad_id', 'Expected /league/<league id>.');
        const page = num(url.searchParams.get('page') || '1') || 1;
        return upstream(`/leagues-classic/${id}/standings/?page_standings=${page}`, TTL.league);
      }

      default:
        return err(404, 'no_such_route', `Unknown route /${seg[0]}.`);
    }
  },
};
