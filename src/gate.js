// The free stage. Cost control, not judgment.
//
// Scoring 40 postings through an LLM costs fractions of a cent. Scoring 4,000
// does not. Everything here runs on regex over text already in hand, and the
// only job is to kill cheaply what would otherwise die expensively.
//
// The bias is deliberately toward letting things through. A gate that silently
// rejects a good role costs more than one that passes a bad role: the bad one
// dies for a fraction of a cent at the next stage, while the good one is never
// seen again.

import { parseSalary } from './lib/salary.js';

// Flags are emitted, never rejections. They are notes for a human.
export const FLAGS = {
  REMOTE: 'REMOTE',
  HYBRID: 'HYBRID',
  ONSITE_LOCAL: 'ONSITE_LOCAL',
  LOCATION_UNKNOWN: 'LOCATION_UNKNOWN',
  CONTRACT: 'CONTRACT',
  PART_TIME: 'PART_TIME',
  LOW_COMP: 'LOW_COMP',
  NO_COMP: 'NO_COMP_DISCLOSED',
  STAFFING: 'STAFFING_AGENCY',
  THIN: 'THIN_DESCRIPTION',
  // The posting says remote and then the body asks for days in an office.
  REMOTE_CONTRADICTED: 'REMOTE_CONTRADICTED',
  // The posting says remote and then the body restricts where you may live.
  REMOTE_GEO_LIMITED: 'REMOTE_GEO_LIMITED',
};

/**
 * A structured remote flag is a claim, not a fact.
 *
 * Boards let an employer tick "remote" and then write a body that requires
 * three days a week in San Francisco. Structured metadata is what every job
 * tool filters on, so those postings pass every filter and are only caught by
 * someone reading the description, which is the expensive part.
 *
 * These patterns are deliberately about *requirements* rather than any mention
 * of an office. "We have offices in Austin" is not an anchor-day requirement,
 * and matching it would reject genuinely remote roles at the free stage, which
 * is the one thing this gate must not do.
 */
const ONSITE_REQUIREMENT_RE = new RegExp([
  String.raw`\b\d+\s*(?:\+\s*)?days?\s*(?:per|a|each)\s*week\s*(?:in|on|at|from)\b`,
  String.raw`\bin[- ]office\s+\d+\s*(?:\+\s*)?days?\b`,
  String.raw`\b(?:required|expected|need)\w*\s+to\s+(?:be|work)\s+(?:on[- ]?site|in[- ]?office|in the office)\b`,
  String.raw`\bmust\s+(?:be able to\s+)?(?:work|be)\s+(?:on[- ]?site|in[- ]?office|in the office)\b`,
  String.raw`\bwithin\s+\d+\s*miles\s+of\b`,
  String.raw`\bcommut(?:e|ing)\s+(?:distance|to)\b`,
  String.raw`\b(?:onsite|on-site|in-office)\s+(?:requirement|expectation)\b`,
  // No bare "hybrid" pattern here, deliberately. It was tried and removed: it
  // matched "a flexible hybrid work model that balances remote focus with
  // vibrant office collaboration", which is a benefits blurb and not a
  // requirement, and it mislabelled genuinely remote roles at three companies.
  // Hybrid in the *location* field is a different signal and still flagged.
].join('|'), 'i');

/**
 * A different restriction, and worth telling apart from the one above.
 *
 * "Remote, United States" whose body says "must be located in Eastern or
 * Central Timezones" asks for no office time at all. It is still a real limit
 * on who can take the job, so it earns its own flag rather than being filed
 * under a name that says the body wants you on site.
 */
const GEO_LIMIT_RE = /\bmust\s+(?:live|reside|be located|be based)\s+(?:in|near|within)\b/i;

