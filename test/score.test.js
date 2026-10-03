import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DIMENSIONS,
  FLAG_SUBSCORE_MISMATCH,
  MAX_DESCRIPTION_CHARS,
  MODEL,
  PRICING,
  FatalScoreError,
  ScoreError,
  Usage,
  applyCaps,
  normalizeCaps,
  cleanRationale,
  createClient,
  isFatalApiError,
  formatPosting,
  loadRubric,
  parseVerdict,
  scoreAll,
  scoreOne,
  systemPrompt,
} from '../src/score.js';
import { makePosting } from '../src/lib/posting.js';
import { openDb, recordPostings, recordScore, report } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUBRIC = loadRubric(join(ROOT, 'examples/rubric.example.md'));

// A client that returns canned text. Every test in this file runs with no API
// key and no network; the one stage that costs money is also the one stage a
// contributor is least able to run, so it has to be testable without spending.
function fakeClient(replies, { usage = { input_tokens: 100, output_tokens: 50 } } = {}) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return { content: [{ type: 'text', text: next }], usage };
      },
    },
  };
}

const VERDICT = JSON.stringify({
  score: 78,
  dimensions: { location: 25, capability: 20, domain: 11, build: 12, seniority: 6, signal: 4 },
  rationale: 'Remote ops role where the automation is the job.',
  flags: ['remote'],
});

function posting(fields = {}) {
  return makePosting({
    company: 'Acme',
    title: 'Operations Analyst',
    location: 'Remote - US',
    description: 'Automate a manual reconciliation process. Python, SQL.',
    ...fields,
  });
}

// --------------------------------------------------------------------------
// the prompt

test('the system prompt is the user rubric plus a fixed output contract', () => {
  const prompt = systemPrompt(RUBRIC);
  assert.ok(prompt.startsWith('# Scoring rubric'));
  assert.ok(prompt.includes('Return only JSON'));
  assert.ok(prompt.includes("rubric's verdict"));
  // Every dimension key the parser reads must be named in the contract, or the
  // model has no way to know what to send back.
  for (const d of DIMENSIONS) assert.ok(prompt.includes(`"${d.key}"`), d.key);
});

test('the rubric is rejected when it is missing or obviously unfinished', () => {
  assert.throws(() => loadRubric(join(ROOT, 'config/does-not-exist.md')), ScoreError);
  assert.throws(() => loadRubric(join(ROOT, 'data/.gitkeep')), /truncated/);
});

test('a posting renders with the deciding fields first', () => {
  const text = formatPosting(posting({ remote: true, salaryMin: 90_000, salaryMax: 120_000 }));
  const lines = text.split('\n');
  assert.equal(lines[0], 'Company: Acme');
  assert.equal(lines[1], 'Title: Operations Analyst');
  assert.equal(lines[2], 'Location: Remote - US');
  assert.ok(text.includes('Board says remote: true'));
  assert.ok(text.includes('Compensation: $90,000 - $120,000'));
});

test('what the board did not say is said explicitly, not left blank', () => {
  const text = formatPosting(posting({ location: '', remote: null }));
  assert.ok(text.includes('Location: (not stated)'));
  assert.ok(text.includes('Compensation: (not disclosed)'));
  // A null remote is the board declining to say. Printing "Board says remote:
  // null" would read as a denial, which is a different claim.
  assert.ok(!text.includes('Board says remote'));
});

test('gate flags reach the model, deduplicated', () => {
  const p = posting();
  p.flags = ['REMOTE', 'NO_COMP_DISCLOSED'];
  const text = formatPosting(p, { flags: ['REMOTE', 'THIN_DESCRIPTION'] });
  assert.ok(text.includes('Gate flags: REMOTE, NO_COMP_DISCLOSED, THIN_DESCRIPTION'));
});

test('a long description is cut at a line break and says that it was cut', () => {
  // Sized off the constant so the fixture stays longer than the cut.
  const body = `${'word '.repeat(Math.ceil(MAX_DESCRIPTION_CHARS / 5))}\n${'tail '.repeat(200)}`;
  const text = formatPosting(posting({ description: body }));
  assert.ok(text.includes('[description truncated]'));
  const desc = text.split('Description:\n')[1];
  assert.ok(desc.length < MAX_DESCRIPTION_CHARS + 100);
  // Cutting mid-word would make the posting read as thinner than it is.
  assert.ok(!/\bwor$/m.test(desc));
});

// --------------------------------------------------------------------------
// the rationale

test('the rationale is trimmed in code, because the prompt is ignored', () => {
  const long = 'This is a genuinely excellent fully remote operations analyst role at a credible company with real process ownership and meaningful automation scope, although the domain transfers less directly than ideal';
  const out = cleanRationale(long);
  assert.ok(out.split(' ').length <= 30);
  assert.ok(!out.endsWith(','));
});

