const ALLOWED_HOSTS = new Set(['cdn.dexscreener.com', 'www.iconaves.com']);

/** Share the same URL policy between metadata storage and the image proxy. */
export function usableAvatarUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname) &&
      !url.port && !url.username && !url.password;
  } catch { return false; }
}
