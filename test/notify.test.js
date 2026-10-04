import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.js';
import { ConfigError } from '../src/config.js';
import {
  openDb, recordPostings, recordGate, recordScore, setVerdict, pendingLeads, recordNotified,
} from '../src/db.js';
import { makePosting } from '../src/lib/posting.js';
import { fillString, fillTemplate, normalizeNotify, buildRequest, sendLeads } from '../src/notify.js';

const NOW = new Date('2026-10-04T12:00:00Z');

function posting(overrides = {}) {
  return makePosting({
    source: 'workday:jll',
    company: 'JLL',
    title: 'Analyst, Compliance',
    location: 'Remote - US',
    url: 'https://jll.example/jobs/1',
    description: 'Body.',
    remote: true,
    salaryRaw: '$67,000 - $82,000',
    ...overrides,
  });
}

function seeded() {
  const db = openDb(':memory:');
  const good = posting();
  const low = posting({ title: 'Low scorer' });
  const judged = posting({ title: 'Already judged' });
  const rejected = posting({ title: 'Gate rejected' });
  recordPostings(db, [good, low, judged, rejected]);
  for (const p of [good, low, judged]) recordGate(db, p.hash, { result: 'pass' });
  recordGate(db, rejected.hash, { result: 'reject', reason: 'onsite' });
  recordScore(db, good.hash, { overall: 72, rationale: 'Fits "lane A".', flags: ['healthcare'] });
  recordScore(db, low.hash, { overall: 41 });
  recordScore(db, judged.hash, { overall: 80 });
  recordScore(db, rejected.hash, { overall: 90 });
  setVerdict(db, judged.hash, 'no', 'needs CRE lease admin');
  return { db, good };
}

const CONFIG = normalizeNotify({
  webhook: {
    url: 'https://tasks.example/api/tasks',
    headers: { Authorization: 'Bearer ${TOKEN}' },
    body: { title: 'Lead {{score}}: {{company}} - {{title}}', due_date: '{{today+2}}', notes: '{{salary}}\n{{rationale}}' },
  },
});

function okFetch(calls) {
  return async (url, init) => {
    calls.push({ url, ...init });
    return { ok: true, status: 201, text: async () => '' };
  };
}

function capture() {
  const out = [];
  const err = [];
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdout: () => out.join(''), stderr: () => err.join('') };
}

test('pending leads skip low scores, your verdicts, gate rejects and anything already sent', () => {
  const { db, good } = seeded();
  assert.deepEqual(pendingLeads(db, { minScore: 60 }).map((l) => l.hash), [good.hash]);
  recordNotified(db, good.hash, 'webhook');
  assert.equal(pendingLeads(db, { minScore: 60 }).length, 0);
});

test('templates fill fields, dates and environment variables', () => {
  const fields = { company: 'JLL', title: 'Analyst' };
  assert.equal(fillString('{{company}} - {{title}} by {{today+2}}', { ...fields, today: '2026-10-04' }, {}, NOW),
    'JLL - Analyst by 2026-10-06');
  assert.equal(fillString('Bearer ${TOKEN}', fields, { TOKEN: 'abc' }), 'Bearer abc');
  assert.deepEqual(fillTemplate({ n: 3, tags: ['{{company}}'] }, fields, {}), { n: 3, tags: ['JLL'] });
});

test('a typo in a template or a missing variable fails loudly instead of sending blanks', () => {
  assert.throws(() => fillString('{{compnay}}', { company: 'JLL' }, {}), ConfigError);
  assert.throws(() => fillString('${NOPE}', {}, {}), ConfigError);
});

test('a posting cannot pull an environment variable into the request', () => {
  // Postings are written by strangers. A title holding ${...} must arrive as
  // text, not as the value of whatever variable it names.
  const fields = { title: 'Analyst ${SECRET}' };
  assert.equal(fillString('{{title}}', fields, { SECRET: 'sk-live' }), 'Analyst ${SECRET}');
});

