import { test } from 'node:test';
import assert from 'node:assert/strict';

import { htmlToText, unescapeHtml } from '../src/lib/text.js';
import { normCompany, normTitle, normLocation, computeHash } from '../src/lib/normalize.js';
import { parseSalary } from '../src/lib/salary.js';
import { foldRemote } from '../src/lib/remote.js';

// --------------------------------------------------------------------------
// text
// --------------------------------------------------------------------------

test('htmlToText unescapes as many times as it takes', () => {
  const cases = [
    ['<p>Hello</p>', 'Hello'],
    ['&lt;p&gt;Hello&lt;/p&gt;', 'Hello'],
    ['&amp;lt;p&amp;gt;Hello&amp;lt;/p&amp;gt;', 'Hello'],
    ['&amp;amp;lt;p&amp;amp;gt;Hello&amp;amp;lt;/p&amp;amp;gt;', 'Hello'],
  ];
  for (const [input, want] of cases) {
    assert.equal(htmlToText(input), want, `input: ${input}`);
  }
});

test('htmlToText keeps block structure and drops script and style', () => {
  assert.equal(htmlToText('<ul><li>One</li><li>Two</li></ul>'), 'One\n\nTwo');
  assert.equal(htmlToText('<div>A<script>var x = 1 < 2;</script>B</div>'), 'AB');
  assert.equal(htmlToText('<div>A<style>.x{color:red}</style>B</div>'), 'AB');
  // A requirements list has to survive as separate lines, or the gate's
  // line-oriented matching stops working.
  assert.match(
    htmlToText('<p>Must have:</p><ul><li>SQL</li><li>Python</li></ul>'),
    /SQL\n+Python/,
  );
});

test('htmlToText normalizes whitespace without eating paragraphs', () => {
  assert.equal(htmlToText('a&nbsp;&nbsp;b   c\t\td'), 'a b c d');
  assert.equal(htmlToText('<p>A</p><p></p><p></p><p>B</p>'), 'A\n\nB');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
});

test('unescapeHtml handles numeric and hex references', () => {
  assert.equal(unescapeHtml('caf&#233;'), 'café');
  assert.equal(unescapeHtml('caf&#xe9;'), 'café');
  assert.equal(unescapeHtml('&unknownentity;'), '&unknownentity;');
});

// --------------------------------------------------------------------------
// normalize
// --------------------------------------------------------------------------

test('normCompany pops legal suffixes repeatedly', () => {
  const cases = [
    ['Acme, Inc.', 'acme'],
    ['Acme Holdings Inc', 'acme'],
    ['Acme Holdings, LLC', 'acme'],
    ['Johnson & Johnson', 'johnson and johnson'],
    ['ACME CORP', 'acme'],
    ['Société Générale', 'société générale'],
    ['', ''],
    [null, ''],
  ];
  for (const [input, want] of cases) {
    assert.equal(normCompany(input), want, `input: ${input}`);
  }
});

test('normTitle strips req-IDs and location decoration', () => {
  const cases = [
    ['Senior Analyst (Remote) - R12345', 'senior analyst'],
    ['Data Engineer #4471', 'data engineer'],
    ['Analyst [JR0012]', 'analyst'],
    ['Ops Analyst (REQ-1234)', 'ops analyst'],
    ['Program Manager - Job ID: ABC12345', 'program manager'],
    ['Analyst (100% Remote)', 'analyst'],
    ['Analyst (Hybrid)', 'analyst'],
    ['Analyst - Fully Remote US', 'analyst'],
    ['Analyst (US)', 'analyst'],
    ['Research & Development Lead', 'research and development lead'],
    ['', ''],
  ];
  for (const [input, want] of cases) {
    assert.equal(normTitle(input), want, `input: ${input}`);
  }
});

test('normTitle does not eat a legitimate number', () => {
  // "Tier 2" is part of the role. The three-digit threshold in the req-ID
  // patterns is what keeps them off it.
  assert.equal(normTitle('Support Engineer Tier 2'), 'support engineer tier 2');
  assert.equal(normTitle('Level 3 Technician'), 'level 3 technician');
});

test('normLocation collapses every remote spelling to one token', () => {
  for (const input of [
    'Remote',
    'remote',
    'Remote - US',
    'US Remote',
    'Fully Remote',
    'Remote, USA',
    '100% Remote',
    'Remote (Anywhere)',
    'Virtual - Remote',
    'Remote - United States',
    'Remote Nationwide',
  ]) {
    assert.equal(normLocation(input), 'remote', `input: ${input}`);
  }
});

