import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

import { Gate, applyGate, wordRe, FLAGS, reasonBucket } from '../src/gate.js';
import { makePosting } from '../src/lib/posting.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = parse(readFileSync(join(ROOT, 'examples/gates.example.yaml'), 'utf8'));

const gate = new Gate(CFG);

function posting(overrides = {}) {
  return makePosting({
    source: 'greenhouse:acme',
    company: 'Acme',
    title: 'Operations Analyst',
    location: 'Denver, CO',
    url: 'https://x.co/1',
    description: 'A'.repeat(400),
    ...overrides,
  });
}

test('the example config produces a working gate', () => {
  const r = gate.check(posting());
  assert.equal(r.passed, true);
  assert.ok(r.flags.includes(FLAGS.ONSITE_LOCAL));
});

test('word boundaries stop a kill term eating a real title', () => {
  // The whole reason terms are matched with boundaries: "intern" appears
  // inside "Internal", and killing internal-audit roles would be silent.
  assert.equal(gate.check(posting({ title: 'Internal Audit Manager' })).passed, true);
  assert.equal(gate.check(posting({ title: 'Marketing Intern' })).passed, false);
  assert.equal(gate.check(posting({ title: 'Internship Program' })).passed, false);
  assert.ok(wordRe('vice president').test('Vice  President of Sales'), 'spaces match any run of space');
});

test('"unpaid time off" is a benefit, not a warning', () => {
  // The negative lookahead exists for exactly this sentence, which appears in
  // a large share of benefits sections.
  const benefits = posting({ description: `Unlimited unpaid time off is available. ${'A'.repeat(300)}` });
  assert.equal(gate.check(benefits).passed, true);

  const real = posting({ description: `This is an unpaid position. ${'A'.repeat(300)}` });
  assert.equal(gate.check(real).passed, false);
  assert.match(gate.check(real).reason, /unpaid/);
});

test('a remote claim in the body is trusted only when the location is empty', () => {
  // Ads say "remote" about things that are not the job: remote monitoring,
  // remote sites, remote offices. With a real location present, the location
  // wins.
  const monitoring = posting({
    location: 'Austin, TX',
    description: `Responsible for remote monitoring of building systems. ${'A'.repeat(300)}`,
  });
  const r = gate.check(monitoring);
  assert.equal(r.passed, false);
  assert.match(r.reason, /onsite outside the Denver metro/);

  // With no location at all, the body is the only evidence there is.
  const blank = posting({
    location: '',
    remote: null,
    description: `This is a fully remote role. ${'A'.repeat(300)}`,
  });
  assert.equal(gate.check(blank).passed, true);
  assert.ok(gate.check(blank).flags.includes(FLAGS.REMOTE));
});

test('an incomplete foreign list degrades to a flag, never to a wrong reject', () => {
  // Remote in a country nobody listed: unknown, not rejected.
  const unknown = posting({ location: 'Remote - Liechtenstein', remote: true });
  const r = gate.check(unknown);
  assert.equal(r.passed, true);
  assert.ok(r.flags.includes(FLAGS.LOCATION_UNKNOWN));

  // Remote in a country that is listed: rejected.
  const known = posting({ location: 'Remote - Germany', remote: true });
  assert.equal(gate.check(known).passed, false);
  assert.match(gate.check(known).reason, /remote but non-US/);
});

test('georgia is a US state and stays out of the foreign list', () => {
  // It was left out deliberately. Putting it in silently kills every Atlanta
  // posting, and nothing would ever surface the loss.
  const atlanta = posting({ location: 'Atlanta, Georgia', remote: true });
  const r = gate.check(atlanta);
  assert.equal(r.passed, true);
  assert.ok(!r.flags.includes(FLAGS.LOCATION_UNKNOWN));
});