const REMOTE_RE = /\b(?:100%\s*)?(?:fully\s+)?remote\b|\bwork from home\b|\bwfh\b|\btelecommut/i;
const HYBRID_RE = /\bhybrid\b|\b\d\s*days?\s*(?:per|a)\s*week\s*(?:in|on|at)\b|\bin[- ]office\s+\d\s*days?\b/i;
const CONTRACT_RE = /\b(?:contract|contractor|1099|c2c|corp[- ]to[- ]corp|contract[- ]to[- ]hire|temp[- ]to[- ]perm|fixed[- ]term|freelance|consultancy engagement)\b/i;
const PART_TIME_RE = /\bpart[- ]time\b/i;
const RELOCATION_RE = /\bmust relocate\b|\brelocation (?:is )?required\b|\brequired to relocate\b|\bwilling(?:ness)? to relocate is (?:a )?requirement\b/i;
const COMMISSION_ONLY_RE = /\bcommission[- ]only\b|\b100%\s*commission\b|\buncapped commission[- ]only\b/i;
// The lookahead is load-bearing: "unpaid time off" is a benefit, not a warning.
// "time away" is Cushman & Wakefield's boilerplate ("paid and unpaid time away
// from work"); without it every one of their postings was rejected as unpaid.
const UNPAID_RE = /\bunpaid\b(?!\s*(?:time off|time away|leave))/i;
const SALARY_CTX_RE = /(?:salary|compensation|pay|base|range|rate|hiring range|pay range)[^.\n]{0,80}?\$\s?\d[\d,.]*\s*(?:k\b)?[^.\n]{0,60}/i;

const US_STATE_CODES = ['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il',
  'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt',
  'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri',
  'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc'];

const US_STATE_NAMES = 'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|'
  + 'florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|'
  + 'louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|'
  + 'missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|'
  + 'new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|'
  + 'rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|'
  + 'virginia|washington|west virginia|wisconsin|wyoming';

// Metros that job ads name without a state, so "New York City Office" and
// "San Francisco HQ" still read as US-eligible.
const US_CITIES = 'new york|nyc|san francisco|los angeles|chicago|boston|seattle|austin|'
  + 'denver|atlanta|dallas|houston|miami|philadelphia|phoenix|portland|'
  + 'san diego|washington dc|minneapolis|detroit|nashville|charlotte|'
  + 'columbus|cleveland|cincinnati|pittsburgh|st louis|kansas city|'
  + 'salt lake city|las vegas|orlando|tampa|raleigh|durham|boulder|'
  + 'san jose|palo alto|mountain view|santa monica|brooklyn|manhattan';

const US_HINT_RE = new RegExp(
  '\\b(?:usa?|u\\.s\\.a?\\.?|united states|america|americas|north america)\\b|'
  + `\\b(?:${US_STATE_NAMES})\\b|`
  + `\\b(?:${US_CITIES})\\b|`
  + `,\\s*(?:${US_STATE_CODES.join('|')})\\b`,
  'i',
);

