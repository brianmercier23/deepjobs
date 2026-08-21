import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  openDb, splitNew, recordPostings, touchSeen, getPosting, markWritten,
  recordGate, recordScore, setVerdict, getVerdict, upsertBoard, boards,
  report, stats, scoreBand, SCHEMA_VERSION,
} from '../src/db.js';
import { makePosting } from '../src/lib/posting.js';

function db() {
  return openDb(':memory:');
}

function posting(overrides = {}) {
  return makePosting({
    source: 'greenhouse:acme',
    company: 'Acme Inc',
    title: 'Operations Analyst',
    location: 'Remote - US',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    description: 'Full body text.',
    remote: true,
    ...overrides,
  });
}

test('schema applies and stamps a version', () => {
  const d = db();
  assert.equal(d.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
});

test('a posting round-trips, tri-state and all', () => {
  const d = db();
  const p = posting({ salaryRaw: '$120,000 - $150,000' });
  recordPostings(d, [p]);

  const got = getPosting(d, p.hash);
  assert.equal(got.company, 'Acme Inc');
  assert.equal(got.description, 'Full body text.');
  assert.equal(got.remote, true);
  // Parsed out of salaryRaw by makePosting, not by the caller.
  assert.equal(got.salaryMin, 120_000);
  assert.equal(got.salaryMax, 150_000);
  assert.deepEqual(got.tags, []);
});

test('remote survives the round trip as three distinct values', () => {
  const d = db();
  const yes = posting({ title: 'A', remote: true });
  const no = posting({ title: 'B', remote: false });
  const unsaid = posting({ title: 'C', remote: null });
  recordPostings(d, [yes, no, unsaid]);

  assert.equal(getPosting(d, yes.hash).remote, true);
  assert.equal(getPosting(d, no.hash).remote, false);
  // The one that matters: not-said must not come back as not-remote.
  assert.equal(getPosting(d, unsaid.hash).remote, null);
});

test('splitNew dedupes against the database and within the batch', () => {
  const d = db();
  const first = posting({ title: 'Operations Analyst' });
  recordPostings(d, [first]);

  const again = posting({ title: 'Operations Analyst (Remote) - R12345' });
  const other = posting({ title: 'Data Analyst' });
  // Same job from two boards on the same morning, plus the one already on file.
  const fresh = splitNew(d, [again, other, { ...other }]);

  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].hash, other.hash);
});

test('a re-run may add information and may never remove it', () => {
  const d = db();
  const full = posting({ description: 'The whole body.', salaryRaw: '$120,000 - $150,000' });
  recordPostings(d, [full]);

  // The shape a list endpoint returns: same job, no description, no salary.
  // Written without COALESCE this blanks out a body already fetched and paid
  // for, and the gate then has nothing to read.
  const thin = posting({ description: '', salaryRaw: null, remote: null });
  recordPostings(d, [thin]);

  const got = getPosting(d, full.hash);
  assert.equal(got.description, 'The whole body.');
  assert.equal(got.salaryMax, 150_000);
  assert.equal(got.remote, true);
});

test('a re-run cannot reach a human verdict', () => {
  const d = db();
  const p = posting();
  recordPostings(d, [p]);
  setVerdict(d, p.hash, 'Applied', 'Worth a shot.');

  recordPostings(d, [posting({ description: '' })]);

  assert.deepEqual(getVerdict(d, p.hash), { verdict: 'Applied', why: 'Worth a shot.' });
});

test('a re-run cannot wipe a score that was already paid for', () => {
  const d = db();
  const p = posting();
  recordPostings(d, [p]);
  recordScore(d, p.hash, {
    model: 'claude-haiku-4-5-20251001',
    overall: 78,
    locationViability: 25,
    capabilityOverlap: 20,
    domainLeverage: 12,
    buildLatitude: 11,
    seniorityFit: 6,
    signalQuality: 4,
    rationale: 'Automation is the job.',
    costUsd: 0.0034,
  });

  recordPostings(d, [posting()]);

  const [row] = report(d, { minScore: 0 });
  assert.equal(row.overall, 78);
  assert.equal(row.band, 'Strong');
  assert.equal(row.rationale, 'Automation is the job.');
});

test('markWritten is idempotent', () => {
  const d = db();
  const p = posting();
  recordPostings(d, [p]);

  assert.equal(markWritten(d, [p.hash]), 1);
  // The second run reports nothing, which is what stops yesterday's list
  // being re-sent every morning.
  assert.equal(markWritten(d, [p.hash]), 0);
  assert.ok(getPosting(d, p.hash).writtenAt);
});