test('a region with no city in it goes to the rubric rather than being rejected', () => {
  // "Americas (USA or Canada)" names no workplace, so it cannot be judged too
  // far away. The US signal is required: plain "Canada" is not broad, it is a
  // different country.
  const broad = posting({ location: 'Americas (USA or Canada)' });
  const r = gate.check(broad);
  assert.equal(r.passed, true);
  assert.ok(r.flags.includes(FLAGS.LOCATION_UNKNOWN));

  const canada = posting({ location: 'Toronto, Canada' });
  assert.equal(gate.check(canada).passed, false);
});

test('ambiguous locations pass with a flag by default', () => {
  for (const location of ['Multiple locations', 'Nationwide', 'United States', 'Various']) {
    const r = gate.check(posting({ location }));
    assert.equal(r.passed, true, location);
    assert.ok(r.flags.includes(FLAGS.LOCATION_UNKNOWN), location);
  }
  const strict = new Gate({
    ...CFG,
    location: { ...CFG.location, pass_ambiguous_locations: false },
  });
  assert.equal(strict.check(posting({ location: 'Multiple locations' })).passed, false);
});

test('the home metro comes from config, and so does the reject reason', () => {
  // Nothing in the code knows where anyone lives.
  const elsewhere = new Gate({
    location: { home_metro_label: 'the Tampa metro', onsite_metros_allowed: ['tampa', 'st petersburg'] },
  });
  assert.equal(elsewhere.check(posting({ location: 'Tampa, FL' })).passed, true);
  const r = elsewhere.check(posting({ location: 'Denver, CO' }));
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'onsite outside the Tampa metro: Denver, CO');
});

test('a metro with no state still matches when the posting names the home state', () => {
  const r = gate.check(posting({ location: 'Boulder, Colorado' }));
  assert.equal(r.passed, true);
});

test('compensation flags, it does not reject', () => {
  const low = posting({ salaryRaw: '$60,000 - $70,000' });
  const r = gate.check(low);
  assert.equal(r.passed, true, 'a low salary is a flag, not a rejection');
  assert.ok(r.flags.includes(FLAGS.LOW_COMP));

  const silent = gate.check(posting());
  assert.ok(silent.flags.includes(FLAGS.NO_COMP));
  assert.equal(silent.passed, true, 'most postings state no salary at all');
});

test('a salary stated only in the body is recovered', () => {
  const p = posting({
    description: `The hiring range for this role is $120,000 - $150,000 per year. ${'A'.repeat(300)}`,
  });
  const r = gate.check(p);
  assert.equal(r.salaryMax, 150_000);
  assert.ok(!r.flags.includes(FLAGS.NO_COMP));
  assert.ok(!r.flags.includes(FLAGS.LOW_COMP));
});

test('a hard floor does reject, when one is configured', () => {
  const strict = new Gate({ ...CFG, compensation: { ...CFG.compensation, min_annual: 100_000 } });
  const r = strict.check(posting({ salaryRaw: '$60,000 - $70,000' }));
  assert.equal(r.passed, false);
  assert.match(r.reason, /below floor/);
});

test('contract and staffing are flags by default and rejects on request', () => {
  const contract = posting({ title: 'Analyst (Contract-to-Hire)' });
  assert.ok(gate.check(contract).flags.includes(FLAGS.CONTRACT));
  assert.equal(gate.check(contract).passed, true);

  const strict = new Gate({ ...CFG, employment_type: { contract_mode: 'reject' } });
  assert.equal(strict.check(contract).passed, false);

  const agency = posting({ company: 'Robert Half' });
  assert.ok(gate.check(agency).flags.includes(FLAGS.STAFFING));
  assert.equal(gate.check(agency).passed, true, 'agencies do carry real roles');
});

test('a thin description is flagged for the scorer to notice', () => {
  assert.ok(gate.check(posting({ description: 'Short.' })).flags.includes(FLAGS.THIN));
});

test('relocation and commission-only are rejections', () => {
  const relo = posting({ description: `The candidate must relocate to Austin. ${'A'.repeat(300)}` });
  assert.equal(gate.check(relo).passed, false);
  const comm = posting({ description: `This is a commission-only role. ${'A'.repeat(300)}` });
  assert.equal(gate.check(comm).passed, false);
});

