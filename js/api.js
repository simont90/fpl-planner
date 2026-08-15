/**
 * Talking to the FPL API, through the worker.
 *
 * The official API sends no CORS headers, so the browser cannot call it
 * directly and everything goes via the worker in worker/. The worker returns
 * upstream bodies verbatim, so what arrives here is exactly the shape FPL
 * documents.
 *
 * Responses are held in memory for the session because the bootstrap payload
 * is 1.4 MB and nothing in it changes between switching tabs.
 */

/**
 * Where the worker lives. The deployed worker is the default so the page works
 * from a file:// open with no local process running; `?api=` overrides it for
 * pointing at `npm run worker` during development.
 */
const DEPLOYED = 'https://fpl-planner.simontariq.workers.dev';

export const API_BASE = (() => {
  try {
    const override = new URL(location.href).searchParams.get('api');
    if (override) return override.replace(/\/$/, '');
  } catch {
    /* file:// with no searchParams support — fall through to the default */
  }
  return DEPLOYED;
})();

const memo = new Map();

async function get(path, { signal } = {}) {
  if (memo.has(path)) return memo.get(path);

  const promise = (async () => {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, { signal });
    } catch (e) {
      // A failed fetch here is almost always the worker being unreachable
      // rather than a bad response, and the distinction matters to the user.
      throw new ApiError(
        `Could not reach the data service at ${API_BASE}. ` +
        `If you are running it locally, start it with \`npm run worker\`.`,
        { cause: e }
      );
    }

    let body;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(`The data service returned something that is not JSON (HTTP ${res.status}).`);
    }

    if (!res.ok) {
      throw new ApiError(body?.message || `The data service returned HTTP ${res.status}.`, {
        code: body?.error,
        status: res.status,
      });
    }
    return body;
  })();

  // Cached as the promise, not the result, so two views asking at once share
  // one request rather than both fetching 1.4 MB.
  memo.set(path, promise);
  promise.catch(() => memo.delete(path)); // a failure must not be cached
  return promise;
}

export class ApiError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const bootstrap = () => get('/bootstrap');
export const fixtures = () => get('/fixtures');
export const entry = (id) => get(`/entry/${id}`);
export const picks = (id, gw) => get(`/picks/${id}/${gw}`);
export const history = (id) => get(`/history/${id}`);
export const playerSummary = (id) => get(`/player/${id}`);

/**
 * Load a manager's real squad.
 *
 * Picks only exist for gameweeks that have started, so before the season opens
 * there is nothing to fetch — the API returns 404 for every gameweek and the
 * honest answer is that the squad does not exist yet rather than that the id
 * was wrong. This walks back from the last finished gameweek and says which
 * case it hit.
 */
export async function loadSquad(entryId, boot) {
  const finished = boot.events.filter((e) => e.finished).map((e) => e.id);
  if (!finished.length) {
    return {
      ok: false,
      reason: 'preseason',
      message:
        'No gameweek has been played yet, so FPL has no saved squad for this team. ' +
        'Build one with the optimiser and it will carry through to the other views.',
    };
  }

  const gw = Math.max(...finished);
  try {
    const [profile, pickData] = await Promise.all([entry(entryId), picks(entryId, gw)]);
    return {
      ok: true,
      gw,
      profile,
      picks: pickData.picks,
      bank: pickData.entry_history?.bank ?? 0,
      value: pickData.entry_history?.value ?? 0,
      chipsUsed: pickData.active_chip ? [pickData.active_chip] : [],
    };
  } catch (e) {
    if (e.status === 404) {
      return { ok: false, reason: 'not_found', message: `No FPL team with id ${entryId}.` };
    }
    return { ok: false, reason: 'error', message: e.message };
  }
}