// Explicitly non-US. Only consulted when there is no US signal at all, so this
// list being incomplete degrades to "pass with a flag" and never to a wrong
// reject. "georgia" is deliberately absent: it is a US state.
const FOREIGN_RE = new RegExp('\\b(?:'
  + 'canada|canadian|ontario|quebec|british columbia|alberta|toronto|'
  + 'vancouver|montreal|ottawa|edmonton|calgary|waterloo|'
  + 'uk|united kingdom|england|scotland|wales|ireland|london|dublin|'
  + 'manchester|edinburgh|belfast|'
  + 'germany|berlin|munich|hamburg|france|paris|spain|madrid|barcelona|'
  + 'portugal|lisbon|porto|netherlands|amsterdam|belgium|brussels|'
  + 'italy|rome|milan|switzerland|zurich|geneva|austria|vienna|'
  + 'sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|'
  + 'poland|warsaw|krakow|czech|prague|romania|bucharest|hungary|budapest|'
  + 'ukraine|kyiv|greece|athens|turkey|istanbul|'
  + 'india|bangalore|bengaluru|hyderabad|mumbai|delhi|pune|chennai|'
  + 'china|beijing|shanghai|shenzhen|hong kong|taiwan|taipei|'
  + 'japan|tokyo|osaka|korea|seoul|singapore|malaysia|kuala lumpur|'
  + 'indonesia|jakarta|philippines|manila|vietnam|hanoi|thailand|bangkok|'
  + 'australia|sydney|melbourne|brisbane|new zealand|auckland|'
  + 'brazil|sao paulo|argentina|buenos aires|chile|santiago|'
  + 'colombia|bogota|medellin|mexico|mexico city|guadalajara|peru|lima|'
  + 'costa rica|uruguay|montevideo|'
  + 'israel|tel aviv|uae|dubai|abu dhabi|saudi|egypt|cairo|'
  + 'south africa|cape town|johannesburg|nigeria|lagos|kenya|nairobi|'
  + 'bulgaria|sofia|serbia|belgrade|croatia|zagreb|slovenia|slovakia|'
  + 'lithuania|vilnius|latvia|riga|estonia|tallinn|belarus|moldova|'
  + 'cyprus|malta|iceland|luxembourg|albania|bosnia|macedonia|'
  + 'uzbekistan|kazakhstan|armenia|azerbaijan|'
  + 'pakistan|karachi|lahore|bangladesh|dhaka|sri lanka|colombo|nepal|'
  + 'morocco|casablanca|tunisia|algeria|ghana|accra|ethiopia|tanzania|'
  + 'uganda|zimbabwe|rwanda|senegal|'
  + 'ecuador|quito|bolivia|paraguay|venezuela|caracas|panama|'
  + 'guatemala|honduras|el salvador|nicaragua|dominican republic|'
  + 'jamaica|trinidad|'
  + 'iraq|iran|jordan|amman|lebanon|beirut|qatar|doha|kuwait|bahrain|oman|'
  + 'emea|apac|latam|anz|europe|asia)\\b', 'i');

// Location strings that say nothing useful either way.
const AMBIGUOUS_LOCATION_RE = /^\s*(?:united states|usa?|north america|multiple locations|various|nationwide|anywhere|flexible|tbd|n\/?a|global|worldwide|americas|multiple|other)\s*$/i;

// Words that describe a region and never a workplace. A location built only
// from these ("Americas (USA or Canada)") names no city, so it cannot be
// rejected as too far away; it has to go to the rubric to be read.
const BROAD_GEO_WORDS = new Set([
  'united', 'states', 'usa', 'us', 'u.s.', 'u.s.a.', 'america', 'americas',
  'north', 'canada', 'remote', 'anywhere', 'nationwide', 'global',
  'worldwide', 'multiple', 'locations', 'various', 'flexible', 'hybrid',
  'onsite', 'office', 'or', 'and', 'any', 'all', 'other', 'tbd', 'na',
]);

function looksUS(location) {
  return Boolean(location) && US_HINT_RE.test(location);
}

function isBroadGeography(location) {
  const words = String(location).toLowerCase().match(/[a-z.]+/g) ?? [];
  if (!words.length || !words.every((w) => BROAD_GEO_WORDS.has(w))) return false;
  // The US signal is required: "Americas (USA or Canada)" is broad and
  // workable, while "Canada" on its own is neither.
  return looksUS(location);
}

