/**
 * Deep link `?q=N` (e.g. `/?q=2`): the page opens and immediately submits
 * `QN`, so one shared link answers a specific FAQ on arrival. The parameter is
 * then removed from the URL (other parameters and the hash are kept).
 */

const Q_PARAM = /^[qQ]?(\d{1,2})$/;

/**
 * Read `q` from the current URL and remove it with history.replaceState.
 * Returns the message to submit (e.g. "Q2"), or null when there is none /
 * it is not a valid FAQ number.
 */
export function takeDeepLinkQuestion(): string | null {
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return null;
  }
  if (!url.searchParams.has('q')) return null;
  const raw = (url.searchParams.get('q') ?? '').trim();
  url.searchParams.delete('q');
  try {
    const qs = url.searchParams.toString();
    window.history.replaceState(window.history.state, '', `${url.pathname}${qs ? `?${qs}` : ''}${url.hash}`);
  } catch {
    /* sandboxed / history unavailable: leave the URL as is */
  }
  const m = Q_PARAM.exec(raw);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return n > 0 ? `Q${n}` : null;
}
