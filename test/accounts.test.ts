import { describe, test, expect, afterEach } from "vitest";
import {
  AccountResolutionError,
  AccountsConfigError,
  DEFAULT_ACCOUNT_NAME,
  accountNames,
  buildAccountsConfig,
  hostnameForRegion,
  listAccounts,
  loadAccountsConfig,
  parseAccountsConfig,
  resetActiveAccountsConfig,
  resolveAccount,
  resolveAccountName,
  setActiveAccountsConfig,
} from "../src/accounts.js";

afterEach(() => {
  resetActiveAccountsConfig();
});

describe("hostnameForRegion()", () => {
  test("maps eu to the EU host and everything else to the US host", () => {
    expect(hostnameForRegion("eu")).toBe("api.eu.mailgun.net");
    expect(hostnameForRegion("us")).toBe("api.mailgun.net");
    expect(hostnameForRegion("")).toBe("api.mailgun.net");
  });
});

describe("buildAccountsConfig()", () => {
  test("accepts the wrapped form with an explicit default", () => {
    const config = buildAccountsConfig(
      {
        accounts: {
          xomad: { apiKey: "key-a", region: "us", description: "Main" },
          acme: { apiKey: "key-b", region: "eu" },
        },
        defaultAccount: "xomad",
      },
      "test",
    );

    expect([...config.accounts.keys()]).toEqual(["xomad", "acme"]);
    expect(config.defaultAccount).toBe("xomad");
    expect(config.accounts.get("acme")).toEqual({
      name: "acme",
      apiKey: "key-b",
      region: "eu",
      apiHostname: "api.eu.mailgun.net",
    });
    expect(config.accounts.get("xomad")?.description).toBe("Main");
  });

  test("accepts a bare map of account name to config", () => {
    const config = buildAccountsConfig({ a: { apiKey: "key-a" }, b: { apiKey: "key-b" } }, "test");

    expect([...config.accounts.keys()]).toEqual(["a", "b"]);
  });

  test("accepts an API key string as shorthand", () => {
    const config = buildAccountsConfig({ solo: "key-solo" }, "test");

    expect(config.accounts.get("solo")?.apiKey).toBe("key-solo");
    expect(config.accounts.get("solo")?.apiHostname).toBe("api.mailgun.net");
  });

  test("accepts snake_case field aliases", () => {
    const config = buildAccountsConfig(
      { accounts: { a: { api_key: "key-a", api_hostname: "api.example.test" } } },
      "test",
    );

    expect(config.accounts.get("a")?.apiKey).toBe("key-a");
    expect(config.accounts.get("a")?.apiHostname).toBe("api.example.test");
  });

  test("treats a lone account as the default", () => {
    const config = buildAccountsConfig({ only: { apiKey: "key" } }, "test");

    expect(config.defaultAccount).toBe("only");
  });

  test("leaves multiple accounts without a default unless one is named", () => {
    const config = buildAccountsConfig({ a: { apiKey: "1" }, b: { apiKey: "2" } }, "test");

    expect(config.defaultAccount).toBeUndefined();
  });

  test("rejects a defaultAccount that is not configured", () => {
    expect(() =>
      buildAccountsConfig({ accounts: { a: { apiKey: "1" } }, defaultAccount: "b" }, "test"),
    ).toThrow(AccountsConfigError);
  });

  test("rejects an account with no API key", () => {
    expect(() => buildAccountsConfig({ a: { region: "us" } }, "test")).toThrow(/missing "apiKey"/);
  });

  test("rejects an unknown region so a typo cannot silently hit the wrong host", () => {
    expect(() => buildAccountsConfig({ a: { apiKey: "1", region: "european" } }, "test")).toThrow(
      /unknown region/,
    );
  });

  test("rejects account names that would not survive an enum", () => {
    expect(() => buildAccountsConfig({ "bad name!": { apiKey: "1" } }, "test")).toThrow(
      /is invalid/,
    );
  });

  test("rejects a config with no accounts", () => {
    expect(() => buildAccountsConfig({ accounts: {} }, "test")).toThrow(/does not define any/);
    expect(() => buildAccountsConfig([], "test")).toThrow(/must be a JSON object/);
  });
});

describe("parseAccountsConfig()", () => {
  test("reports the source when the JSON is malformed", () => {
    expect(() => parseAccountsConfig("{nope", "MAILGUN_ACCOUNTS")).toThrow(
      /MAILGUN_ACCOUNTS is not valid JSON/,
    );
  });
});

