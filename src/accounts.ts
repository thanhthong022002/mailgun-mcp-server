import { readFileSync } from "node:fs";

// Name used for the implicit account synthesized from MAILGUN_API_KEY, so
// single-account setups predating the JSON config keep working unchanged.
export const DEFAULT_ACCOUNT_NAME = "default";

// Account names surface in a Zod enum and in tool descriptions, so keep them to
// characters that are unambiguous to type and safe to interpolate.
const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const KNOWN_REGIONS = ["us", "eu"] as const;

export class AccountsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountsConfigError";
  }
}

// Raised per tool call, not at startup: an unknown account name, or an omitted
// one on a server that has no default.
export class AccountResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountResolutionError";
  }
}

export interface MailgunAccount {
  name: string;
  apiKey: string;
  region: string;
  apiHostname: string;
  description?: string;
}

export interface AccountsConfig {
  // Insertion-ordered, so listings and enums follow the order in the config.
  accounts: ReadonlyMap<string, MailgunAccount>;
  // Account used when a tool call omits `account`. Undefined means the caller
  // must name one, which is what makes the parameter required.
  defaultAccount: string | undefined;
  // Where the config came from, quoted back in error messages.
  source: string;
}

export function hostnameForRegion(region: string): string {
  return region === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = value.trim();
  return result === "" ? undefined : result;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildAccount(name: string, value: unknown, source: string): MailgunAccount {
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new AccountsConfigError(
      `${source}: account name "${name}" is invalid. Use 1-64 characters from A-Z, a-z, 0-9, underscore or hyphen.`,
    );
  }

  // Shorthand: "name": "key-..." is the same as { "apiKey": "key-..." }.
  let raw: Record<string, unknown>;
  if (typeof value === "string") {
    raw = { apiKey: value };
  } else if (isPlainObject(value)) {
    raw = value;
  } else {
    throw new AccountsConfigError(
      `${source}: account "${name}" must be an object or an API key string.`,
    );
  }

  const apiKey = firstString(raw.apiKey, raw.api_key);
  if (apiKey === undefined) {
    throw new AccountsConfigError(`${source}: account "${name}" is missing "apiKey".`);
  }

  const region = (firstString(raw.region) ?? "us").toLowerCase();
  if (!(KNOWN_REGIONS as readonly string[]).includes(region)) {
    throw new AccountsConfigError(
      `${source}: account "${name}" has unknown region "${region}". Valid regions: ${KNOWN_REGIONS.join(", ")}. ` +
        `Set "apiHostname" instead to point at a non-standard host.`,
    );
  }

  const apiHostname = firstString(raw.apiHostname, raw.api_hostname) ?? hostnameForRegion(region);
  const description = firstString(raw.description);

  return description === undefined
    ? { name, apiKey, region, apiHostname }
    : { name, apiKey, region, apiHostname, description };
}

// Accepts either the wrapped form — { "accounts": { ... }, "defaultAccount": "x" } —
// or a bare map of account name to config.
export function buildAccountsConfig(parsed: unknown, source: string): AccountsConfig {
  if (!isPlainObject(parsed)) {
    throw new AccountsConfigError(`${source} must be a JSON object.`);
  }

  const wrapped = "accounts" in parsed;
  const rawAccounts = wrapped ? parsed.accounts : parsed;
  if (!isPlainObject(rawAccounts)) {
    throw new AccountsConfigError(
      `${source}: "accounts" must be a JSON object keyed by account name.`,
    );
  }

  const entries = Object.entries(rawAccounts);
  if (entries.length === 0) {
    throw new AccountsConfigError(`${source} does not define any accounts.`);
  }

  const accounts = new Map<string, MailgunAccount>();
  for (const [name, value] of entries) {
    accounts.set(name, buildAccount(name, value, source));
  }

  const rawDefault = wrapped ? (parsed.defaultAccount ?? parsed.default_account) : undefined;
  let defaultAccount: string | undefined;
  if (rawDefault !== undefined) {
    if (typeof rawDefault !== "string" || !accounts.has(rawDefault)) {
      throw new AccountsConfigError(
        `${source}: defaultAccount "${String(rawDefault)}" is not one of the configured accounts (${[...accounts.keys()].join(", ")}).`,
      );
    }
    defaultAccount = rawDefault;
  } else if (accounts.size === 1) {
    // A lone account is unambiguous, so treat it as the default and let tool
    // calls leave `account` out entirely.
    defaultAccount = entries[0][0];
  }

  return { accounts, defaultAccount, source };
}