test('touchSeen bumps last_seen without touching anything else', () => {
  const d = db();
  const p = posting();
  recordPostings(d, [p]);
  const before = getPosting(d, p.hash);

  assert.equal(touchSeen(d, [p]), 1);
  const after = getPosting(d, p.hash);
  assert.equal(after.description, before.description);
  assert.ok(after.lastSeen >= before.lastSeen);
});

test('gate results and flags round-trip as arrays', () => {
  const d = db();
  const p = posting();
  recordPostings(d, [p]);
  recordGate(d, p.hash, { result: 'reject', reason: 'onsite outside the home metro', flags: ['HYBRID'] });
  recordGate(d, p.hash, { result: 'pass', reason: null, flags: ['LOW_COMP', 'CONTRACT'] });

  const row = d.prepare('SELECT * FROM gate_result WHERE hash = ?').get(p.hash);
  assert.equal(row.result, 'pass');
  assert.deepEqual(JSON.parse(row.flags), ['LOW_COMP', 'CONTRACT']);
});

test('boards carry acquisition provenance', () => {
  const d = db();
  // The case this exists for: the company still exists, the board does not,
  // and the postings show up under the acquirer.
  upsertBoard(d, { platform: 'workday', slug: 'jll', name: 'Building Engines', parent: 'JLL' });
  upsertBoard(d, { platform: 'workday', slug: 'jll', lastCount: 2000, lastOk: '2026-08-20T00:00:00Z' });

  const [row] = boards(d);
  assert.equal(row.parent, 'JLL');
  assert.equal(row.name, 'Building Engines'); // not clobbered by the second write
  assert.equal(row.last_count, 2000);
});

test('deleting a posting takes its dependent rows with it', () => {
  const d = db();
  const p = posting();
  recordPostings(d, [p]);
  recordGate(d, p.hash, { result: 'pass' });
  recordScore(d, p.hash, { overall: 70 });

  d.prepare('DELETE FROM posting WHERE hash = ?').run(p.hash);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM gate_result').get().n, 0);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM score').get().n, 0);
});

test('report filters on score and on the ai-forward tag', () => {
  const d = db();
  const forward = posting({ title: 'Automation Engineer', tags: ['mcp'], aiForward: true });
  const legacy = posting({ title: 'LMS Administrator', tags: ['addie'], aiForward: false });
  recordPostings(d, [forward, legacy]);
  recordScore(d, forward.hash, { overall: 81 });
  recordScore(d, legacy.hash, { overall: 32 });

  assert.equal(report(d, { minScore: 0 }).length, 2);
  assert.equal(report(d, { minScore: 60 }).length, 1);
  assert.equal(report(d, { minScore: 0, aiForwardOnly: true })[0].title, 'Automation Engineer');
  // Highest first, because that is the order anyone reads it in.
  assert.deepEqual(report(d, { minScore: 0 }).map((r) => r.overall), [81, 32]);
});

test('stats counts the funnel', () => {
  const d = db();
  const a = posting({ title: 'A', aiForward: true });
  const b = posting({ title: 'B' });
  recordPostings(d, [a, b]);
  recordGate(d, a.hash, { result: 'pass' });
  recordGate(d, b.hash, { result: 'reject', reason: 'LOW_COMP' });
  recordScore(d, a.hash, { overall: 70, costUsd: 0.0034 });
  markWritten(d, [a.hash]);
  setVerdict(d, a.hash, 'Applied');

  const s = stats(d);
  assert.equal(s.total, 2);
  assert.equal(s.ai_forward, 1);
  assert.equal(s.gate_passed, 1);
  assert.equal(s.scored, 1);
  assert.equal(s.written, 1);
  assert.equal(s.with_verdict, 1);
  assert.ok(Math.abs(s.cost_usd - 0.0034) < 1e-9);
});

test('scoreBand covers every range including nothing', () => {
  assert.equal(scoreBand(75), 'Strong');
  assert.equal(scoreBand(74), 'Good');
  assert.equal(scoreBand(60), 'Good');
  assert.equal(scoreBand(45), 'Moderate');
  assert.equal(scoreBand(30), 'Weak');
  assert.equal(scoreBand(29), 'Poor');
  assert.equal(scoreBand(null), null);
});
