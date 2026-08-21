// Normalization is load-bearing.
//
// Its only job is to make `computeHash` stable across boards that spell the
// same job differently. If it is sloppy the same posting reappears every
// morning under a slightly different string, and a list you cannot trust is
// worse than no list.

import { createHash } from 'node:crypto';

const COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'corp', 'corporation', 'ltd', 'limited',
  'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'nv', 'bv', 'pbc', 'lp',
  'llp', 'pllc', 'holdings', 'holding',
]);

// Req-ID debris an ATS bolts onto a title: (REQ-1234)  - R12345  #4471  [JR0012]
const REQ_ID_PATTERNS = [
  /[([{]\s*(?:job\s*)?(?:req(?:uisition)?|jr|r)?[\s#-]*\d{3,}[a-z]?\s*[)\]}]/gi,
  /[([{]\s*(?:req|jr|r)[-_ ]?\d+\s*[)\]}]/gi,
  /[-–—,]\s*(?:req(?:uisition)?\s*(?:id|#)?|job\s*id|id)\s*[:#-]?\s*[a-z]{0,3}\d{3,}\s*$/gi,
  /\s+#\s?\d{3,}\s*$/g,
  /[-–—]\s*[a-z]{1,3}\d{4,}\s*$/gi,
];

// Remote and location decoration inside a title, not part of the role itself.
const TITLE_LOCATION_NOISE = [
  /[([]\s*(?:100%\s*)?(?:fully\s*)?remote[^)\]]*[)\]]/gi,
  /[([]\s*hybrid[^)\]]*[)\]]/gi,
  /[([]\s*(?:us|usa|united states|nationwide|anywhere)\s*[)\]]/gi,
  /[-–—,]\s*(?:100%\s*)?(?:fully\s*)?remote(?:\s*(?:us|usa|united states))?\s*$/gi,
  /[-–—,]\s*hybrid\s*$/gi,
];

const US_STATES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar',
  california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de',
  florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
  illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks',
  kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md',
  massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne',
  nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj',
  'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc',
  'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc',
  'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut',
  vermont: 'vt', virginia: 'va', washington: 'wa',
  'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy',
  'district of columbia': 'dc',
};

// Unicode-aware on purpose: a plain [^\w\s] would strip the accents out of a
// company name and hash "Société" and "Societe" differently.
const PUNCT = /[^\p{L}\p{N}_\s]/gu;
const EDGE_JUNK = /^[\s\-–—,|/]+|[\s\-–—,|/]+$/g;

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/** Lowercase, drop legal suffixes and punctuation. */
export function normCompany(raw) {
  if (!raw) return '';
  let s = String(raw).toLowerCase().replaceAll('&', ' and ');
  s = s.replace(PUNCT, ' ');
  const words = collapse(s).split(' ').filter(Boolean);
  // Repeatedly, because "Acme Holdings Inc" has two of them.
  while (words.length && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Lowercase, strip req-IDs and remote/location decoration. */
export function normTitle(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Up to three passes: removing one piece of debris can expose the next,
  // as in "Analyst (Remote) - R12345".
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    for (const pat of REQ_ID_PATTERNS) s = s.replace(pat, ' ');
    for (const pat of TITLE_LOCATION_NOISE) s = s.replace(pat, ' ');
    s = s.replace(EDGE_JUNK, '');
    if (s === before) break;
  }
  s = s.toLowerCase().replaceAll('&', ' and ');
  s = s.replace(PUNCT, ' ');
  return collapse(s);
}

// "Remote - US", "US Remote" and "Fully Remote" have to hash identically, or
// the same remote job arrives daily from three different boards.
const REMOTE_ONLY = new RegExp(
  '^(?:100 )?(?:fully |work from home |wfh |virtual |anywhere in )?'
  + '(?:us |usa |united states |north america |nationwide |anywhere )?'
  + 'remote'
  + '(?: us| usa| united states| north america| nationwide| anywhere| based)?$',
);

/** Lowercase, expand state names to postal codes, collapse remote variants. */
export function normLocation(raw) {
  if (!raw) return '';
  let s = String(raw).toLowerCase().replaceAll('&', ' and ');
  s = collapse(s.replace(PUNCT, ' '));
  if (!s) return '';
  if (REMOTE_ONLY.test(s)) return 'remote';

  const words = s.split(' ');
  const out = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    // Longest first, so "district of columbia" wins over "columbia" and
    // "new york" is not read as the word "new" plus the word "york".
    for (const span of [3, 2, 1]) {
      const phrase = words.slice(i, i + span).join(' ');
      if (Object.hasOwn(US_STATES, phrase)) {
        out.push(US_STATES[phrase]);
        i += span;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(words[i]);
      i += 1;
    }
  }
  s = out.join(' ');
  s = s.replace(/\b(?:united states of america|united states|usa|us)\b/g, ' ');
  return collapse(s);
}

/** The dedupe key. Stable across boards, by construction. */
export function computeHash(company, title, location) {
  const key = `${normCompany(company)}|${normTitle(title)}|${normLocation(location)}`;
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
