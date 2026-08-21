// HTML to readable plain text.
//
// This is the first thing that touches a description body, and everything
// downstream (gate, tagging, scoring) reads what it returns. If it drops the
// line breaks, a bulleted requirements list becomes one run-on sentence and
// the regex gate stops working.

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'table', 'section', 'article', 'header', 'footer',
]);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
  middot: '·', trade: '™', reg: '®', copy: '©',
  deg: '°', eacute: 'é', egrave: 'è', uuml: 'ü',
  ouml: 'ö', auml: 'ä', ccedil: 'ç', ntilde: 'ñ',
  euro: '€', pound: '£', frac12: '½', times: '×',
  laquo: '«', raquo: '»', shy: '­', ensp: ' ', emsp: ' ',
  thinsp: ' ', zwnj: '', zwj: '',
};

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Decode HTML character references. Named set is partial by design. */
export function unescapeHtml(s) {
  return s.replace(ENTITY_RE, (match, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X'
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[ref];
    return named === undefined ? match : named;
  });
}

// Strips tags while keeping block-level line breaks, and drops the contents of
// script and style entirely rather than pouring minified JS into the body.
function stripTags(html) {
  const parts = [];
  const lower = html.toLowerCase();
  let last = 0;
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|<[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) parts.push(html.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[1] ? m[1].toLowerCase() : null;
    if (!tag) continue;
    const closing = m[0][1] === '/';

    if (!closing && (tag === 'script' || tag === 'style')) {
      // Raw text elements. Their contents are not markup and routinely contain
      // a bare "<" (`var x = 1 < 2`), which a tag matcher happily reads as the
      // start of a tag and then swallows the real closing tag along with the
      // rest of the description. Skip straight to the close instead of
      // tokenizing through it.
      const closeAt = lower.indexOf(`</${tag}`, last);
      if (closeAt === -1) {
        last = html.length;
      } else {
        const gt = html.indexOf('>', closeAt);
        last = gt === -1 ? html.length : gt + 1;
      }
      re.lastIndex = last;
      continue;
    }

    if (BLOCK_TAGS.has(tag)) parts.push('\n');
  }
  if (last < html.length) parts.push(html.slice(last));
  return parts.join('');
}

/**
 * Convert possibly multiply-escaped HTML into readable plain text.
 *
 * The unescape loop is not defensive programming, it is required. Greenhouse
 * returns entity-escaped HTML inside a JSON string, and it is sometimes
 * escaped more than once: `&amp;amp;lt;p&amp;amp;gt;` has to be unescaped
 * three times before it is markup at all. Unescaping once leaves literal
 * `<p>` text in the body; unescaping unconditionally would corrupt a
 * description that legitimately discusses `&lt;` as text.
 */
export function htmlToText(raw) {
  if (!raw) return '';
  let s = String(raw);
  for (let i = 0; i < 3; i += 1) {
    if (!s.includes('&lt;') && !s.includes('&amp;') && !s.includes('&quot;')) break;
    s = unescapeHtml(s);
  }
  s = stripTags(s);
  s = unescapeHtml(s);
  s = s.replaceAll(' ', ' ').replaceAll('​', '');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