test('the joints a second clause hangs off are removed', () => {
  assert.equal(cleanRationale('Remote role — the body requires onsite'), 'Remote role, the body requires onsite');
  assert.equal(cleanRationale('Strong fit; comp undisclosed'), 'Strong fit, comp undisclosed');
  assert.equal(cleanRationale('  ragged   whitespace  '), 'Ragged whitespace');
  assert.equal(cleanRationale(null), '');
});

// --------------------------------------------------------------------------
// the parser

test('a clean JSON verdict parses into the six database fields', () => {
  const v = parseVerdict(VERDICT);
  assert.equal(v.overall, 78);
  assert.equal(v.locationViability, 25);
  assert.equal(v.capabilityOverlap, 20);
  assert.equal(v.signalQuality, 4);
  assert.deepEqual(v.flags, ['remote']);
});

test('a fenced or prose-prefixed response still parses', () => {
  assert.equal(parseVerdict('```json\n' + VERDICT + '\n```').overall, 78);
  assert.equal(parseVerdict(`Here is my assessment:\n\n${VERDICT}\n\nHope that helps.`).overall, 78);
});

test('a rubric that never mentions the dimensions still produces a score', () => {
  const v = parseVerdict('{"score": 61, "rationale": "Fine."}');
  assert.equal(v.overall, 61);
  for (const d of DIMENSIONS) assert.equal(v[d.field], null);
  // No sub-scores means nothing to disagree with, so no mismatch flag.
  assert.deepEqual(v.flags, []);
});

test('out-of-range numbers are clamped to what the rubric allows', () => {
  const v = parseVerdict('{"score": 140, "dimensions": {"location": 99, "signal": -5}}');
  assert.equal(v.overall, 100);
  assert.equal(v.locationViability, 25);
  assert.equal(v.signalQuality, 0);
});

test('a total the six parts do not support is flagged, not quietly corrected', () => {
  // The total stays authoritative: the rubric's bands are calibrated against
  // it. Rewriting one of two numbers the model gave you makes the scorer
  // impossible to debug later.
  const v = parseVerdict(JSON.stringify({
    score: 90,
    dimensions: { location: 5, capability: 5, domain: 5, build: 5, seniority: 5, signal: 5 },
  }));
  assert.equal(v.overall, 90);
  assert.equal(v.subtotal, 30);
  assert.ok(v.flags.includes(FLAG_SUBSCORE_MISMATCH));
});

test('a total below the sum of its parts is a rubric override, not an error', () => {
  // Every cap or automatic-low-score rule a rubric can state pushes the number
  // down. Flagging that direction fired on 24 of 28 postings and meant nothing.
  const v = parseVerdict(JSON.stringify({
    score: 28,
    dimensions: { location: 25, capability: 18, domain: 15, build: 12, seniority: 7, signal: 10 },
  }));
  assert.equal(v.subtotal, 87);
  assert.equal(v.flags.length, 0);
});

test('rounding-sized disagreement is not worth telling anyone about', () => {
  const v = parseVerdict(JSON.stringify({
    score: 80,
    dimensions: { location: 25, capability: 20, domain: 11, build: 12, seniority: 6, signal: 4 },
  }));
  assert.equal(v.flags.length, 0);
  assert.equal(v.subtotal, 78);
});

test('a lone flag string is accepted as a list of one', () => {
  assert.deepEqual(parseVerdict('{"score": 50, "flags": "hybrid"}').flags, ['hybrid']);
});

test('a response with no usable verdict raises rather than scoring zero', () => {
  assert.throws(() => parseVerdict('I cannot evaluate this posting.'), ScoreError);
  assert.throws(() => parseVerdict('{"rationale": "no score here"}'), /missing "score"/);
  assert.throws(() => parseVerdict('{"score": "excellent"}'), /non-numeric/);
});

// --------------------------------------------------------------------------
// accounting

test('cost accounting prices cached tokens at the cached rate', () => {
  const usage = new Usage();
  usage.add({ input_tokens: 1_000_000, output_tokens: 0 });
  assert.equal(usage.costUsd, PRICING.input);

  const cached = new Usage();
  cached.add({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 });
  assert.equal(cached.costUsd, PRICING.cacheRead);
  // The comparison line the run summary prints only means something if the
  // uncached figure prices those same tokens at full rate.
  assert.equal(cached.costWithoutCacheUsd, PRICING.input);
});

// --------------------------------------------------------------------------
// the call

test('a scored posting carries the model and merges gate flags with the model flags', async () => {
  const client = fakeClient(VERDICT);
  const p = posting();
  p.flags = ['REMOTE'];
  const score = await scoreOne(p, { rubric: RUBRIC, client });

  assert.equal(score.hash, p.hash);
  assert.equal(score.model, MODEL);
  assert.equal(score.overall, 78);
  assert.deepEqual(score.flags, ['REMOTE', 'remote']);

  const sent = client.calls[0];
  assert.equal(sent.model, MODEL);
  // The rubric is byte-identical on every call in a run, so it is worth caching.
  assert.equal(sent.system[0].cache_control.type, 'ephemeral');
});