test('the request body is JSON, so quotes and newlines in a posting survive', () => {
  const { db } = seeded();
  const [lead] = pendingLeads(db, { minScore: 60 });
  const req = buildRequest(lead, CONFIG, { TOKEN: 't' }, NOW);
  assert.equal(req.headers.Authorization, 'Bearer t');
  assert.equal(req.headers['Content-Type'], 'application/json');
  const body = JSON.parse(req.body);
  assert.equal(body.title, 'Lead 72: JLL - Analyst, Compliance');
  assert.equal(body.due_date, '2026-10-06');
  assert.equal(body.notes, '$67,000-$82,000\nFits "lane A".');
});

test('sending stops at the first failure and reports only what went out', async () => {
  const leads = [{ hash: 'a'.repeat(64), company: 'A', title: 'One', overall: 70 },
    { hash: 'b'.repeat(64), company: 'B', title: 'Two', overall: 65 },
    { hash: 'c'.repeat(64), company: 'C', title: 'Three', overall: 61 }];
  let n = 0;
  const sent = [];
  const fetchImpl = async () => {
    n += 1;
    return n === 2 ? { ok: false, status: 401, text: async () => 'bad token' } : { ok: true, status: 201, text: async () => '' };
  };
  const result = await sendLeads(leads, CONFIG, { fetchImpl, env: { TOKEN: 't' }, onSent: (l) => sent.push(l.company) });
  assert.equal(result.sent, 1);
  assert.match(result.error, /HTTP 401 bad token/);
  assert.deepEqual(sent, ['A']);
  assert.equal(n, 2);
});

function cliFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deepjobs-notify-'));
  const configDir = join(dir, 'config');
  const dbPath = join(dir, 'seen.db');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'notify.yaml'), [
    'webhook:',
    '  url: https://tasks.example/api/tasks',
    '  body:',
    '    title: "{{score}} {{company}}"',
  ].join('\n'));
  const db = openDb(dbPath);
  const p = posting();
  recordPostings(db, [p]);
  recordGate(db, p.hash, { result: 'pass' });
  recordScore(db, p.hash, { overall: 75 });
  db.close();
  return { configDir, dbPath, envFile: join(dir, 'none.env') };
}

test('notify sends each lead once', async () => {
  const { configDir, dbPath, envFile } = cliFixture();
  const calls = [];
  const args = ['notify', '--config', configDir, '--db', dbPath];
  assert.equal(await main(args, capture(), { fetchImpl: okFetch(calls), envFile }), 0);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].body).title, '75 JLL');
  assert.equal(await main(args, capture(), { fetchImpl: okFetch(calls), envFile }), 0);
  assert.equal(calls.length, 1, 'the second run found nothing new');
});

test('dry run sends nothing and records nothing; baseline records without sending', async () => {
  const { configDir, dbPath, envFile } = cliFixture();
  const calls = [];
  const io = capture();
  assert.equal(await main(['notify', '--dry-run', '--config', configDir, '--db', dbPath], io, { fetchImpl: okFetch(calls), envFile }), 0);
  assert.match(io.stdout(), /POST https:\/\/tasks\.example\/api\/tasks/);
  assert.equal(calls.length, 0);

  assert.equal(await main(['notify', '--baseline', '--config', configDir, '--db', dbPath], capture(), { fetchImpl: okFetch(calls), envFile }), 0);
  assert.equal(await main(['notify', '--config', configDir, '--db', dbPath], capture(), { fetchImpl: okFetch(calls), envFile }), 0);
  assert.equal(calls.length, 0, 'baseline marked the old lead as seen');
});

test('a failed send exits non-zero and leaves the lead pending', async () => {
  const { configDir, dbPath, envFile } = cliFixture();
  const fail = async () => ({ ok: false, status: 500, text: async () => 'down' });
  const io = capture();
  assert.equal(await main(['notify', '--config', configDir, '--db', dbPath], io, { fetchImpl: fail, envFile }), 1);
  assert.match(io.stderr(), /HTTP 500 down/);
  assert.equal(pendingLeads(openDb(dbPath), { minScore: 60 }).length, 1);
});
