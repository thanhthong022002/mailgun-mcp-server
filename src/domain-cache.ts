// Domain listings back the domain-to-account lookup that agents rely on before
// every other call. They are stable — a domain belongs to exactly one Mailgun
// account and does not migrate — so a long TTL is safe: a cached entry does not
// go wrong, it only goes incomplete when a domain is added elsewhere. `refresh`
// on the listing tool covers that case.
export const DEFAULT_DOMAIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const TTL_ENV_VAR = "MAILGUN_DOMAIN_CACHE_TTL";

export interface DomainSummary {
  name: string;
  state?: string;
  type?: string;
  disabled?: boolean;
}

export interface DomainListing {
  domains: DomainSummary[];
  domain_count: number;
  truncated: boolean;
}

interface CacheEntry {
  listing: DomainListing;
  fetchedAt: number;
  expiresAt: number;
}

// Process-wide, so HTTP-transport sessions share it. They already share the same
// API keys, so there is nothing to isolate between them.
const entries = new Map<string, CacheEntry>();

// Read per call rather than at import so a client can change it without a
// rebuild, and so tests can drive it directly. Seconds; 0 disables caching.
export function domainCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TTL_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_DOMAIN_CACHE_TTL_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_DOMAIN_CACHE_TTL_MS;
  return Math.floor(seconds * 1000);
}

export interface CachedDomainListing extends DomainListing {
  fetchedAt: number;
}

export function getCachedDomains(
  account: string,
  now: number = Date.now(),
): CachedDomainListing | undefined {
  const entry = entries.get(account);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= now) {
    entries.delete(account);
    return undefined;
  }
  return { ...entry.listing, fetchedAt: entry.fetchedAt };
}

export function setCachedDomains(
  account: string,
  listing: DomainListing,
  now: number = Date.now(),
  ttlMs: number = domainCacheTtlMs(),
): void {
  if (ttlMs <= 0) return;
  entries.set(account, { listing, fetchedAt: now, expiresAt: now + ttlMs });
}

// Omit `account` to clear every entry.
export function invalidateDomains(account?: string): void {
  if (account === undefined) {
    entries.clear();
    return;
  }
  entries.delete(account);
}

// DNS verification is the only registered operation that changes what a domain
// listing reports: it flips a domain's state. Creating and deleting domains are
// not exposed, so the domain *set* only ever changes outside this server, which
// is what the TTL and `refresh` are for. Revisit this list if that changes.
const DOMAIN_MUTATING: readonly { method: string; pattern: RegExp }[] = [
  { method: "PUT", pattern: /^\/v4\/domains\/[^/]+\/verify$/ },
];

// Called after a successful request so the next listing re-reads that account.
// Returns whether anything was invalidated, which keeps the policy testable.
export function invalidateOnWrite(method: string, path: string, account: string): boolean {
  const bare = path.split("?")[0];
  const upper = method.toUpperCase();
  const mutates = DOMAIN_MUTATING.some((r) => r.method === upper && r.pattern.test(bare));
  if (!mutates) return false;
  invalidateDomains(account);
  return true;
}

export function resetDomainCache(): void {
  entries.clear();
}