export function parseAccountsConfig(raw: string, source: string): AccountsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AccountsConfigError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  return buildAccountsConfig(parsed, source);
}

export interface LoadAccountsOptions {
  env?: NodeJS.ProcessEnv;
  // CLI --accounts-file, which wins over the environment.
  accountsFile?: string;
  readFile?: (path: string) => string;
}

// Precedence: --accounts-file, MAILGUN_ACCOUNTS_FILE, MAILGUN_ACCOUNTS, then the
// legacy single-key MAILGUN_API_KEY.
export function loadAccountsConfig(options: LoadAccountsOptions = {}): AccountsConfig {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  const file = trimmed(options.accountsFile) ?? trimmed(env.MAILGUN_ACCOUNTS_FILE);
  if (file !== undefined) {
    let contents: string;
    try {
      contents = readFile(file);
    } catch (error) {
      throw new AccountsConfigError(
        `Could not read the accounts file (${file}): ${(error as Error).message}`,
      );
    }
    return parseAccountsConfig(contents, `Accounts file (${file})`);
  }

  const inline = trimmed(env.MAILGUN_ACCOUNTS);
  if (inline !== undefined) {
    return parseAccountsConfig(inline, "MAILGUN_ACCOUNTS");
  }

  const apiKey = trimmed(env.MAILGUN_API_KEY);
  if (apiKey !== undefined) {
    // Legacy path stays lenient about the region value, matching the behaviour
    // of the single-key server: anything other than "eu" means the US host.
    const region = (trimmed(env.MAILGUN_API_REGION) ?? "us").toLowerCase();
    const apiHostname = trimmed(env.MAILGUN_API_HOSTNAME) ?? hostnameForRegion(region);
    const account: MailgunAccount = {
      name: DEFAULT_ACCOUNT_NAME,
      apiKey,
      region,
      apiHostname,
    };
    return {
      accounts: new Map([[DEFAULT_ACCOUNT_NAME, account]]),
      defaultAccount: DEFAULT_ACCOUNT_NAME,
      source: "MAILGUN_API_KEY",
    };
  }

  throw new AccountsConfigError(
    "No Mailgun credentials configured. Set MAILGUN_ACCOUNTS (inline JSON), " +
      "MAILGUN_ACCOUNTS_FILE / --accounts-file (path to a JSON file), or MAILGUN_API_KEY " +
      "for a single account.",
  );
}

// --- Active configuration ---

let active: AccountsConfig | undefined;

export function setActiveAccountsConfig(config: AccountsConfig): void {
  active = config;
}

export function resetActiveAccountsConfig(): void {
  active = undefined;
}

export function getActiveAccountsConfig(): AccountsConfig {
  if (active === undefined) {
    active = loadAccountsConfig();
  }
  return active;
}

// Schema construction runs before startup validation and must not throw on an
// unconfigured server, so callers that only want to describe the options use this.
export function tryGetActiveAccountsConfig(): AccountsConfig | undefined {
  try {
    return getActiveAccountsConfig();
  } catch {
    return undefined;
  }
}

export function listAccounts(): MailgunAccount[] {
  return [...getActiveAccountsConfig().accounts.values()];
}

export function accountNames(): string[] {
  return [...getActiveAccountsConfig().accounts.keys()];
}

export function resolveAccount(name?: string): MailgunAccount {
  const config = getActiveAccountsConfig();
  const requested = trimmed(name);
  const names = [...config.accounts.keys()];

  if (requested !== undefined) {
    const account = config.accounts.get(requested);
    if (account === undefined) {
      throw new AccountResolutionError(
        `Unknown Mailgun account "${requested}". Configured accounts: ${names.join(", ")}.`,
      );
    }
    return account;
  }

  if (config.defaultAccount !== undefined) {
    // Present by construction: the default is validated against the map.
    return config.accounts.get(config.defaultAccount) as MailgunAccount;
  }

  throw new AccountResolutionError(
    `This server manages multiple Mailgun accounts and has no default, so 'account' is required. ` +
      `Configured accounts: ${names.join(", ")}.`,
  );
}

export function resolveAccountName(name?: string): string {
  return resolveAccount(name).name;
}
