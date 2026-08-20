# Changelog

## 2.3.0

### Added

- **Multiple Mailgun accounts.** One API key manages one Mailgun account, so a single-key
  server could only ever reach that account's domains. The server now accepts a JSON
  description of several accounts and routes each tool call to the one it names:
  `MAILGUN_ACCOUNTS` (inline), `MAILGUN_ACCOUNTS_FILE`, or `--accounts-file`. Each account
  carries its own `apiKey`, `region`/`apiHostname` and optional `description`, so a US and
  an EU account can be served side by side.
  - Every generated tool gains an `account` parameter, published as an enum of the
    configured names so the model cannot invent one. It is required only when several
    accounts are configured with no `defaultAccount` — otherwise it falls back, and
    single-account setups never see a behaviour change.
  - Tool results and error messages are prefixed with `[account: <name>]`, so which
    account acted is always visible in the transcript.
  - Shorthands for short configs: the `accounts` wrapper may be omitted, and an account
    whose only setting is its key may be written as the key string.
  - An unknown `region` is rejected at startup rather than silently resolving to the US
    host; the legacy `MAILGUN_API_REGION` path keeps its lenient behaviour.
- **`list_mailgun_accounts` tool.** Returns the configured accounts and the sending
  domains each one manages, so an agent can resolve a domain to its owning account
  instead of guessing. Registered under every product tag, since account discovery is a
  prerequisite for all of them. Pass `include_domains: false` to skip the per-account
  `GET /v4/domains` lookup; an account whose lookup fails is reported inline rather than
  failing the whole listing.
- **Domain lookup caching.** Each account's domain list is cached in-process for 24 hours,
  so resolving a domain to its account costs one `GET /v4/domains` per account per day
  rather than one per conversation. A domain belongs to exactly one account and does not
  migrate, so a cached entry cannot go wrong — only incomplete, when a domain is added
  outside this server. Accounts whose lookup failed are not cached, and cached results
  carry a `domains_cached_at` timestamp. The cache refreshes on `refresh: true`, and
  automatically after a successful `PUT /v4/domains/{name}/verify` — the only exposed
  operation that changes what a listing reports. `MAILGUN_DOMAIN_CACHE_TTL` (seconds)
  overrides the default; `0` disables caching.
- **Inbound route management.** `POST /v3/routes` creates a route and
  `GET /v3/routes/match` checks whether an address matches an existing one, alongside the
  existing list, get, and update tools.
- **SMTP credential management.** List, create, and rotate the SMTP users of a sending
  domain: `GET`/`POST /v3/domains/{domain_name}/credentials` and
  `PUT /v3/domains/{domain_name}/credentials/{spec}`. Leaving `password` unset has Mailgun
  generate one — note that it is then returned in the tool response and therefore enters
  the model's context. See the README's security notes.

### Changed

- `MAILGUN_API_KEY` is no longer required on its own: startup now requires exactly one of
  `MAILGUN_ACCOUNTS`, `MAILGUN_ACCOUNTS_FILE`/`--accounts-file`, or `MAILGUN_API_KEY`, and
  reports which sources it looked at when none is set. A key set the old way is registered
  as the account `default` and remains the default account.
- The server logs the accounts it loaded, their source, and the default (if any) to stderr
  at startup.
- The 401 error message names the account whose key failed instead of naming
  `MAILGUN_API_KEY`.

## 2.2.0

### Added

- **Streamable HTTP transport.** The server can now serve the MCP Streamable HTTP
  transport in addition to stdio, so a client can connect over the network instead of
  spawning the process: `--transport http` (or `MAILGUN_MCP_TRANSPORT=http`). stdio
  remains the default, so existing configurations are unaffected.
  - Configurable bind interface, port and path — `--host` (default `127.0.0.1`),
    `--port` (default `3000`, `0` picks any free port) and `--endpoint`
    (default `/mcp`), each with a `MAILGUN_MCP_*` environment equivalent.
  - Stateful sessions per the MCP specification: `initialize` issues an
    `Mcp-Session-Id`, `GET` opens the server-to-client SSE stream, `DELETE` terminates
    the session, and unknown or terminated session ids return `404` so clients
    re-initialize. Each session gets its own server instance and tool registry.
  - `SIGINT`/`SIGTERM` close open sessions and the listener before exiting.
  - No new runtime dependencies: the listener is built on `node:http`.
