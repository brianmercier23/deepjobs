// The one place that talks to a board.
//
// Every endpoint here is public and unauthenticated. There is no proxy, no
// anti-bot workaround, and no account to get suspended, which is the whole
// reason this layer is the spine of the tool rather than a scraper.

export class ATSError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'ATSError';
    this.status = status;
    this.url = url;
  }
}

export const TIMEOUT_MS = 25_000;
export const RETRIES = 2;
export const BACKOFF_MS = 2_000;

/**
 * A crawler that says who it is gets tolerated. One that does not, eventually
 * does not. The contact string is configuration, never a hardcoded address.
 */
export function userAgent(contact = process.env.DEEPJOBS_CONTACT) {
  const who = contact || 'https://github.com/brianmercier23/deepjobs';
  return `deepjobs/0.1 (job search; +${who})`;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * GET returning parsed JSON.
 *
 * 404 and 429 throw immediately without retrying. A 404 is a wrong slug and
 * will be a 404 again in two seconds; a 429 means the board has already said
 * there is too much traffic, and retrying is the one response guaranteed to
 * make it worse.
 */
export async function fetchJson(url, { params = null, fetchImpl = globalThis.fetch, ...opts } = {}) {
  const target = new URL(url);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) target.searchParams.set(key, String(value));
    }
  }
  const href = target.toString();
  const retries = opts.retries ?? RETRIES;
  const timeout = opts.timeout ?? TIMEOUT_MS;
  const backoff = opts.backoff ?? BACKOFF_MS;
  // Workday's search endpoint is a POST with a JSON body. The other five are
  // plain GETs, so this stays optional rather than becoming the default shape.
  const method = opts.body ? 'POST' : (opts.method ?? 'GET');

  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(href, {
        method,
        headers: {
          'User-Agent': userAgent(opts.contact),
          Accept: 'application/json',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 404) {
        throw new ATSError(`404 (bad slug?) ${href}`, { status: 404, url: href });
      }
      if (res.status === 429) {
        throw new ATSError(`429 rate limited ${href}`, { status: 429, url: href });
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof ATSError) throw err;
      last = err;
      // Linear, not exponential. Boards recover in seconds or not at all, and
      // a long backoff just stalls the other 46 in the queue.
      if (attempt < retries) await sleep(backoff * (attempt + 1));
    }
  }
  throw new ATSError(`${last?.name ?? 'Error'}: ${last?.message ?? last} (${href})`, { url: href });
}
