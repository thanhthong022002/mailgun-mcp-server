import { type ActiveTags, KNOWN_TAGS, parseTagList } from "./tags.js";

export const TRANSPORTS = ["stdio", "http"] as const;

export type TransportKind = (typeof TRANSPORTS)[number];

export interface HttpOptions {
  host: string;
  port: number;
  endpoint: string;
  // Host header values accepted by the DNS-rebinding guard. Empty means "derive
  // the loopback defaults" (see src/http.ts).
  allowedHosts: string[];
  // Optional bearer token. Env-only: a CLI value would be visible in `ps`.
  authToken: string | undefined;
}

export interface CliResult {
  activeTags: ActiveTags;
  transport: TransportKind;
  http: HttpOptions;
  showHelp: boolean;
  listTags: boolean;
  invalid: string[];
  // Fatal configuration problems (unknown transport, unusable port).
  errors: string[];
}

const TAGS_ENV_VAR = "MAILGUN_MCP_TAGS";
const TRANSPORT_ENV_VAR = "MAILGUN_MCP_TRANSPORT";
const HOST_ENV_VAR = "MAILGUN_MCP_HOST";
const PORT_ENV_VAR = "MAILGUN_MCP_PORT";
const ENDPOINT_ENV_VAR = "MAILGUN_MCP_ENDPOINT";
const ALLOWED_HOSTS_ENV_VAR = "MAILGUN_MCP_ALLOWED_HOSTS";
const AUTH_TOKEN_ENV_VAR = "MAILGUN_MCP_AUTH_TOKEN";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_HTTP_ENDPOINT = "/mcp";

const VALUE_FLAGS = [
  "--tags",
  "--transport",
  "--host",
  "--port",
  "--endpoint",
  "--allowed-hosts",
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

const VALUE_FLAG_SET: ReadonlySet<string> = new Set<string>(VALUE_FLAGS);

function isValueFlag(name: string): name is ValueFlag {
  return VALUE_FLAG_SET.has(name);
}

interface ParsedArgv {
  showHelp: boolean;
  listTags: boolean;
  values: Partial<Record<ValueFlag, string>>;
}

function parseArgv(argv: readonly string[]): ParsedArgv {
  let showHelp = false;
  let listTags = false;
  const values: Partial<Record<ValueFlag, string>> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--list-tags") {
      listTags = true;
      continue;
    }

    const separator = arg.indexOf("=");
    if (separator > 0) {
      const name = arg.slice(0, separator);
      if (isValueFlag(name)) {
        values[name] = arg.slice(separator + 1);
      }
      continue;
    }

    if (isValueFlag(arg)) {
      const next = argv[i + 1];
      if (next !== undefined) {
        values[arg] = next;
        i += 1;
      }
      continue;
    }
  }

  return { showHelp, listTags, values };
}

// CLI takes precedence over env. An unset, empty, or whitespace-only value on
// either side counts as "not specified".
function pick(cliValue: string | undefined, envValue: string | undefined): string | undefined {
  const raw = cliValue !== undefined ? cliValue : envValue;
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

function resolveTransport(raw: string | undefined, errors: string[]): TransportKind {
  if (raw === undefined) return "stdio";
  const value = raw.toLowerCase();
  if (value === "stdio" || value === "http") return value;
  if (value === "sse") {
    errors.push(
      "Transport 'sse' is not supported: the HTTP+SSE transport was deprecated in the " +
        "2025-03-26 MCP specification. Use --transport http (Streamable HTTP) instead.",
    );
    return "stdio";
  }
  errors.push(`Unknown transport: ${raw}. Valid transports: ${TRANSPORTS.join(", ")}.`);
  return "stdio";
}

// Port 0 is allowed and means "any free port", which the server reports on startup.
function resolvePort(raw: string | undefined, errors: string[]): number {
  if (raw === undefined) return DEFAULT_HTTP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(`Invalid port: ${raw}. Expected an integer between 0 and 65535.`);
    return DEFAULT_HTTP_PORT;
  }
  return port;
}

