import { parse } from 'tldts';

/**
 * Collapse a did:web host to its registrable domain (eTLD+1) via the Public
 * Suffix List. DESIGN.md section 4: `did:web:a.acme.com` and
 * `did:web:b.acme.com` share the registrable unit `acme.com`, but each user on
 * a public-suffix host like `github.io` or a dynamic-DNS provider is its own
 * registrable unit.
 *
 * We enable `allowPrivateDomains` so the PSL's PRIVATE section is honoured -
 * that is what makes `user.github.io` resolve to `user.github.io` (its own
 * unit) rather than collapsing every GitHub Pages site into `github.io`.
 *
 * Returns null when the host has no registrable domain (a bare public suffix
 * like `co.uk` or `github.io`, an IP literal, or `localhost`). Callers treat a
 * null as unadmissible - there is nothing to rate-limit or cap against.
 */
export function registrableDomain(host: string): string | null {
  const normalized = host.trim().toLowerCase();
  if (normalized.length === 0) return null;

  const result = parse(normalized, { allowPrivateDomains: true });

  // IP literals and bare public suffixes have no registrable domain.
  if (result.isIp) return null;
  if (result.domain == null) return null;

  return result.domain;
}
