// Best-effort annualized compensation from free text.
//
// Deliberately conservative. A wrong number here is worse than no number,
// because it drives a wrong LOW_COMP reject and the posting is gone before a
// human ever sees it. Every ambiguous case returns nulls.

const HOURS_PER_YEAR = 2080;

const MONEY = String.raw`\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?`;
const SEPARATOR = String.raw`\s*(?:-|–|—|to)\s*`;
const RANGE_RE = new RegExp(MONEY + SEPARATOR + MONEY);
const SINGLE_RE = /\$\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?/;
const HOURLY_HINT = /(?:per\s*hour|hourly|\/\s*hr\b|\/\s*hour|an\s*hour)/i;

function toAmount(num, suffix) {
  let val = Number.parseFloat(num.replaceAll(',', ''));
  const s = suffix ? suffix.toLowerCase() : '';
  if (s === 'k') val *= 1_000;
  else if (s === 'm') val *= 1_000_000;
  return val;
}

/**
 * Returns [min, max] annualized, or [null, null] when the text cannot be
 * trusted.
 *
 * @returns {[number|null, number|null]}
 */
export function parseSalary(text) {
  if (!text) return [null, null];
  const s = String(text);
  const hourly = HOURLY_HINT.test(s);

  let lo;
  let hi;
  const range = RANGE_RE.exec(s);
  if (range) {
    lo = toAmount(range[1], range[2]);
    hi = toAmount(range[3], range[4]);
  } else {
    // A bare number with no dollar sign and no range is not a salary. It is a
    // year, a headcount, or a street address.
    const single = SINGLE_RE.exec(s);
    if (!single) return [null, null];
    lo = toAmount(single[1], single[2]);
    hi = lo;
  }

  if (lo > hi) [lo, hi] = [hi, lo];

  if (hourly) {
    lo *= HOURS_PER_YEAR;
    hi *= HOURS_PER_YEAR;
  } else if (hi < 1000) {
    // No unit given. "45" is an hourly rate; "150" is thousands. The line
    // between them is 400, which no hourly rate reaches and no salary in
    // thousands falls below.
    if (hi < 400) {
      lo *= HOURS_PER_YEAR;
      hi *= HOURS_PER_YEAR;
    } else {
      lo *= 1_000;
      hi *= 1_000;
    }
  }

  // The sanity clamp. Anything outside this is a parse that went wrong on a
  // req number or a stock figure, so it reports nothing rather than a lie.
  if (hi < 10_000 || hi > 2_000_000) return [null, null];
  return [Math.trunc(lo), Math.trunc(hi)];
}