describe("loadAccountsConfig()", () => {
  test("prefers an explicit accounts file over the environment", () => {
    const config = loadAccountsConfig({
      env: { MAILGUN_ACCOUNTS: '{"env":{"apiKey":"from-env"}}', MAILGUN_API_KEY: "legacy" },
      accountsFile: "/tmp/accounts.json",
      readFile: () => '{"file":{"apiKey":"from-file"}}',
    });

    expect([...config.accounts.keys()]).toEqual(["file"]);
    expect(config.source).toContain("/tmp/accounts.json");
  });

  test("falls back from MAILGUN_ACCOUNTS_FILE to MAILGUN_ACCOUNTS to MAILGUN_API_KEY", () => {
    const fromFile = loadAccountsConfig({
      env: { MAILGUN_ACCOUNTS_FILE: "/tmp/a.json", MAILGUN_ACCOUNTS: '{"env":{"apiKey":"x"}}' },
      readFile: () => '{"file":{"apiKey":"x"}}',
    });
    expect([...fromFile.accounts.keys()]).toEqual(["file"]);

    const fromInline = loadAccountsConfig({
      env: { MAILGUN_ACCOUNTS: '{"env":{"apiKey":"x"}}', MAILGUN_API_KEY: "legacy" },
    });
    expect([...fromInline.accounts.keys()]).toEqual(["env"]);

    const fromKey = loadAccountsConfig({
      env: { MAILGUN_API_KEY: "legacy", MAILGUN_API_REGION: "eu" },
    });
    expect([...fromKey.accounts.keys()]).toEqual([DEFAULT_ACCOUNT_NAME]);
    expect(fromKey.accounts.get(DEFAULT_ACCOUNT_NAME)?.apiHostname).toBe("api.eu.mailgun.net");
    expect(fromKey.defaultAccount).toBe(DEFAULT_ACCOUNT_NAME);
  });

  test("keeps the legacy hostname override working", () => {
    const config = loadAccountsConfig({
      env: { MAILGUN_API_KEY: "legacy", MAILGUN_API_HOSTNAME: "api.private.test" },
    });

    expect(config.accounts.get(DEFAULT_ACCOUNT_NAME)?.apiHostname).toBe("api.private.test");
  });

  test("explains what to set when nothing is configured", () => {
    expect(() => loadAccountsConfig({ env: {} })).toThrow(/No Mailgun credentials configured/);
  });

  test("wraps an unreadable accounts file", () => {
    expect(() =>
      loadAccountsConfig({
        env: {},
        accountsFile: "/nope.json",
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(/Could not read the accounts file/);
  });
});

describe("resolveAccount()", () => {
  test("returns the named account", () => {
    setActiveAccountsConfig(buildAccountsConfig({ a: { apiKey: "1" }, b: { apiKey: "2" } }, "t"));

    expect(resolveAccount("b").apiKey).toBe("2");
    expect(resolveAccountName("b")).toBe("b");
  });

  test("ignores surrounding whitespace", () => {
    setActiveAccountsConfig(buildAccountsConfig({ a: { apiKey: "1" }, b: { apiKey: "2" } }, "t"));

    expect(resolveAccount(" b ").name).toBe("b");
  });

  test("falls back to the default when no account is named", () => {
    setActiveAccountsConfig(
      buildAccountsConfig(
        { accounts: { a: { apiKey: "1" }, b: { apiKey: "2" } }, defaultAccount: "b" },
        "t",
      ),
    );

    expect(resolveAccount().name).toBe("b");
    expect(resolveAccount("").name).toBe("b");
  });

  test("lists the valid names when the account is unknown", () => {
    setActiveAccountsConfig(buildAccountsConfig({ a: { apiKey: "1" }, b: { apiKey: "2" } }, "t"));

    expect(() => resolveAccount("nope")).toThrow(AccountResolutionError);
    expect(() => resolveAccount("nope")).toThrow(/Configured accounts: a, b/);
  });

  test("requires an account when several are configured with no default", () => {
    setActiveAccountsConfig(buildAccountsConfig({ a: { apiKey: "1" }, b: { apiKey: "2" } }, "t"));

    expect(() => resolveAccount()).toThrow(/'account' is required/);
  });
});

describe("active config helpers", () => {
  test("expose the configured accounts in order", () => {
    setActiveAccountsConfig(buildAccountsConfig({ a: { apiKey: "1" }, b: { apiKey: "2" } }, "t"));

    expect(accountNames()).toEqual(["a", "b"]);
    expect(listAccounts().map((a) => a.apiKey)).toEqual(["1", "2"]);
  });
});
