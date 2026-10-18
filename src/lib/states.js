// US states, and reading a list of them out of a posting.
//
// A remote posting that names where it hires is not remote for anyone outside
// that list. Workday boards say so in two places: structured
// `additionalLocations` on the detail call, and a body line such as
// "Remote –Austin, TX, Charlotte, NC, Richmond, VA". Neither is caught by a
// filter on the remote flag, and a model reading the body scored one of them
// 25 of 25 on location.

export const STATE_CODES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca',
  colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga',
  hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia',
  kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md',
  massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms',
  missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok',
  oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc',
  'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt',
  virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi',
  wyoming: 'wy', 'district of columbia': 'dc',
};

const CODES = new Set(Object.values(STATE_CODES));

/**
 * A state name or code from config, to its two-letter code. Lenient on case,
 * because a person typed it.
 */
export function stateCode(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (CODES.has(s)) return s;
  return STATE_CODES[s] ?? null;
}

// Inside posting text a code has to be upper case. Lower case, "in", "or",
// "me" and "ok" are English words, and a list parser that read them as
// Indiana and Oregon would invent restrictions out of prose.
function codeInText(token) {
  if (/^[A-Z]{2}$/.test(token) && CODES.has(token.toLowerCase())) return token.toLowerCase();
  return null;
}

// "Texas - Other" is JLL's Workday spelling of anywhere in Texas.
function nameInText(token) {
  return STATE_CODES[token.toLowerCase().replace(/\s*[-–]\s*other$/, '').replace(/\s+/g, ' ')] ?? null;
}

const US_COUNTRY_RE = /^(?:united states(?: of america)?|usa?|u\.s\.a?\.?)$/i;
// One to four capitalised words: "Austin", "Mountain View", "St. Louis",
// "Winston-Salem". "preference for Austin" is not a city, and refusing it is
// what keeps a sentence from being read as a list.
const CITY_RE = /^[A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,3}$/;
// Lower-case "and"/"or" only. Upper-case OR is Oregon.
const SEPARATOR_RE = /\s*[,;|/&]\s*|\s+(?:and|or)\s+/;

/**
 * Read text that should be nothing but US places into the states it names.
 *
 * Returns null unless every piece is a place: "City, ST", a state name, or a
 * country suffix after one ("Georgia, United States of America"). A leading
 * or lone "United States" means nationwide, which is the opposite of a limit,
 * so it also returns null. Anything else left over means the text was a
 * sentence and not a list, and guessing at a sentence is how a free gate
 * starts quietly throwing away jobs.
 *
 * @returns {string[]|null} lower-case two-letter codes
 */
export function parseStateList(text) {
  const clean = String(text ?? '').trim().replace(/[.\s]+$/, '');
  const tokens = clean.split(SEPARATOR_RE).map((t) => t.trim()).filter(Boolean);
  const states = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (US_COUNTRY_RE.test(token)) {
      if (!states.length) return null;
      continue;
    }
    // "Washington, DC" and "Indiana, PA" are cities, so a following code
    // decides it before the token is read as a state of its own.
    const next = tokens[i + 1] ? codeInText(tokens[i + 1]) : null;
    if (next && CITY_RE.test(token)) {
      states.push(next);
      i += 1;
      continue;
    }
    const own = codeInText(token) ?? nameInText(token);
    if (!own) return null;
    states.push(own);
  }
  return states.length ? [...new Set(states)] : null;
}

// "Remote –Austin, TX, ..." with an en dash, em dash, hyphen or colon, and
// whatever spacing the employer's template produced. Stops at the line end.
const REMOTE_LIST_RE = /\bremote\s*[-–—:]\s*([^\n]+)/gi;

/**
 * The states a body's "Remote – City, ST, ..." lines name, or null when it
 * has no such line. Several lines are unioned, so a second list that adds the
 * reader's state can only ever clear the flag, never cause it.
 */
export function remoteStatesInBody(description) {
  const found = new Set();
  let any = false;
  for (const m of String(description ?? '').matchAll(REMOTE_LIST_RE)) {
    const states = parseStateList(m[1]);
    if (!states) continue;
    any = true;
    for (const s of states) found.add(s);
  }
  return any ? [...found] : null;
}
