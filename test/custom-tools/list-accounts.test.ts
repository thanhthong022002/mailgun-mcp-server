import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAccountsConfig,
  resetActiveAccountsConfig,
  setActiveAccountsConfig,
} from "../../src/accounts.js";
import { MailgunApiError } from "../../src/api.js";
import { getCachedDomains, resetDomainCache } from "../../src/domain-cache.js";

const makeMailgunRequest = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());

vi.mock("../../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api.js")>();
  return { ...actual, makeMailgunRequest };
});

const { register, summarizeDomains } = await import("../../src/custom-tools/list-accounts.js");

type Handler = (params: never) => Promise<{ isError?: boolean; content: { text: string }[] }>;

function registerTool(): Handler {
  const mockRegisterTool = vi.fn<(...args: unknown[]) => void>();
  register({ registerTool: mockRegisterTool } as never, ["send"]);
  return mockRegisterTool.mock.calls[0][2] as Handler;
}

async function run(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await registerTool()(params as never);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  makeMailgunRequest.mockReset();
  // The domain cache is module-level state shared across tests.
  resetDomainCache();
});

afterEach(() => {
  resetActiveAccountsConfig();
  resetDomainCache();
});

describe("summarizeDomains()", () => {
  test("keeps name, state and type and drops entries with no name", () => {
    const result = summarizeDomains({
      items: [
        { name: "mg.a.com", state: "active", type: "custom" },
        { name: "", state: "active" },
        { state: "unverified" },
        { name: "mg.b.com", state: "unverified", type: "sandbox", is_disabled: true },
      ],
      total_count: 4,
    });

    expect(result.domains).toEqual([
      { name: "mg.a.com", state: "active", type: "custom" },
      { name: "mg.b.com", state: "unverified", type: "sandbox", disabled: true },
    ]);
  });

  test("flags truncation when the page is smaller than the total", () => {
    expect(summarizeDomains({ items: [{ name: "a.com" }], total_count: 9 }).truncated).toBe(true);
    expect(summarizeDomains({ items: [{ name: "a.com" }], total_count: 1 }).truncated).toBe(false);
  });

  test("tolerates a response with no items", () => {
    const result = summarizeDomains({});
    expect(result.domains).toEqual([]);
    expect(result.domain_count).toBe(0);
  });
});

describe("list_mailgun_accounts", () => {
  test("lists every account with its domains, one lookup per account", async () => {
    setActiveAccountsConfig(
      buildAccountsConfig(
        {
          accounts: {
            xomad: { apiKey: "1", description: "Main" },
            acme: { apiKey: "2", region: "eu" },
          },
          defaultAccount: "xomad",
        },
        "t",
      ),
    );
    makeMailgunRequest.mockImplementation((_m, _p, _d, _c, account) =>
      Promise.resolve({
        items: [{ name: `mg.${String(account)}.com`, state: "active" }],
        total_count: 1,
      }),
    );

    const output = await run({});

    expect(makeMailgunRequest).toHaveBeenCalledTimes(2);
    expect(output.default_account).toBe("xomad");
    expect(output.account_required).toBe(false);
    expect(output.accounts).toEqual([
      {
        account: "xomad",
        region: "us",
        description: "Main",
        is_default: true,
        domains: [{ name: "mg.xomad.com", state: "active" }],
        domain_count: 1,
      },
      {
        account: "acme",
        region: "eu",
        is_default: false,
        domains: [{ name: "mg.acme.com", state: "active" }],
        domain_count: 1,
      },
    ]);
  });

  test("reports account_required when there is no default", async () => {
    setActiveAccountsConfig(buildAccountsConfig({ a: { apiKey: "1" }, b: { apiKey: "2" } }, "t"));
    makeMailgunRequest.mockResolvedValue({ items: [], total_count: 0 });

    const output = await run({ include_domains: false });

    expect(output.account_required).toBe(true);
    expect(output.default_account).toBeNull();
    expect(makeMailgunRequest).not.toHaveBeenCalled();
  });

  test("isolates a failing account instead of failing the whole listing", async () => {
    setActiveAccountsConfig(
      buildAccountsConfig({ good: { apiKey: "1" }, bad: { apiKey: "2" } }, "t"),
    );
    makeMailgunRequest.mockImplementation((_m, _p, _d, _c, account) =>
      account === "bad"
        ? Promise.reject(new MailgunApiError("Unauthorized", 401, "Unauthorized"))
        : Promise.resolve({ items: [{ name: "mg.good.com" }], total_count: 1 }),
    );

    const accounts = (await run({})).accounts as Record<string, unknown>[];

    expect(accounts[0].domains).toEqual([{ name: "mg.good.com" }]);
    expect(accounts[1].error).toBe("HTTP 401: Unauthorized");
    expect(accounts[1].domains).toBeUndefined();
  });

  test("can narrow the listing to a single account", async () => {
    setActiveAccountsConfig(buildAccountsConfig({ a: { apiKey: "1" }, b: { apiKey: "2" } }, "t"));
    makeMailgunRequest.mockResolvedValue({ items: [], total_count: 0 });

    const accounts = (await run({ account: "b" })).accounts as Record<string, unknown>[];

    expect(accounts).toHaveLength(1);
    expect(accounts[0].account).toBe("b");
  });

  test("rejects an unknown account by name", async () => {
    setActiveAccountsConfig(buildAccountsConfig({ a: { apiKey: "1" } }, "t"));

    const result = await registerTool()({ account: "ghost" } as never);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown Mailgun account "ghost"');
  });
});

