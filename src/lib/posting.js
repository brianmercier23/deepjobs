// The one shape everything downstream agrees on.
//
// Collectors return whatever their board felt like returning. This is where
// six different shapes become one, and where the hash gets computed so that
// nothing further down has to remember to do it.

import { computeHash } from './normalize.js';
import { parseSalary } from './salary.js';

/** ISO 8601 to the second. Milliseconds are noise in a daily crawl. */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Build a posting from a collector's raw fields.
 *
 * Derives the hash and, when a salary was not given as numbers, parses it out
 * of the raw string. Both happen here rather than in six collectors, because
 * six copies of a rule is six chances for one of them to drift.
 */
export function makePosting(fields) {
  const company = collapse(fields.company);
  const title = collapse(fields.title);
  const location = collapse(fields.location);

  let salaryMin = fields.salaryMin ?? null;
  let salaryMax = fields.salaryMax ?? null;
  if (salaryMin === null && salaryMax === null && fields.salaryRaw) {
    [salaryMin, salaryMax] = parseSalary(fields.salaryRaw);
  }

  return {
    hash: fields.hash || computeHash(company, title, location),
    source: fields.source ?? '', // "greenhouse:stripe"
    company,
    title,
    location,
    url: fields.url ?? '',
    description: fields.description ?? '',
    // Tri-state. null means the board did not say.
    remote: fields.remote ?? null,
    salaryMin,
    salaryMax,
    salaryRaw: fields.salaryRaw ?? null,
    employmentType: fields.employmentType ?? null,
    postedAt: fields.postedAt ?? null,
    firstSeen: fields.firstSeen ?? nowIso(),
    tags: fields.tags ?? [],
    aiForward: fields.aiForward ?? null,
  };
}

/** "greenhouse:stripe" -> "greenhouse" */
export function platformOf(posting) {
  return String(posting.source ?? '').split(':', 1)[0];
}

export function salaryDisplay(posting) {
  const fmt = (n) => `$${n.toLocaleString('en-US')}`;
  const { salaryMin: lo, salaryMax: hi } = posting;
  if (lo && hi && lo !== hi) return `${fmt(lo)} - ${fmt(hi)}`;
  if (hi) return fmt(hi);
  return '';
}
