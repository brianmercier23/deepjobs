// Fold assorted remote hints from a board into one tri-state.

/**
 * `null` means the board did not say, which is not the same as "not remote".
 * The gate has to treat those differently: a missing signal is a question for
 * the description body, while an explicit `false` is an answer.
 *
 * @param {...(boolean|string|null|undefined)} signals
 * @returns {boolean|null}
 */
export function foldRemote(...signals) {
  let known = false;
  for (const sig of signals) {
    if (sig === null || sig === undefined) continue;
    if (typeof sig === 'boolean') {
      known = true;
      if (sig) return true;
      continue;
    }
    const s = String(sig).trim().toLowerCase();
    if (!s) continue;
    known = true;
    // "non-remote" contains "remote", which is the kind of thing that makes a
    // substring check quietly wrong.
    if (s.includes('remote') && !s.includes('non-remote')) return true;
    if (['hybrid', 'onsite', 'on-site', 'in office', 'in-office'].includes(s)) continue;
  }
  return known ? false : null;
}