test('normLocation only collapses locations that say the word', () => {
  // Documents a real gap rather than hiding it: a board whose location field
  // reads "Virtual" or "Work from home" and never says "remote" does not fold
  // to the remote token, so the same job posted two ways hashes twice. It
  // affects dedupe only, not the gate, and it is left matching the Python it
  // was ported from until hash-set parity has been verified against it.
  assert.equal(normLocation('Virtual - US'), 'virtual');
  assert.equal(normLocation('Work from home'), 'work from home');
});

test('normLocation matches the longest state name first', () => {
  // Without the 3-2-1 greedy pass, "district of columbia" reads as the word
  // "district", the word "of", and the state "columbia".
  assert.equal(normLocation('District of Columbia'), 'dc');
  assert.equal(normLocation('New York, New York'), 'ny ny');
  assert.equal(normLocation('Boise, Idaho'), 'boise id');
  assert.equal(normLocation('Austin, TX, USA'), 'austin tx');
  assert.equal(normLocation(''), '');
});

test('normLocation state matching is greedy, and known to be blunt', () => {
  // Documents current behavior rather than endorsing it. "Washington" is a
  // state name, so Washington DC folds to "wa dc". Harmless for hashing,
  // which is all this function exists for, and kept identical to the Python
  // it was ported from so hash-set parity can be verified before it changes.
  assert.equal(normLocation('Washington, District of Columbia'), 'wa dc');
});

test('computeHash is stable across boards that spell a job differently', () => {
  const a = computeHash('Acme Inc', 'Senior Analyst (Remote) - R12345', 'Remote - US');
  const b = computeHash('ACME, LLC', 'Senior Analyst', 'US Remote');
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, computeHash('Acme Inc', 'Junior Analyst', 'Remote'));
});

// --------------------------------------------------------------------------
// salary
// --------------------------------------------------------------------------

test('parseSalary reads ranges in every separator boards use', () => {
  const cases = [
    ['$120,000 - $150,000', [120_000, 150_000]],
    ['$120,000 to $150,000', [120_000, 150_000]],
    ['$120,000–$150,000', [120_000, 150_000]],
    ['$120,000—$150,000', [120_000, 150_000]],
    ['120k-150k', [120_000, 150_000]],
    ['$150,000', [150_000, 150_000]],
  ];
  for (const [input, want] of cases) {
    assert.deepEqual(parseSalary(input), want, `input: ${input}`);
  }
});

test('parseSalary folds hourly to annual at 2080 hours', () => {
  assert.deepEqual(parseSalary('$45 per hour'), [93_600, 93_600]);
  assert.deepEqual(parseSalary('$45-$60 hourly'), [93_600, 124_800]);
  assert.deepEqual(parseSalary('45 to 60 an hour'), [93_600, 124_800]);
  assert.deepEqual(parseSalary('$52.50/hr'), [109_200, 109_200]);
});

test('parseSalary guesses the unit from magnitude when none is given', () => {
  // Under 400 with no unit is an hourly rate; 400 to 999 is thousands.
  assert.deepEqual(parseSalary('100 - 150'), [208_000, 312_000]);
  assert.deepEqual(parseSalary('500 - 600'), [500_000, 600_000]);
});

test('parseSalary reverses an inverted range', () => {
  assert.deepEqual(parseSalary('$150,000 - $120,000'), [120_000, 150_000]);
});

test('parseSalary returns nulls rather than a number it cannot defend', () => {
  // The clamp that stops a req number or an equity figure becoming a salary,
  // and a bogus salary becoming a wrong LOW_COMP reject.
  const nothing = [null, null];
  for (const input of [
    '',
    null,
    undefined,
    'Competitive salary and full benefits',
    'Requisition 12345',
    '$8,000', // below the floor: a monthly figure or a bonus
    '$5,000,000', // above the ceiling: an equity pool
    'Founded in 1998', // a year, and no dollar sign
  ]) {
    assert.deepEqual(parseSalary(input), nothing, `input: ${input}`);
  }
});

// --------------------------------------------------------------------------
// remote
// --------------------------------------------------------------------------

test('foldRemote returns null only when the board said nothing', () => {
  assert.equal(foldRemote(), null);
  assert.equal(foldRemote(null, undefined), null);
  assert.equal(foldRemote('', null), null);
  // An explicit answer, even a negative one, is not the same as silence.
  assert.equal(foldRemote(false), false);
  assert.equal(foldRemote('Onsite'), false);
  assert.equal(foldRemote('Hybrid'), false);
});

test('foldRemote takes any positive signal', () => {
  assert.equal(foldRemote(true), true);
  assert.equal(foldRemote('Remote'), true);
  assert.equal(foldRemote('Remote - US'), true);
  assert.equal(foldRemote(null, 'Fully Remote'), true);
  assert.equal(foldRemote('Onsite', 'Remote'), true);
});

test('foldRemote is not fooled by a substring', () => {
  // "non-remote" contains "remote".
  assert.equal(foldRemote('non-remote'), false);
});