test('a garbled response is retried before it is given up on', async () => {
  const client = fakeClient(['not json at all', VERDICT]);
  const score = await scoreOne(posting(), { rubric: RUBRIC, client });
  assert.equal(score.overall, 78);
  assert.equal(client.calls.length, 2);
});

test('one unscorable posting does not cost the rest of the run', async () => {
  let n = 0;
  const client = {
    messages: {
      async create() {
        n += 1;
        // The second posting never returns anything parseable, on any attempt.
        if (n >= 2 && n <= 4) return { content: [{ type: 'text', text: 'nope' }], usage: {} };
        return { content: [{ type: 'text', text: VERDICT }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };

  const errors = [];
  const { scores, usage } = await scoreAll(
    [posting({ title: 'A' }), posting({ title: 'B' }), posting({ title: 'C' })],
    { rubric: RUBRIC, client, concurrency: 1, onError: (err) => errors.push(err) },
  );

  assert.equal(scores.length, 2);
  assert.equal(usage.failures, 1);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof ScoreError);
});

test('--limit stops before the postings do', async () => {
  const client = fakeClient(VERDICT);
  const { scores } = await scoreAll(
    [posting({ title: 'A' }), posting({ title: 'B' }), posting({ title: 'C' })],
    { rubric: RUBRIC, client, limit: 2 },
  );
  assert.equal(scores.length, 2);
});

test('the worker pool scores every posting exactly once', async () => {
  const seen = [];
  const client = {
    messages: {
      async create(params) {
        seen.push(params.messages[0].content);
        await new Promise((r) => { setTimeout(r, 1); });
        return { content: [{ type: 'text', text: VERDICT }], usage: {} };
      },
    },
  };
  const batch = Array.from({ length: 9 }, (_, i) => posting({ title: `Role ${i}` }));
  const { scores } = await scoreAll(batch, { rubric: RUBRIC, client, concurrency: 4 });

  assert.equal(scores.length, 9);
  assert.equal(new Set(seen).size, 9);
});

test('scoring refuses to start without a key rather than failing per posting', async () => {
  await assert.rejects(() => createClient({ apiKey: '' }), /ANTHROPIC_API_KEY/);
});

test('a score carries what that one posting cost, in the shape the db stores', async () => {
  const client = fakeClient(VERDICT, { usage: { input_tokens: 2000, output_tokens: 100 } });
  const score = await scoreOne(posting(), { rubric: RUBRIC, client });
  assert.equal(score.inputTokens, 2000);
  assert.equal(score.outputTokens, 100);
  assert.ok(Math.abs(score.costUsd - (2000 * PRICING.input + 100 * PRICING.output) / 1e6) < 1e-12);
});

test('a score round-trips through the database with every dimension intact', () => {
  const db = openDb(':memory:');
  const p = posting();
  recordPostings(db, [p]);
  recordScore(db, p.hash, { ...parseVerdict(VERDICT), model: MODEL, inputTokens: 10, outputTokens: 2, costUsd: 0.0001 });

  const [row] = report(db, { minScore: 0 });
  assert.equal(row.overall, 78);
  assert.equal(row.band, 'Strong');
  assert.equal(row.dimensions.locationViability, 25);
  assert.equal(row.dimensions.signalQuality, 4);
  // Columns nothing reads are columns that quietly stop being written.
  assert.equal(row.dimensions.capabilityOverlap, 20);
});

// --------------------------------------------------------------------------
// Fatal API conditions
//
// A spent credit balance is not a property of the posting being scored, so
// retrying it per posting is wasted money-less effort: 800 postings times
// three attempts is 2,400 calls that cannot succeed, and the rate limit is
// gone by the end of it.
// --------------------------------------------------------------------------

function apiError(message, status) {
  const err = new Error(message);
  if (status !== undefined) err.status = status;
  return err;
}

test('an auth failure is fatal, a rate limit is not', () => {
  assert.equal(isFatalApiError(apiError('invalid x-api-key', 401)), true);
  assert.equal(isFatalApiError(apiError('forbidden', 403)), true);
  assert.equal(isFatalApiError(apiError('payment required', 402)), true);
  assert.equal(isFatalApiError(apiError('rate limited', 429)), false);
  assert.equal(isFatalApiError(apiError('overloaded', 529)), false);
  assert.equal(isFatalApiError(apiError('bad gateway', 502)), false);
  assert.equal(isFatalApiError(null), false);
});

test('an exhausted balance is recognised by its message, not its status', () => {
  // This is the one that stranded 244 postings. It arrives as a 400, which is
  // otherwise an ordinary retryable bad request.
  const err = apiError('Your credit balance is too low to access the Anthropic API', 400);
  assert.equal(isFatalApiError(err), true);
});

test('scoreOne does not retry a fatal error', async () => {
  const client = fakeClient(apiError('invalid x-api-key', 401));
  await assert.rejects(
    () => scoreOne(makePosting({ company: 'Acme', title: 'Analyst', description: 'x' }), {
      rubric: RUBRIC, client,
    }),
    (err) => err instanceof FatalScoreError,
  );
  // One attempt, not RETRIES + 1.
  assert.equal(client.calls.length, 1);
});

test('scoreOne still retries an ordinary failure', async () => {
  const client = fakeClient([apiError('overloaded', 529), apiError('overloaded', 529), VERDICT]);
  const score = await scoreOne(
    makePosting({ company: 'Acme', title: 'Analyst', description: 'x' }),
    { rubric: RUBRIC, client },
  );
  assert.equal(score.overall, 78);
  assert.equal(client.calls.length, 3);
});

test('scoreAll stops the batch on a fatal error and reports it', async () => {
  const batch = Array.from({ length: 40 }, (_, i) => makePosting({
    company: `Co ${i}`, title: 'Analyst', description: 'x',
  }));
  const client = fakeClient(apiError('credit balance is too low', 400));
  const { scores, aborted } = await scoreAll(batch, {
    rubric: RUBRIC, client, concurrency: 4,
  });

  assert.equal(scores.length, 0);
  assert.ok(aborted instanceof FatalScoreError);
  // Four workers can each be mid-call when the first one fails, so the bound is
  // the pool size, not one. What matters is that it is nowhere near 40.
  assert.ok(client.calls.length <= 4, `expected <= 4 calls, got ${client.calls.length}`);
});

test('a fatal error keeps the scores that already landed', async () => {
  const batch = Array.from({ length: 6 }, (_, i) => makePosting({
    company: `Co ${i}`, title: 'Analyst', description: 'x',
  }));
  // Serial, so the ordering is deterministic: two succeed, then the balance goes.
  const client = fakeClient([VERDICT, VERDICT, apiError('credit balance is too low', 400)]);
  const { scores, aborted } = await scoreAll(batch, {
    rubric: RUBRIC, client, concurrency: 1,
  });

  assert.equal(scores.length, 2);
  assert.ok(aborted instanceof FatalScoreError);
});

test('scoreAll returns aborted null on a clean run', async () => {
  const batch = [makePosting({ company: 'Acme', title: 'Analyst', description: 'x' })];
  const { scores, aborted } = await scoreAll(batch, { rubric: RUBRIC, client: fakeClient(VERDICT) });
  assert.equal(scores.length, 1);
  assert.equal(aborted, null);
});

// --------------------------------------------------------------------------
// caps

test('a flag with a cap holds the total down and records what the model said', () => {
  const v = applyCaps({ overall: 92, flags: ['remote', 'tech_role'] }, { tech_role: 30 });
  assert.equal(v.overall, 30);
  assert.deepEqual(v.flags, ['remote', 'tech_role', 'capped_tech_role_from_92']);
});

test('the lowest matching cap wins and matching ignores case', () => {
  const caps = normalizeCaps({ swe_role: 30, ONSITE: 20 });
  const v = applyCaps({ overall: 80, flags: ['SWE_ROLE', 'onsite'] }, caps);
  assert.equal(v.overall, 20);
  assert.ok(v.flags.includes('capped_onsite_from_80'));
});

test('a total already under the cap, or with no capped flag, is left alone', () => {
  const under = { overall: 25, flags: ['tech_role'] };
  assert.equal(applyCaps(under, { tech_role: 30 }), under);
  const none = { overall: 90, flags: ['remote'] };
  assert.equal(applyCaps(none, { tech_role: 30 }), none);
  assert.equal(applyCaps(none, {}), none);
  assert.equal(applyCaps(none, null), none);
});

test('score_caps rejects anything that is not a whole number from 0 to 100', () => {
  assert.deepEqual(normalizeCaps(undefined), {});
  assert.deepEqual(normalizeCaps({}), {});
  assert.throws(() => normalizeCaps(['onsite']), ScoreError);
  assert.throws(() => normalizeCaps({ onsite: 'low' }), ScoreError);
  assert.throws(() => normalizeCaps({ onsite: 120 }), ScoreError);
});

test('scoreOne applies caps to gate flags as well as the model flags', async () => {
  const p = posting();
  p.flags = ['REMOTE_CONTRADICTED'];
  const score = await scoreOne(p, { rubric: RUBRIC, client: fakeClient(VERDICT), caps: { remote_contradicted: 20 } });
  assert.equal(score.overall, 20);
  assert.ok(score.flags.includes('capped_remote_contradicted_from_78'));
});