/** Word-boundary matcher, so "intern" cannot kill "Internal Audit Manager". */
export function wordRe(term) {
  const escaped = String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

function normalizeMetro(metro) {
  const parts = String(metro).split(',').map((s) => s.trim().toLowerCase());
  return { city: parts[0] ?? String(metro).trim().toLowerCase(), state: parts[1] ?? null };
}

export class Gate {
  constructor(cfg = {}) {
    const loc = cfg.location ?? {};
    const comp = cfg.compensation ?? {};
    const emp = cfg.employment_type ?? {};
    const hard = cfg.hard_rejects ?? {};
    const staff = cfg.staffing_agencies ?? {};

    // Everything about where home is comes from config. A reject reason that
    // names a city has to name the reader's city, not the author's.
    this.homeMetroLabel = loc.home_metro_label ?? 'your home metro';
    this.homeStateRe = loc.home_state
      ? new RegExp(`\\b${String(loc.home_state).toLowerCase()}\\b${loc.home_state_code ? `|,\\s*${loc.home_state_code}\\b` : ''}`, 'i')
      : null;
    this.metros = (loc.onsite_metros_allowed ?? []).map(normalizeMetro);
    this.passAmbiguous = loc.pass_ambiguous_locations ?? true;
    this.rejectRelocation = loc.reject_if_relocation_required ?? true;
    this.rejectNonUS = loc.reject_non_us ?? true;
    // On by default: it costs nothing and it is the whole point of reading
    // the body. Rejecting on it is opt-in, because a hybrid role in your own
    // metro is still a job you might want.
    this.checkRemoteClaim = loc.check_remote_claim_against_body ?? true;
    this.rejectContradictedRemote = loc.reject_contradicted_remote ?? false;

    this.minAnnual = comp.min_annual ?? null;
    this.softFloor = comp.soft_floor ?? 0;
    this.rejectCommissionOnly = comp.reject_commission_only ?? true;
    this.rejectUnpaid = comp.reject_unpaid ?? true;

    this.contractMode = String(emp.contract_mode ?? 'flag').toLowerCase();

    this.titleRejects = (hard.titles_containing ?? []).map((t) => ({ term: t, re: wordRe(t) }));
    this.descRejects = (hard.description_containing ?? []).map((t) => ({ term: t, re: wordRe(t) }));

    this.staffingMode = String(staff.mode ?? 'flag').toLowerCase();
    this.staffing = (staff.names ?? []).map((n) => ({ term: n, re: wordRe(n) }));
  }

  checkLocation(posting, blob) {
    const flags = [];
    const location = posting.location || '';

    let isRemote = posting.remote === true || REMOTE_RE.test(location);
    // A description-level remote claim is trusted only when the location field
    // is empty. Ads say "remote" about all sorts of things that are not the
    // job: remote monitoring, remote sites, remote offices.
    if (!isRemote && !location && REMOTE_RE.test(blob)) isRemote = true;

    if (isRemote) {
      // Decide on positive US signal first. The foreign list is the fallback,
      // so a country missing from it degrades to a flag, not a rejection.
      if (this.rejectNonUS && location && !looksUS(location)) {
        if (FOREIGN_RE.test(location)) {
          return { ok: false, reason: `remote but non-US: ${location}`, flags };
        }
        flags.push(FLAGS.LOCATION_UNKNOWN);
      }
      flags.push(FLAGS.REMOTE);
      if (HYBRID_RE.test(location)) flags.push(FLAGS.HYBRID);

      // The improvement over filtering on structured metadata alone: read the
      // body and see whether the remote claim survives it. Caught here it is
      // free; caught at the scoring stage it has already been paid for.
      if (this.checkRemoteClaim) {
        const body = posting.description || '';
        if (GEO_LIMIT_RE.test(body)) flags.push(FLAGS.REMOTE_GEO_LIMITED);
        if (ONSITE_REQUIREMENT_RE.test(body)) {
          flags.push(FLAGS.REMOTE_CONTRADICTED);
          if (this.rejectContradictedRemote) {
            return { ok: false, reason: 'declared remote, body requires time on site', flags };
          }
        }
      }
      return { ok: true, reason: null, flags };
    }

    if (!location || AMBIGUOUS_LOCATION_RE.test(location) || isBroadGeography(location)) {
      flags.push(FLAGS.LOCATION_UNKNOWN);
      return this.passAmbiguous
        ? { ok: true, reason: null, flags }
        : { ok: false, reason: 'no usable location', flags };
    }

    const low = location.toLowerCase();
    for (const { city, state } of this.metros) {
      const stateOk = state === null || low.includes(state) || this.homeStateRe?.test(low);
      if (low.includes(city) && stateOk) {
        flags.push(HYBRID_RE.test(blob) ? FLAGS.HYBRID : FLAGS.ONSITE_LOCAL);
        return { ok: true, reason: null, flags };
      }
    }

    if (this.rejectNonUS && !looksUS(location) && FOREIGN_RE.test(location)) {
      return { ok: false, reason: `onsite outside the US: ${location}`, flags };
    }
    return { ok: false, reason: `onsite outside ${this.homeMetroLabel}: ${location}`, flags };
  }

  check(posting) {
    const blob = `${posting.title}\n${posting.description}`;
    const flags = [];

    for (const { term, re } of this.titleRejects) {
      if (re.test(posting.title)) return { passed: false, reason: `title contains '${term}'`, flags };
    }
    for (const { term, re } of this.descRejects) {
      if (re.test(blob)) return { passed: false, reason: `description contains '${term}'`, flags };
    }

    if (this.rejectRelocation && RELOCATION_RE.test(blob)) {
      return { passed: false, reason: 'relocation required', flags };
    }
    if (this.rejectCommissionOnly && COMMISSION_ONLY_RE.test(blob)) {
      return { passed: false, reason: 'commission-only compensation', flags };
    }
    if (this.rejectUnpaid && UNPAID_RE.test(blob)) {
      return { passed: false, reason: 'unpaid role', flags };
    }

    const loc = this.checkLocation(posting, blob);
    flags.push(...loc.flags);
    if (!loc.ok) return { passed: false, reason: loc.reason, flags };

    const et = posting.employmentType || '';
    if (CONTRACT_RE.test(et) || CONTRACT_RE.test(posting.title)) {
      if (this.contractMode === 'reject') {
        return { passed: false, reason: 'contract role (contract_mode: reject)', flags };
      }
      flags.push(FLAGS.CONTRACT);
    }
    if (PART_TIME_RE.test(et) || PART_TIME_RE.test(posting.title)) flags.push(FLAGS.PART_TIME);

    // Compensation produces flags, never rejections, unless a hard floor is
    // configured. Most postings state no salary at all, and rejecting on
    // silence would throw away most of the market.
    let salaryMax = posting.salaryMax ?? null;
    let salaryMin = posting.salaryMin ?? null;
    if (salaryMax === null) {
      const match = SALARY_CTX_RE.exec(posting.description || '');
      if (match) {
        const [lo, hi] = parseSalary(match[0]);
        if (hi) {
          salaryMin = salaryMin ?? lo;
          salaryMax = hi;
        }
      }
    }

    if (salaryMax === null) flags.push(FLAGS.NO_COMP);
    else if (this.softFloor && salaryMax < this.softFloor) flags.push(FLAGS.LOW_COMP);

    if (this.minAnnual && salaryMax && salaryMax < this.minAnnual) {
      return { passed: false, reason: `salary max ${salaryMax} below floor ${this.minAnnual}`, flags };
    }

    for (const { term, re } of this.staffing) {
      if (re.test(posting.company)) {
        if (this.staffingMode === 'reject') {
          return { passed: false, reason: `staffing agency: ${term}`, flags };
        }
        flags.push(FLAGS.STAFFING);
        break;
      }
    }

    if ((posting.description || '').length < 300) flags.push(FLAGS.THIN);

    return { passed: true, reason: null, flags, salaryMin, salaryMax };
  }
}

/** Collapse per-posting reasons into a countable category. */
export function reasonBucket(reason) {
  if (!reason) return 'unknown';
  for (const prefix of ['onsite outside', 'remote but non-US', 'title contains', 'description contains']) {
    if (reason.startsWith(prefix)) return prefix;
  }
  return reason;
}

/**
 * Run the gate over a batch.
 *
 * The reason histogram is the point of recording rejections at all: it is how
 * anyone notices that the gate has quietly become too tight.
 */
export function applyGate(postings, cfg) {
  const gate = new Gate(cfg);
  const passed = [];
  const rejected = [];
  const reasons = new Map();
  for (const posting of postings) {
    const result = gate.check(posting);
    if (result.passed) {
      passed.push({ ...posting, flags: result.flags, salaryMin: result.salaryMin, salaryMax: result.salaryMax });
    } else {
      rejected.push({ posting, reason: result.reason, flags: result.flags });
      const bucket = reasonBucket(result.reason);
      reasons.set(bucket, (reasons.get(bucket) ?? 0) + 1);
    }
  }
  return { passed, rejected, reasons };
}
