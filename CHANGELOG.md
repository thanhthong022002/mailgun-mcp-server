# Changelog

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