function resolveEndpoint(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_HTTP_ENDPOINT;
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const trimmed = withLeadingSlash.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function resolveAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const segment of raw.split(",")) {
    const host = segment.trim().toLowerCase();
    if (host === "" || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

export function resolveActiveTags(argv: readonly string[], env: NodeJS.ProcessEnv): CliResult {
  const { showHelp, listTags, values } = parseArgv(argv);
  const errors: string[] = [];

  const transport = resolveTransport(pick(values["--transport"], env[TRANSPORT_ENV_VAR]), errors);
  const http: HttpOptions = {
    host: pick(values["--host"], env[HOST_ENV_VAR]) ?? DEFAULT_HTTP_HOST,
    port: resolvePort(pick(values["--port"], env[PORT_ENV_VAR]), errors),
    endpoint: resolveEndpoint(pick(values["--endpoint"], env[ENDPOINT_ENV_VAR])),
    allowedHosts: resolveAllowedHosts(pick(values["--allowed-hosts"], env[ALLOWED_HOSTS_ENV_VAR])),
    authToken: pick(undefined, env[AUTH_TOKEN_ENV_VAR]),
  };

  const base = { transport, http, showHelp, listTags, errors };

  const rawTags = values["--tags"] !== undefined ? values["--tags"] : env[TAGS_ENV_VAR];

  if (rawTags === undefined || rawTags.trim() === "") {
    return { ...base, activeTags: "all", invalid: [] };
  }

  const { tags, invalid } = parseTagList(rawTags);

  if (invalid.length > 0) {
    return { ...base, activeTags: "all", invalid };
  }

  // Input was non-empty but contained only separators/whitespace.
  // Treat the same as an empty value.
  if (tags.length === 0) {
    return { ...base, activeTags: "all", invalid: [] };
  }

  return { ...base, activeTags: new Set(tags), invalid: [] };
}

export function formatTagList(): string {
  return KNOWN_TAGS.join("\n");
}

export function formatHelp(): string {
  const tagList = KNOWN_TAGS.join(", ");
  return [
    "Usage: mailgun-mcp-server [options]",
    "",
    "Options:",
    `  --tags <list>      Comma-separated product tags to enable (default: all).`,
    `                     Valid: ${tagList}`,
    "  --list-tags        Print valid tag values and exit",
    `  --transport <kind> ${TRANSPORTS.join(" | ")} (default: stdio)`,
    "  --help, -h         Show this help and exit",
    "",
    "HTTP transport options (--transport http):",
    `  --host <host>      Interface to bind (default: ${DEFAULT_HTTP_HOST})`,
    `  --port <port>      Port to listen on, 0 for any free port (default: ${DEFAULT_HTTP_PORT})`,
    `  --endpoint <path>  Request path to serve (default: ${DEFAULT_HTTP_ENDPOINT})`,
    "  --allowed-hosts <list>",
    "                     Comma-separated Host header values accepted by the",
    "                     DNS-rebinding guard. Required when binding a non-loopback",
    "                     interface; otherwise defaults to the loopback aliases.",
    "",
    "Environment:",
    "  MAILGUN_API_KEY        (required) Mailgun API key",
    "  MAILGUN_API_REGION     'us' (default) or 'eu'",
    "  MAILGUN_API_HOSTNAME   Override API hostname",
    `  ${TAGS_ENV_VAR}       Same as --tags. CLI flag takes precedence.`,
    `  ${TRANSPORT_ENV_VAR}  Same as --transport.`,
    `  ${HOST_ENV_VAR}       Same as --host.`,
    `  ${PORT_ENV_VAR}       Same as --port.`,
    `  ${ENDPOINT_ENV_VAR}   Same as --endpoint.`,
    `  ${ALLOWED_HOSTS_ENV_VAR}`,
    "                         Same as --allowed-hosts.",
    `  ${AUTH_TOKEN_ENV_VAR}`,
    "                         If set, HTTP requests must carry",
    "                         'Authorization: Bearer <token>'. Env-only, so the",
    "                         token stays out of the process command line.",
    "",
    "Examples:",
    "  MAILGUN_API_KEY=... mailgun-mcp-server",
    "  MAILGUN_API_KEY=... mailgun-mcp-server --tags validate,inspect",
    "  MAILGUN_API_KEY=... mailgun-mcp-server --transport http --port 3000",
  ].join("\n");
}

export function formatInvalidTagsMessage(invalid: readonly string[]): string {
  const list = KNOWN_TAGS.join(", ");
  const plural = invalid.length === 1 ? "tag" : "tags";
  return `Unknown ${plural}: ${invalid.join(", ")}. Valid tags: ${list}.`;
}
