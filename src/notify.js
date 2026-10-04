// Push new leads to wherever you already look.
//
// A crawl that runs every other morning is only worth its head start if the
// results reach you without a report to remember to read. This sends each new
// posting above a score once, as an HTTP request you shape in YAML: a task in
// your own tracker, a Slack or Discord message, an ntfy push to a phone.
//
// The request body is a YAML object whose string values are templates. The
// whole object is JSON-encoded after substitution, so a quote or a newline in a
// job title can never break the payload.

import { ConfigError } from './config.js';

const FIELD = /\{\{\s*([a-z_]+)(?:\s*\+\s*(\d+))?\s*\}\}/g;
const ENV = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function money(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function salaryText(lead) {
  if (lead.salaryMin && lead.salaryMax && lead.salaryMin !== lead.salaryMax) {
    return `${money(lead.salaryMin)}-${money(lead.salaryMax)}`;
  }
  if (lead.salaryMin || lead.salaryMax) return money(lead.salaryMin || lead.salaryMax);
  return lead.salaryRaw || 'pay not listed';
}

function remoteText(remote) {
  if (remote === true) return 'remote';
  if (remote === false) return 'not remote';
  return 'remote not stated';
}

/** The values a template can use, by name. */
export function leadFields(lead, now = new Date()) {
  return {
    company: lead.company,
    title: lead.title,
    location: lead.location || 'location not stated',
    url: lead.url,
    score: String(lead.overall),
    band: lead.band ?? '',
    rationale: lead.rationale ?? '',
    flags: (lead.scoreFlags ?? []).join(', '),
    salary: salaryText(lead),
    remote: remoteText(lead.remote),
    posted: lead.postedAt ? String(lead.postedAt).slice(0, 10) : 'date not given',
    first_seen: lead.firstSeen ? String(lead.firstSeen).slice(0, 10) : '',
    source: lead.source,
    id: lead.shortHash ?? lead.hash.slice(0, 8),
    today: dateOnly(now),
  };
}

/**
 * Fill one string. `{{name}}` takes a lead field, `{{today+3}}` a date three
 * days out, `${NAME}` an environment variable. An unknown name is an error
 * rather than an empty string: a typo in a template should fail the first
 * dry run, not send forty blank tasks.
 */
export function fillString(text, fields, env = process.env, now = new Date()) {
  // Environment first, fields second, and never the other way round. Field
  // values come from job postings, which anyone can write; expanding ${...}
  // after them would let a posting that contains "${ANTHROPIC_API_KEY}" mail
  // your key to the webhook.
  const withEnv = text.replace(ENV, (_, name) => {
    if (env[name] === undefined || env[name] === '') {
      throw new ConfigError(`notify config needs \${${name}}, and it is not set in the environment or .env`);
    }
    return env[name];
  });
  return withEnv.replace(FIELD, (_, name, days) => {
    if (name === 'today' && days) {
      return dateOnly(new Date(now.getTime() + Number(days) * 86_400_000));
    }
    if (!(name in fields)) throw new ConfigError(`notify template uses {{${name}}}, which is not a field`);
    return fields[name];
  });
}

/** Fill every string inside a YAML value, leaving numbers and booleans alone. */
export function fillTemplate(value, fields, env = process.env, now = new Date()) {
  if (typeof value === 'string') return fillString(value, fields, env, now);
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, fields, env, now));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fillTemplate(v, fields, env, now)]),
    );
  }
  return value;
}

/** Check the notify config's shape once, before anything is sent. */
export function normalizeNotify(raw) {
  const hook = raw?.webhook;
  if (!hook?.url) throw new ConfigError('notify config needs webhook.url');
  const minScore = raw.min_score ?? 60;
  const maxPerRun = raw.max_per_run ?? 25;
  for (const [name, n] of [['min_score', minScore], ['max_per_run', maxPerRun]]) {
    if (!Number.isInteger(n) || n < 0) throw new ConfigError(`notify ${name} must be a whole number, got ${n}`);
  }
  return {
    minScore,
    maxPerRun,
    webhook: {
      url: hook.url,
      method: String(hook.method ?? 'POST').toUpperCase(),
      headers: hook.headers ?? {},
      body: hook.body ?? null,
    },
  };
}

/** Build the request for one lead. Separate from sending so a dry run shows exactly this. */
export function buildRequest(lead, config, env = process.env, now = new Date()) {
  const fields = leadFields(lead, now);
  const { webhook } = config;
  const headers = fillTemplate(webhook.headers, fields, env, now);
  let body;
  if (webhook.body !== null && webhook.body !== undefined) {
    const filled = fillTemplate(webhook.body, fields, env, now);
    body = typeof filled === 'string' ? filled : JSON.stringify(filled);
    if (typeof filled !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }
  return { url: fillString(webhook.url, fields, env, now), method: webhook.method, headers, body };
}

/**
 * Send leads one request each, in order, stopping at the first failure.
 *
 * Stopping matters more than it looks: a sink that rejects one request (an
 * expired token, a renamed field) will reject the rest, and hammering it forty
 * times helps nobody. Only successful sends are passed to `onSent`, so whatever
 * failed is still pending on the next run.
 */
export async function sendLeads(leads, config, { fetchImpl = fetch, env = process.env, now = new Date(), onSent } = {}) {
  let sent = 0;
  for (const lead of leads) {
    const req = buildRequest(lead, config, env, now);
    let res;
    try {
      res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
    } catch (err) {
      return { sent, error: `${lead.company} - ${lead.title}: ${err.message}` };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { sent, error: `${lead.company} - ${lead.title}: HTTP ${res.status} ${detail.slice(0, 200)}`.trim() };
    }
    onSent?.(lead);
    sent += 1;
  }
  return { sent, error: null };
}
