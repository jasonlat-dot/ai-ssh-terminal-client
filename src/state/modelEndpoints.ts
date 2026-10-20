export type ModelEndpointOption = { url: string; source: 'default' | 'saved'; key: string };
function endpointKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}
/** Suggestions come from existing configurations, never from browser autofill or unsaved input. */
export function modelEndpointOptions(defaultUrl: string, saved: readonly string[], search = ''): ModelEndpointOption[] {
  const first = {url: defaultUrl, source: 'default' as const, key: endpointKey(defaultUrl) ?? defaultUrl};
  const seen = new Set([first.key]), result: ModelEndpointOption[] = [first];
  for (const value of saved) {
    const url = value.trim(), key = endpointKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!url.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) continue;
    result.push({url, key, source: 'saved'});
    if (result.length >= 9) break;
  }
  return result;
}
export function sameModelEndpoint(left: string, right: string): boolean {
  const key = endpointKey(left);
  return key !== null && key === endpointKey(right);
}
