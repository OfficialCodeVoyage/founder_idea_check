const LEADING_WWW = /^www\./;
const FIRST_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function getDomainFromUrl(url: string) {
  return new URL(url).hostname.replace("www.", "");
}

/**
 * The first letter or digit of a site's domain, for the local site badge
 * (components/favicon.tsx), or null when the address has no usable domain.
 *
 * Takes a full URL or a bare hostname and never throws: a source's URL comes
 * from a search result, and an unparseable one must not take the whole sources
 * list down with it.
 */
export function getSiteInitial(urlOrHostname: string): string | null {
  const trimmed = urlOrHostname.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const { hostname } = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`
    );
    return (
      hostname.replace(LEADING_WWW, "").match(FIRST_LETTER_OR_DIGIT)?.[0] ??
      null
    );
  } catch {
    return null;
  }
}