- **HTTP transport hardening.** The process holds a Mailgun API key and MCP defines no
  authentication of its own, so the defaults are restrictive: a loopback bind, plus
  DNS-rebinding protection that rejects `Host` headers other than the loopback aliases
  for the listening port (widen it with `--allowed-hosts`). Setting
  `MAILGUN_MCP_AUTH_TOKEN` additionally requires `Authorization: Bearer <token>` on
  every request, compared in constant time; it is env-only so the secret stays out of
  the process command line. Request bodies are capped at 4 MB. The server warns at
  startup when it runs without a token, or binds a routable interface with no
  `Host` allowlist.
- `--transport sse` is rejected with an explanatory error: the HTTP+SSE transport was
  deprecated in the 2025-03-26 MCP specification, and Streamable HTTP replaces it.

### Changed

- Server construction moved to `createMcpServer()` in `src/create-server.ts`, which
  both transports use — the HTTP transport needs one instance per session, because a
  server can only be connected to one transport at a time. The entry point exports
  that factory in place of the previous module-level `server` singleton.

## 2.1.0

### Added

- **Multi-product coverage.** The OpenAPI driven tool registry now spans four
  Mailgun products — `send`, `validate`, `optimize`, and `inspect`. Endpoints are
  drawn from a curated allowlist, mapped to MCP tools from the bundled OpenAPI
  spec, and annotated with a product tag; all matching tools are registered at
  startup (scoped by tag filtering, see below). New endpoints added this release:
  - **Validation** — `validate_email` (`GET /v4/address/validate`) checks address
    deliverability and syntax before sending. Tagged `validate`.
  - **Optimize / Inbox Placement** — `get_inbox_placement_result`
    (`GET /v4/inbox/results/{result}`) retrieves seed/inbox placement test results.
    Tagged `optimize`.
  - **Inspect / Email Preview** — `get_preview_result`
    (`GET /v1/preview/tests/{test_id}/results`) retrieves email rendering/preview
    test results. Tagged `inspect`.
- **New analytics tool:** `get_metrics_summary` for a convenient rollup of sending
  metrics analysis.
- **Custom tool framework:** Introduced `src/custom-tools/` directory for tools that
  require logic beyond OpenAPI-to-MCP mapping.
- **Plan-aware error messages:** API errors now include actionable guidance based on
  HTTP status code (401, 403, 404, 400) with links to billing when relevant.
- **Tag-based tool filtering.** Operators can now scope which tools the server
  registers via the `--tags` CLI flag or `MAILGUN_MCP_TAGS` env var (values: `send`,
  `validate`, `optimize`, `inspect`). CLI takes precedence over the env var, and
  filtering uses OR semantics. Adds `--help` and `--list-tags` for discoverability.
  Every registered tool also carries a `_meta["com.mailgun/tags"]` annotation for
  downstream client-side filtering.

### Changed

- `makeMailgunRequest` now rejects with `MailgunApiError` (carrying `statusCode` and
  `apiMessage`) instead of a generic `Error`.

### Maintenance

- Split monolithic test file into module-specific test files under `test/`.

## 2.0.0

### Breaking (runtime)

- **Dropped Node 18 support.** The minimum required Node.js version is now **20.12.0**.
  Node 18 reached end-of-life on April 30, 2025, and current dev dependencies
  (vitest 4.x / rolldown) require `node:util.styleText` which was introduced in
  Node 20.12.
- **Shortened MCP tool IDs.** Redundant `_name` suffixes are now stripped from
  path-parameter segments in tool IDs (e.g. `get-v3-domain_name-templates-template_name`
  becomes `get-v3-domain-templates-template`). This keeps combined server + tool
  name lengths within common client/API 60-character limit. Consumers that reference tool
  IDs by name will need to update to the new shorter names.

### Maintenance

- Convert the codebase to Typescript
- Switched to vitest for testing
