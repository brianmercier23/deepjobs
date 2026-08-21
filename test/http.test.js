import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchJson, ATSError, userAgent } from '../src/collectors/http.js';
import { fetchAll } from '../src/collectors/index.js';

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url) => {
    calls.push(url);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      status: next.status ?? 200,
      ok: (next.status ?? 200) < 400,
      json: async () => next.body ?? {},
    };
  };
  impl.calls = calls;
  return impl;
}

test('the User-Agent says who is calling', () => {
  assert.match(userAgent('someone@example.com'), /^deepjobs\/[\d.]+ \(job search; \+someone@example\.com\)$/);
  // Never a hardcoded personal address: with nothing configured it falls back
  // to the project URL.
  assert.match(userAgent(''), /github\.com/);
});

test('params are appended to the URL', async () => {
  const impl = fakeFetch([{ body: { ok: true } }]);
  await fetchJson('https://example.com/jobs', { params: { content: 'true', limit: 100 }, fetchImpl: impl });
  assert.match(impl.calls[0], /\?content=true&limit=100$/);
});

test('null params are dropped rather than sent as "null"', async () => {
  const impl = fakeFetch([{ body: {} }]);
  await fetchJson('https://example.com/jobs', { params: { a: 1, b: null, c: undefined }, fetchImpl: impl });
  assert.match(impl.calls[0], /\?a=1$/);
});

test('404 throws immediately and does not retry', async () => {
  const impl = fakeFetch([{ status: 404 }]);
  await assert.rejects(
    () => fetchJson('https://example.com/nope', { fetchImpl: impl, backoff: 0 }),
    (err) => err instanceof ATSError && err.status === 404,
  );
  // A bad slug will still be a bad slug in two seconds.
  assert.equal(impl.calls.length, 1);
});

test('429 throws immediately and does not retry', async () => {
  const impl = fakeFetch([{ status: 429 }]);
  await assert.rejects(
    () => fetchJson('https://example.com/busy', { fetchImpl: impl, backoff: 0 }),
    (err) => err instanceof ATSError && err.status === 429,
  );
  // The board has already said there is too much traffic. Retrying is the one
  // response guaranteed to make it worse.
  assert.equal(impl.calls.length, 1);
});

test('a transient failure is retried, then succeeds', async () => {
  const impl = fakeFetch([{ status: 503 }, { body: { jobs: [] } }]);
  const data = await fetchJson('https://example.com/flaky', { fetchImpl: impl, backoff: 0 });
  assert.deepEqual(data, { jobs: [] });
  assert.equal(impl.calls.length, 2);
});

test('retries are bounded and then reported as an ATSError', async () => {
  const impl = fakeFetch([new Error('ECONNRESET')]);
  await assert.rejects(
    () => fetchJson('https://example.com/down', { fetchImpl: impl, backoff: 0, retries: 2 }),
    (err) => err instanceof ATSError && /ECONNRESET/.test(err.message),
  );
  assert.equal(impl.calls.length, 3); // the first try plus two retries
});

test('one board going down never aborts the run', async () => {
  const impl = async (url) => {
    if (url.includes('/broken/')) return { status: 404, ok: false, json: async () => ({}) };
    return {
      status: 200,
      ok: true,
      json: async () => ({ jobs: [{ title: 'Analyst', location: { name: 'Remote' } }] }),
    };
  };
  const { postings, failures } = await fetchAll(
    [
      { platform: 'greenhouse', slug: 'working' },
      { platform: 'greenhouse', slug: 'broken' },
      { platform: 'greenhouse', slug: 'alsoworking' },
    ],
    { fetchImpl: impl, backoff: 0 },
  );

  // A crawl that stops at the second of forty-seven boards and says nothing
  // is worse than one that finishes and names what was down.
  assert.equal(postings.length, 2);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].slug, 'broken');
  assert.match(failures[0].error, /404/);
});

test('an unknown platform is an error, not a silent skip', async () => {
  const { failures } = await fetchAll([{ platform: 'monster.com', slug: 'x' }], { backoff: 0 });
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /unknown ATS platform/);
});
