import { describe, test, expect, beforeEach } from "vitest";
import {
  DEFAULT_DOMAIN_CACHE_TTL_MS,
  domainCacheTtlMs,
  getCachedDomains,
  invalidateDomains,
  invalidateOnWrite,
  resetDomainCache,
  setCachedDomains,
  type DomainListing,
} from "../src/domain-cache.js";

const listing: DomainListing = {
  domains: [{ name: "mg.acme.com", state: "active" }],
  domain_count: 1,
  truncated: false,
};

const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetDomainCache();
});

describe("domainCacheTtlMs()", () => {
  test("defaults to 24 hours", () => {
    expect(domainCacheTtlMs({})).toBe(DEFAULT_DOMAIN_CACHE_TTL_MS);
    expect(DEFAULT_DOMAIN_CACHE_TTL_MS).toBe(86_400_000);
  });

  test("reads an override in seconds", () => {
    expect(domainCacheTtlMs({ MAILGUN_DOMAIN_CACHE_TTL: "300" })).toBe(300_000);
    expect(domainCacheTtlMs({ MAILGUN_DOMAIN_CACHE_TTL: "0" })).toBe(0);
  });

  test("falls back to the default for unusable values", () => {
    for (const raw of ["", "   ", "abc", "-5"]) {
      expect(domainCacheTtlMs({ MAILGUN_DOMAIN_CACHE_TTL: raw })).toBe(DEFAULT_DOMAIN_CACHE_TTL_MS);
    }
  });
});

describe("domain cache entries", () => {
  test("returns a stored listing with the time it was fetched", () => {
    setCachedDomains("acme", listing, T0);

    expect(getCachedDomains("acme", T0 + 1000)).toEqual({ ...listing, fetchedAt: T0 });
  });

  test("misses for an account that was never stored", () => {
    expect(getCachedDomains("ghost", T0)).toBeUndefined();
  });

  test("expires exactly at the TTL boundary", () => {
    setCachedDomains("acme", listing, T0, 1000);

    expect(getCachedDomains("acme", T0 + 999)).toBeDefined();
    expect(getCachedDomains("acme", T0 + 1000)).toBeUndefined();
  });

  test("holds a 24-hour entry for just under a day", () => {
    setCachedDomains("acme", listing, T0, DEFAULT_DOMAIN_CACHE_TTL_MS);

    expect(getCachedDomains("acme", T0 + 23 * 60 * 60 * 1000)).toBeDefined();
    expect(getCachedDomains("acme", T0 + 25 * 60 * 60 * 1000)).toBeUndefined();
  });

  test("stores nothing when the TTL is zero", () => {
    setCachedDomains("acme", listing, T0, 0);

    expect(getCachedDomains("acme", T0)).toBeUndefined();
  });

  test("keeps accounts independent", () => {
    setCachedDomains("acme", listing, T0);
    setCachedDomains("globex", listing, T0);

    invalidateDomains("acme");

    expect(getCachedDomains("acme", T0)).toBeUndefined();
    expect(getCachedDomains("globex", T0)).toBeDefined();
  });

  test("clears everything when no account is named", () => {
    setCachedDomains("acme", listing, T0);
    setCachedDomains("globex", listing, T0);

    invalidateDomains();

    expect(getCachedDomains("acme", T0)).toBeUndefined();
    expect(getCachedDomains("globex", T0)).toBeUndefined();
  });
});

describe("invalidateOnWrite()", () => {
  test("drops the account's listing after a domain verification", () => {
    setCachedDomains("acme", listing, T0);

    expect(invalidateOnWrite("PUT", "/v4/domains/mg.acme.com/verify", "acme")).toBe(true);
    expect(getCachedDomains("acme", T0)).toBeUndefined();
  });

  test("only touches the account that performed the write", () => {
    setCachedDomains("acme", listing, T0);
    setCachedDomains("globex", listing, T0);

    invalidateOnWrite("PUT", "/v4/domains/mg.acme.com/verify", "acme");

    expect(getCachedDomains("globex", T0)).toBeDefined();
  });

  test("ignores a query string on the path", () => {
    setCachedDomains("acme", listing, T0);

    expect(invalidateOnWrite("PUT", "/v4/domains/mg.acme.com/verify?x=1", "acme")).toBe(true);
  });

  test("leaves the cache alone for writes that cannot change a listing", () => {
    const untouched = [
      ["GET", "/v4/domains"],
      ["GET", "/v4/domains/mg.acme.com/verify"],
      ["POST", "/v3/mg.acme.com/messages"],
      ["PUT", "/v3/domains/mg.acme.com/tracking/click"],
      ["POST", "/v3/domains/mg.acme.com/webhooks"],
      ["POST", "/v3/domains/mg.acme.com/credentials"],
      ["POST", "/v3/routes"],
    ] as const;

    for (const [method, path] of untouched) {
      setCachedDomains("acme", listing, T0);
      expect(invalidateOnWrite(method, path, "acme")).toBe(false);
      expect(getCachedDomains("acme", T0)).toBeDefined();
    }
  });
});