test('applyGate returns survivors, rejections and a reason histogram', () => {
  const batch = [
    posting({ title: 'Operations Analyst' }),
    posting({ title: 'Marketing Intern' }),
    posting({ title: 'Data Analyst', location: 'Austin, TX' }),
    posting({ title: 'Ops Analyst', location: 'Dallas, TX' }),
  ];
  const { passed, rejected, reasons } = applyGate(batch, CFG);
  assert.equal(passed.length, 1);
  assert.equal(rejected.length, 3);
  // The histogram is how anyone notices the gate has become too tight.
  assert.equal(reasons.get('onsite outside'), 2);
  assert.equal(reasons.get('title contains'), 1);
  assert.ok(passed[0].flags.includes(FLAGS.ONSITE_LOCAL));
});

test('a remote claim the body contradicts is caught for free', () => {
  // The improvement over filtering on structured metadata. Every other job
  // tool trusts the remote flag, so these postings pass every filter and are
  // only caught by a human reading the body, or by an LLM already paid for.
  const p = posting({
    location: 'Remote - US',
    remote: true,
    description: `Great remote role. You will be expected to work on-site 3 days per week in our Chicago office. ${'A'.repeat(300)}`,
  });
  const r = gate.check(p);
  assert.equal(r.passed, true, 'flagged by default, not rejected');
  assert.ok(r.flags.includes(FLAGS.REMOTE_CONTRADICTED));

  const strict = new Gate({
    ...CFG,
    location: { ...CFG.location, reject_contradicted_remote: true },
  });
  const rejected = strict.check(p);
  assert.equal(rejected.passed, false);
  assert.equal(rejected.reason, 'declared remote, body requires time on site');
});

test('a geographic limit is a different thing from an office requirement', () => {
  // "must be located in Eastern or Central Timezones" asks for no office time
  // at all. It is still a real limit on who can take the job, so it gets its
  // own flag rather than one that claims the body wants you on site.
  const p = posting({
    location: 'Remote, United States',
    remote: true,
    description: `This person must be located in Eastern or Central Timezones. ${'A'.repeat(300)}`,
  });
  const r = gate.check(p);
  assert.ok(r.flags.includes(FLAGS.REMOTE_GEO_LIMITED));
  assert.ok(!r.flags.includes(FLAGS.REMOTE_CONTRADICTED));
});

test('benefits boilerplate is not an on-site requirement', () => {
  // Measured against the live corpus: a bare "hybrid" pattern matched "a
  // flexible hybrid work model that balances remote focus with vibrant office
  // collaboration" and mislabelled genuinely remote roles at three companies.
  // It went from 25 catches to 7 real ones when that pattern came out.
  const boilerplate = posting({
    location: 'Remote - US',
    remote: true,
    description: `We offer a flexible hybrid work model that balances remote focus with vibrant office collaboration. We have offices in Austin and Denver. ${'A'.repeat(300)}`,
  });
  const r = gate.check(boilerplate);
  assert.ok(!r.flags.includes(FLAGS.REMOTE_CONTRADICTED));
  assert.ok(!r.flags.includes(FLAGS.REMOTE_GEO_LIMITED));
});

test('the body check can be switched off', () => {
  const off = new Gate({ ...CFG, location: { ...CFG.location, check_remote_claim_against_body: false } });
  const p = posting({
    location: 'Remote - US',
    remote: true,
    description: `Must work on-site 3 days per week in the office. ${'A'.repeat(300)}`,
  });
  assert.ok(!off.check(p).flags.includes(FLAGS.REMOTE_CONTRADICTED));
});

test('reasonBucket collapses per-posting detail into countable categories', () => {
  assert.equal(reasonBucket('onsite outside the Denver metro: Austin, TX'), 'onsite outside');
  assert.equal(reasonBucket('remote but non-US: Berlin, Germany'), 'remote but non-US');
  assert.equal(reasonBucket('unpaid role'), 'unpaid role');
  assert.equal(reasonBucket(null), 'unknown');
});
