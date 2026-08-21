import { fetchJson } from './http.js';
import { makePosting } from '../lib/posting.js';
import { htmlToText } from '../lib/text.js';
import { foldRemote } from '../lib/remote.js';
import { isoDate } from '../lib/dates.js';

/**
 * Recruitee's careers-site API, which is unauthenticated by design: the docs
 * say so outright, because it is the same endpoint a company's own careers
 * page calls to render itself.
 *
 * It is the richest list response of any platform here. One request returns
 * the description *and* the requirements as full HTML, a three-way
 * remote/hybrid/on-site split, and a structured salary with currency and
 * period - no detail call per posting, unlike SmartRecruiters, Workday and
 * every other platform that treats a body as a second page.
 */
export const HOST = 'recruitee.com';

export const apiBase = (slug) => `https://${slug}.${HOST}/api/offers/`;

/**
 * Recruitee quotes salaries per month as often as per year, and mostly in
 * euros, because its customers are largely European mid-market.
 *
 * Converting a currency would mean carrying an exchange rate that is wrong the
 * day after it is written, so nothing is converted: a non-annual figure is
 * annualised, a non-USD figure is passed through as text for the model to read
 * in the posting, and the numeric fields the gate compares against a dollar
 * floor are left null rather than filled with a number in the wrong unit.
 */
const PERIODS = { hour: 2080, day: 260, week: 52, month: 12, year: 1 };

export function mapSalary(salary) {
  const min = Number(salary?.min) || null;
  const max = Number(salary?.max) || null;
  if (!min && !max) return { salaryMin: null, salaryMax: null, salaryRaw: null };

  const currency = String(salary.currency ?? '').toUpperCase();
  const period = String(salary.period ?? 'year').toLowerCase();
  const multiplier = PERIODS[period] ?? null;

  const parts = [min, max].filter(Boolean).map((n) => n.toLocaleString('en-US'));
  const raw = `${currency} ${parts.join(' - ')} per ${period}`.trim();

  // A euro is not a dollar and a month is not a year. Either mismatch makes the
  // number unsafe to compare against a floor, so it stays out of the numeric
  // columns and survives only as text the scorer can read.
  if (currency !== 'USD' || !multiplier) return { salaryMin: null, salaryMax: null, salaryRaw: raw };
  return {
    salaryMin: min ? Math.round(min * multiplier) : null,
    salaryMax: max ? Math.round(max * multiplier) : null,
    salaryRaw: raw,
  };
}

/** Pure: raw board response to postings. Tested against a recorded fixture. */
export function mapRecruitee(data, slug, name = null) {
  const out = [];
  for (const o of data?.offers ?? []) {
    const company = name || o.company_name || slug;
    const location = o.location
      || [o.city, o.state_name, o.country].filter(Boolean).join(', ');

    // Two fields, and the requirements half is usually the one that decides
    // whether a role is viable at all. Same shape as Workable.
    const description = [htmlToText(o.description), htmlToText(o.requirements)]
      .filter(Boolean).join('\n\n').trim();

    // The only platform here that answers the remote question in three parts
    // rather than one boolean. `remote` alone would read a hybrid role as
    // fully onsite, which is the opposite of the mistake everything else makes.
    const remote = o.remote === true
      ? true
      : (o.hybrid === true || o.on_site === true ? false : foldRemote(o.remote, location));

    out.push(makePosting({
      source: `recruitee:${slug}`,
      company,
      title: o.title ?? '',
      location,
      // careers_url is the page a human reads; careers_apply_url skips to the
      // form. A report is for deciding, not applying.
      url: o.careers_url || o.careers_apply_url || '',
      description,
      remote,
      employmentType: o.employment_type_code ?? null,
      postedAt: isoDate(o.published_at ?? o.created_at),
      ...mapSalary(o.salary),
    }));
  }
  return out;
}

/**
 * Like Workable and unlike SmartRecruiters, an unknown slug 404s here, so an
 * empty list is a real answer: the board exists and nobody is hiring today.
 */
export async function fetchRecruitee(slug, name = null, opts = {}) {
  const data = await fetchJson(apiBase(slug), opts);
  return mapRecruitee(data, slug, name);
}
