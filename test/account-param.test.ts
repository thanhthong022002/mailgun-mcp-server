import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { z } from "zod";
import {
  buildAccountsConfig,
  resetActiveAccountsConfig,
  setActiveAccountsConfig,
} from "../src/accounts.js";
import { ACCOUNT_PARAM, ACCOUNT_PARAM_FALLBACK, addAccountParam } from "../src/schema.js";
import { getCachedDomains, resetDomainCache, setCachedDomains } from "../src/domain-cache.js";
import type { OpenApiSpec } from "../src/types.js";

const makeMailgunRequest = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());

vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return { ...actual, makeMailgunRequest };
});

const { generateToolsFromOpenApi } = await import("../src/tools.js");

type ToolCall = [
  string,
  { inputSchema: Record<string, z.ZodType> },
  (p: never) => Promise<unknown>,
];

const twoAccounts = { a: { apiKey: "key-a" }, b: { apiKey: "key-b", region: "eu" } };

beforeEach(() => {
  makeMailgunRequest.mockReset();
  makeMailgunRequest.mockResolvedValue({ ok: true });
});

afterEach(() => {
  resetActiveAccountsConfig();
  resetDomainCache();
});

function registerSpec(spec: OpenApiSpec): ToolCall[] {
  const mockRegisterTool = vi.fn<(...args: unknown[]) => void>();
  generateToolsFromOpenApi(spec, { registerTool: mockRegisterTool } as never);
  return mockRegisterTool.mock.calls as unknown as ToolCall[];
}

const domainsSpec: OpenApiSpec = {
  paths: { "/v4/domains": { get: { summary: "Get domains", parameters: [] } } },
};

describe("addAccountParam()", () => {
  test("adds `account` to a generated schema", () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    const schema: Record<string, z.ZodType> = {};

    expect(addAccountParam(schema)).toBe(ACCOUNT_PARAM);
    expect(schema[ACCOUNT_PARAM]).toBeDefined();
  });

  test("falls back to `mailgun_account` when the operation defines its own `account`", () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    const schema = { account: {} as z.ZodType };

    expect(addAccountParam(schema)).toBe(ACCOUNT_PARAM_FALLBACK);
    expect(schema[ACCOUNT_PARAM_FALLBACK]).toBeDefined();
  });

  test("gives up rather than clobbering a real parameter", () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    const schema = { account: {} as z.ZodType, mailgun_account: {} as z.ZodType };

    expect(addAccountParam(schema)).toBeUndefined();
  });

  test("is required when several accounts are configured with no default", () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    const schema: Record<string, z.ZodType> = {};
    addAccountParam(schema);

    expect(schema[ACCOUNT_PARAM].safeParse(undefined).success).toBe(false);
    expect(schema[ACCOUNT_PARAM].safeParse("a").success).toBe(true);
    expect(schema[ACCOUNT_PARAM].safeParse("nope").success).toBe(false);
  });

  test("is optional once a default account exists", () => {
    setActiveAccountsConfig(
      buildAccountsConfig({ accounts: twoAccounts, defaultAccount: "a" }, "t"),
    );
    const schema: Record<string, z.ZodType> = {};
    addAccountParam(schema);

    expect(schema[ACCOUNT_PARAM].safeParse(undefined).success).toBe(true);
    expect(schema[ACCOUNT_PARAM].description).toContain('Defaults to "a"');
  });

  test("degrades to a plain optional string when nothing is configured", () => {
    // The ambient environment may well carry a real MAILGUN_API_KEY, so clear
    // the whole family to exercise the unconfigured path deterministically.
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MAILGUN_")) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }

    try {
      const schema: Record<string, z.ZodType> = {};
      addAccountParam(schema);

      expect(schema[ACCOUNT_PARAM].safeParse(undefined).success).toBe(true);
      expect(schema[ACCOUNT_PARAM].safeParse("anything").success).toBe(true);
    } finally {
      Object.assign(process.env, saved);
    }
  });
});

describe("generated tool handlers", () => {
  test("register an account parameter alongside the operation's own", () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));

    const [, config] = registerSpec(domainsSpec)[0];

    expect(Object.keys(config.inputSchema)).toContain("account");
  });

  test("route the request to the named account without sending it as a parameter", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    const [, , handler] = registerSpec({
      paths: {
        "/v3/routes": {
          post: {
            summary: "Create a route",
            requestBody: {
              content: {
                "application/x-www-form-urlencoded": {
                  schema: {
                    type: "object",
                    properties: { expression: { type: "string" } },
                    required: ["expression"],
                  },
                },
              },
            },
          },
        },
      },
    }).find((call) => call[0] === "post-v3-routes") as ToolCall;

    const result = (await handler({
      account: "b",
      expression: "match_recipient('.*@example.com')",
    } as never)) as { content: { text: string }[] };

    expect(makeMailgunRequest).toHaveBeenCalledTimes(1);
    const [method, path, body, , account] = makeMailgunRequest.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/v3/routes");
    expect(body).toEqual({ expression: "match_recipient('.*@example.com')" });
    expect(account).toBe("b");
    expect(result.content[0].text).toContain("[account: b]");
  });

  test("keep the account out of the query string on GETs", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    const [, , handler] = registerSpec(domainsSpec)[0];

    await handler({ account: "a" } as never);

    const [, path] = makeMailgunRequest.mock.calls[0];
    expect(path).toBe("/v4/domains");
  });

  test("fall back to the default account when the call omits one", async () => {
    setActiveAccountsConfig(
      buildAccountsConfig({ accounts: twoAccounts, defaultAccount: "a" }, "t"),
    );
    const [, , handler] = registerSpec(domainsSpec)[0];

    await handler({} as never);

    expect(makeMailgunRequest.mock.calls[0][4]).toBe("a");
  });

  test("report an unknown account as a tool error without calling the API", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    const [, , handler] = registerSpec(domainsSpec)[0];

    const result = (await handler({ account: "ghost" } as never)) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown Mailgun account "ghost"');
    expect(makeMailgunRequest).not.toHaveBeenCalled();
  });
});

describe("domain cache invalidation through a tool call", () => {
  const listing = { domains: [{ name: "mg.a.com" }], domain_count: 1, truncated: false };
  const verifySpec: OpenApiSpec = {
    paths: {
      "/v4/domains/{name}/verify": {
        put: {
          summary: "Verify domain",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        },
      },
    },
  };

  test("a successful verify drops that account's cached domain listing", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    setCachedDomains("a", listing);
    setCachedDomains("b", listing);

    const [, , handler] = registerSpec(verifySpec)[0];
    await handler({ account: "a", name: "mg.a.com" } as never);

    expect(getCachedDomains("a")).toBeUndefined();
    expect(getCachedDomains("b")).toBeDefined();
  });

  test("a failed verify leaves the cache in place", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    setCachedDomains("a", listing);
    makeMailgunRequest.mockRejectedValueOnce(new Error("network down"));

    const [, , handler] = registerSpec(verifySpec)[0];
    await handler({ account: "a", name: "mg.a.com" } as never);

    expect(getCachedDomains("a")).toBeDefined();
  });

  test("an unrelated write leaves the cache in place", async () => {
    setActiveAccountsConfig(buildAccountsConfig(twoAccounts, "t"));
    setCachedDomains("a", listing);

    const [, , handler] = registerSpec(domainsSpec)[0];
    await handler({ account: "a" } as never);

    expect(getCachedDomains("a")).toBeDefined();
  });
});