describe("list_mailgun_accounts domain caching", () => {
  const twoAccounts = { a: { apiKey: "1" }, b: { apiKey: "2" } };

  function domainsFor(account: unknown) {
    return Promise.resolve({ items: [{ name: `mg.${String(account)}.com` }], total_count: 1 });
  }

  test("serves the second call from cache instead of re-reading the API", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    makeMailgunRequest.mockImplementation((_m, _p, _d, _c, account) => domainsFor(account));

    await run({});
    expect(makeMailgunRequest).toHaveBeenCalledTimes(2);

    const second = await run({});
    expect(makeMailgunRequest).toHaveBeenCalledTimes(2);

    const accounts = second.accounts as Record<string, unknown>[];
    expect(accounts[0].domains).toEqual([{ name: "mg.a.com" }]);
    expect(typeof accounts[0].domains_cached_at).toBe("string");
  });

  test("marks a live lookup without a cache timestamp", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    makeMailgunRequest.mockImplementation((_m, _p, _d, _c, account) => domainsFor(account));

    const accounts = (await run({})).accounts as Record<string, unknown>[];

    expect(accounts[0].domains_cached_at).toBeUndefined();
  });

  test("refresh bypasses the cache and repopulates it", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    makeMailgunRequest.mockImplementation((_m, _p, _d, _c, account) => domainsFor(account));

    await run({});
    const accounts = (await run({ refresh: true })).accounts as Record<string, unknown>[];

    expect(makeMailgunRequest).toHaveBeenCalledTimes(4);
    expect(accounts[0].domains_cached_at).toBeUndefined();
    expect(getCachedDomains("a")).toBeDefined();
  });

  test("does not cache an account whose lookup failed", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    makeMailgunRequest.mockImplementation((_m, _p, _d, _c, account) =>
      account === "b"
        ? Promise.reject(new MailgunApiError("boom", 500, "boom"))
        : domainsFor(account),
    );

    await run({});
    expect(getCachedDomains("a")).toBeDefined();
    expect(getCachedDomains("b")).toBeUndefined();

    await run({});
    // "a" is served from cache; only the previously failing "b" is retried.
    expect(makeMailgunRequest).toHaveBeenCalledTimes(3);
  });

  test("include_domains: false neither reads nor writes the cache", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    makeMailgunRequest.mockImplementation((_m, _p, _d, _c, account) => domainsFor(account));

    await run({ include_domains: false });

    expect(makeMailgunRequest).not.toHaveBeenCalled();
    expect(getCachedDomains("a")).toBeUndefined();
  });
});
