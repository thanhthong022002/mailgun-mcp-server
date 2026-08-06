# Mailgun MCP Server

[![npm version](https://img.shields.io/npm/v/@mailgun/mcp-server.svg)](https://www.npmjs.com/package/@mailgun/mcp-server)
[![MCP](https://img.shields.io/badge/MCP-Server-blue.svg)](https://github.com/modelcontextprotocol)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg)](LICENSE)

## Overview

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [Mailgun](https://mailgun.com) that gives AI agents a practical, workflow-oriented interface to send email, diagnose deliverability, and manage account operations.

> [!NOTE]
> This MCP server runs on your own machine or infrastructure — Mailgun does not offer a hosted version. It speaks **stdio** by default, and can also serve the **Streamable HTTP** transport with `--transport http` (see [HTTP transport](#http-transport)).

### Capabilities

- **Messaging** — Send emails, retrieve stored messages, resend messages
- **Domains** — View domain details, verify DNS configuration, manage tracking settings (click, open, unsubscribe)
- **Webhooks** — List, create, and update event webhooks
- **Routes** — View and update inbound email routing rules
- **Mailing Lists** — Create, view, and update mailing lists and their members
- **Templates** — Create, view, and update email templates with versioning
- **Analytics** — Query sending metrics, usage metrics, and logs
- **Stats** — View aggregate statistics by domain, tag, provider, device, and country
- **Suppressions** — View bounces, unsubscribes, complaints, and allowlist entries
- **IPs & IP Pools** — View IP assignments and dedicated IP pool configuration
- **Bounce Classification** — Analyze bounce types and delivery issues
- **Validation** — Validate email address deliverability and syntax before sending (`validate`)
- **Optimize (Inbox Placement)** — Retrieve inbox placement / seed test results to gauge deliverability (`optimize`)
- **Inspect (Email Preview)** — Retrieve email rendering and preview test results across clients (`inspect`)
- **Account Limits** — View custom monthly sending limits

The parenthetical labels above (`validate`, `optimize`, `inspect`) are the product tags used by [tag filtering](#tag-filtering). Every other capability is registered under the `send` tag.

> [!NOTE]
> Tools are limited to read and update operations — no delete operations are exposed, which keeps the blast radius of an unintended action small. See [Security Considerations](#security-considerations).

### How it works

The server is OpenAPI driven. At startup it parses a bundled Mailgun OpenAPI spec and registers a curated allowlist of endpoints as MCP tools, generating each tool's input schema (via Zod) from the spec. Every tool is annotated with a Mailgun product tag (`send`, `validate`, `optimize`, or `inspect`). All matching tools are registered up front — there is no lazy or on demand loading. [Tag filtering](#tag-filtering) is applied at startup to scope *which* tools get registered, so a given workflow can expose only the products it needs.

## Prerequisites

- Node.js (v20.12 or higher)
- Mailgun account and API key

## Installation

The server is published to npm as [`@mailgun/mcp-server`](https://www.npmjs.com/package/@mailgun/mcp-server) and runs over stdio. Most clients can launch it on demand with `npx`, so there's nothing to install globally. In each snippet below, replace `YOUR-mailgun-api-key` with a key from your [Mailgun API security settings](https://app.mailgun.com/settings/api_security).

> [!TIP]
> If your account is hosted in Mailgun's EU region, add `"MAILGUN_API_REGION": "eu"` to the `env` block (or `-e MAILGUN_API_REGION=eu` on the CLI). It defaults to `us`.

### Claude Code

```bash
claude mcp add mailgun -e MAILGUN_API_KEY=YOUR-mailgun-api-key -- npx -y @mailgun/mcp-server
```

Then run `/mcp` in Claude Code to confirm the **mailgun** server is connected.

### Claude Desktop

Open **Settings → Developer → Edit Config**, or edit the file directly:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mailgun": {
      "command": "npx",
      "args": ["-y", "@mailgun/mcp-server"],
      "env": {
        "MAILGUN_API_KEY": "YOUR-mailgun-api-key",
        "MAILGUN_API_REGION": "us"
      }
    }
  }
}
```

### Cursor

Open the command palette and choose **Cursor Settings → MCP → Add new global MCP server**, then add:

```json
{
  "mcpServers": {
    "mailgun": {
      "command": "npx",
      "args": ["-y", "@mailgun/mcp-server"],
      "env": {
        "MAILGUN_API_KEY": "YOUR-mailgun-api-key"
      }
    }
  }
}
```

### Codex

```bash
codex mcp add mailgun \
  --env MAILGUN_API_KEY=YOUR-mailgun-api-key \
  -- npx -y @mailgun/mcp-server
```

### VS Code (GitHub Copilot)

Add the following to your `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "mailgun": {
        "command": "npx",
        "args": ["-y", "@mailgun/mcp-server"],
        "env": {
          "MAILGUN_API_KEY": "YOUR-mailgun-api-key"
        }
      }
    }
  }
}
```

### Windsurf

```json
{
  "mcpServers": {
    "mailgun": {
      "command": "npx",
      "args": ["-y", "@mailgun/mcp-server"],
      "env": {
        "MAILGUN_API_KEY": "YOUR-mailgun-api-key"
      }
    }
  }
}
```

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "mailgun": {
      "command": "npx",
      "args": ["-y", "@mailgun/mcp-server"],
      "env": {
        "MAILGUN_API_KEY": "YOUR-mailgun-api-key"
      }
    }
  }
}
```

## Configuration

### Environment variables

| Variable               | Required | Default              | Description                                                                                 |
| ---------------------- | -------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `MAILGUN_API_KEY`      | Yes      | —                    | Your Mailgun API key                                                                        |
| `MAILGUN_API_REGION`   | No       | `us`                 | API region: `us` or `eu`                                                                     |
| `MAILGUN_API_HOSTNAME` | No       | (derived from region) | Override the API hostname (e.g. `api.eu.mailgun.net`). Takes precedence over the region.     |
| `MAILGUN_MCP_TAGS`     | No       | (all)                | Comma-separated product tags to enable. Equivalent to `--tags`. The CLI flag takes precedence. |
| `MAILGUN_MCP_TRANSPORT` | No      | `stdio`              | Transport to serve: `stdio` or `http`. Equivalent to `--transport`.                          |
| `MAILGUN_MCP_HOST`     | No       | `127.0.0.1`          | HTTP transport bind interface. Equivalent to `--host`.                                       |
| `MAILGUN_MCP_PORT`     | No       | `3000`               | HTTP transport port. Equivalent to `--port`.                                                 |
| `MAILGUN_MCP_ENDPOINT` | No       | `/mcp`               | HTTP transport request path. Equivalent to `--endpoint`.                                     |
| `MAILGUN_MCP_ALLOWED_HOSTS` | No  | (loopback aliases)   | Comma-separated `Host` header values accepted by the DNS-rebinding guard. Equivalent to `--allowed-hosts`. |
| `MAILGUN_MCP_AUTH_TOKEN` | No     | (none)               | If set, HTTP requests must send `Authorization: Bearer <token>`. **Env-only** — there is no CLI flag, so the token stays out of the process command line. |

### CLI options

Pass flags after the package name in your client's `args` (e.g. `["-y", "@mailgun/mcp-server", "--tags", "validate,inspect"]`).

| Flag              | Description                                                                             |
| ----------------- | -------------------------------------------------------------------------------------- |
| `--tags <list>`   | Comma-separated product tags to enable (default: all). Valid: `send`, `validate`, `optimize`, `inspect`. |
| `--list-tags`     | Print the valid tag values and exit.                                                   |
| `--transport <kind>` | Transport to serve: `stdio` (default) or `http`.                                     |
| `--host <host>`   | HTTP transport: interface to bind (default: `127.0.0.1`).                               |
| `--port <port>`   | HTTP transport: port to listen on, `0` for any free port (default: `3000`).             |
| `--endpoint <path>` | HTTP transport: request path to serve (default: `/mcp`).                              |
| `--allowed-hosts <list>` | HTTP transport: comma-separated `Host` values accepted by the DNS-rebinding guard. |
| `--help`, `-h`    | Show usage and exit.                                                                    |

Every flag has an environment-variable equivalent (see the table above). The CLI flag wins when both are set.

### Tag filtering

You can scope which tools the server registers to one or more Mailgun product tags. This is useful for narrowing the toolset shown to the model — for example, only exposing validation tools to a workflow that doesn't need send capabilities.

Valid tags: `send`, `validate`, `optimize`, `inspect`. When unspecified, every tool is registered (today's default).

Filtering uses **OR semantics**: a tool is registered if any of its tags appears in the active set.

**Via CLI flag** — pass `--tags` in your MCP client config's `args`:

```json
{
  "mcpServers": {
    "mailgun": {
      "command": "npx",
      "args": ["-y", "@mailgun/mcp-server", "--tags", "validate,inspect"],
      "env": {
        "MAILGUN_API_KEY": "YOUR-mailgun-api-key"
      }
    }
  }
}
```

**Via environment variable** — set `MAILGUN_MCP_TAGS` (CLI flag wins if both are present):

```json
"env": {
  "MAILGUN_API_KEY": "YOUR-mailgun-api-key",
  "MAILGUN_MCP_TAGS": "validate,inspect"
}
```

> [!TIP]
> Run the binary with `--list-tags` to print supported tag values, or `--help` for full usage. Unknown tags are rejected at startup with a clear error message.

### HTTP transport

By default the server speaks **stdio**: your MCP client launches it as a subprocess and talks to it over stdin/stdout. That is the right choice for a desktop client and needs no configuration.

With `--transport http` the server instead listens for the **Streamable HTTP** transport, so a client can connect over the network rather than spawning the process. Use it when the client and the server run in different places — a remote client, a container, or several clients sharing one server process.

```bash
MAILGUN_API_KEY=YOUR-mailgun-api-key \
MAILGUN_MCP_AUTH_TOKEN=YOUR-shared-secret \
  npx -y @mailgun/mcp-server --transport http --port 3000
```

The server prints the endpoint it is serving and stays in the foreground:

```
Mailgun MCP Server listening on http://127.0.0.1:3000/mcp (Streamable HTTP)
```

Point a client at that URL:

```json
{
  "mcpServers": {
    "mailgun": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR-shared-secret"
      }
    }
  }
}
```

Sessions are stateful, per the MCP specification:

- A client `initialize` request creates a session; the id comes back in the `Mcp-Session-Id` response header and must be sent on every subsequent request.
- `GET` on the endpoint opens the server-to-client SSE stream for that session.
- `DELETE` on the endpoint terminates the session. Requests carrying an unknown or terminated session id get `404`, which tells the client to re-initialize.
- Each session gets its own server instance with its own tool registry, so tag filtering applies to all sessions equally.

> [!IMPORTANT]
> The HTTP transport has no authentication of its own, and the process holds your Mailgun API key — anything that can reach the endpoint can send mail and read your logs as you. The defaults are therefore deliberately conservative: the server binds `127.0.0.1` and rejects `Host` headers other than the loopback aliases. Before exposing it more widely, read [Exposing the HTTP transport](#exposing-the-http-transport).

> [!NOTE]
> The deprecated HTTP+SSE transport (two endpoints, `GET /sse` plus `POST /messages`) is **not** supported. It was replaced by Streamable HTTP in the 2025-03-26 revision of the MCP specification. `--transport sse` exits with a message pointing at `--transport http`.

## Sample Prompts

#### Send an Email

```
Can you send an email to EMAIL_HERE with a funny email body that makes it sound
like it's from the IT Desk from Office Space? Please use the sending domain
DOMAIN_HERE, and make the email from "postmaster@DOMAIN_HERE"!
```

> [!NOTE]
> Some MCP clients require a paid plan to invoke tools that send data. If sending fails silently, check your client's plan.

#### Fetch and Visualize Sending Statistics

```
Would you be able to make a chart with email delivery statistics for the past week?
```

#### Manage Templates

```
Create a welcome email template for new signups on my domain DOMAIN_HERE.
Include a personalized greeting and a call-to-action button.
```

#### Investigate Deliverability

```
Can you check the bounce classification stats for my account and tell me
what the most common bounce reasons are?
```

#### Troubleshoot DNS

```
Check the DNS verification status for my domain DOMAIN_HERE and tell me
if anything needs fixing.
```

#### Review Suppressions

```
Are there any unsubscribes or complaints for DOMAIN_HERE? Summarize the
top offenders.
```

#### Manage Routing Rules

```
List all my inbound routes and explain what each one does.
```

#### Create a Mailing List

```
Create a mailing list called announcements@DOMAIN_HERE and add these
members: alice@example.com, bob@example.com.
```

#### Compare Domains

```
Compare my sending volume and delivery rates across all my domains for
the past month.
```

#### Engagement by Region

```
Break down my email engagement by country and device for DOMAIN_HERE.
```

#### Review Tracking Settings

```
List all my domains and show which ones have tracking enabled for clicks
and opens.
```

#### Validate an Email Address

```
Validate the email address EMAIL_HERE and tell me whether it's safe to send to.
```

#### Check Inbox Placement (Optimize)

```
Pull the inbox placement results for seed test RESULT_ID_HERE and summarize
where my message landed (inbox, spam, or missing) by provider.
```

#### Preview an Email (Inspect)

```
Get the email preview results for test TEST_ID_HERE and tell me if the email
renders correctly across clients.
```

## Development

### Run from source

The server is written in TypeScript. Clone, install, build, and test:

```bash
git clone https://github.com/mailgun/mailgun-mcp-server.git
cd mailgun-mcp-server
npm install
npm run build
npm test
```

`npm run build` compiles `src/` to `dist/` and copies the bundled OpenAPI spec. Point your MCP client at the built entry instead of `npx` (use an absolute path):

```json
{
  "mcpServers": {
    "mailgun": {
      "command": "node",
      "args": ["/absolute/path/to/mailgun-mcp-server/dist/mailgun-mcp.js"],
      "env": {
        "MAILGUN_API_KEY": "YOUR-mailgun-api-key"
      }
    }
  }
}
```

### Live testing while you edit

MCP servers are long-lived stdio processes that don't hot-reload, so the loop is: rebuild on save, then reconnect the client to pick up changes.

1. Run `npm run build` once so `dist/openapi.yaml` is in place.
2. Keep the TypeScript compiler running to rebuild `dist/` on every save:

   ```bash
   npx tsc --watch
   ```

3. Point a separate MCP client (or MCP Inspector, below) at `dist/mailgun-mcp.js`. After a change, restart the MCP client session to load the new build.

### Testing with MCP Inspector

The [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) lets you exercise tools without a full client. Build first, then launch it against the built server:

```bash
npm run build
MAILGUN_API_KEY=YOUR-mailgun-api-key npx @modelcontextprotocol/inspector node dist/mailgun-mcp.js
```

Open the Inspector UI, click **Connect**, then use **List Tools** to verify the server is working. To test a filtered toolset, append flags after the server path:

```bash
MAILGUN_API_KEY=YOUR-mailgun-api-key npx @modelcontextprotocol/inspector node dist/mailgun-mcp.js --tags validate,inspect
```

To exercise the HTTP transport instead, start the server yourself and connect the Inspector to the URL it prints — set the transport to **Streamable HTTP** in the Inspector's sidebar:

```bash
MAILGUN_API_KEY=YOUR-mailgun-api-key node dist/mailgun-mcp.js --transport http --port 3000
npx @modelcontextprotocol/inspector
```

### Pre-commit hooks

`npm install` installs a git pre-commit hook (via husky) that runs `oxlint --fix` and `oxfmt` on staged TypeScript/JavaScript files and runs `npm run check:versions`. Fixable issues are auto-fixed and re-staged; commits that introduce unfixable lint errors or version-sync mismatches are rejected. If you already had a local clone before this change, run `npm install` once to install the hook.

### Note on adding [endpoints](https://github.com/mailgun/mailgun-mcp-server/blob/main/src/endpoints.ts)
When adding a new endpoint if you use a plain string for it's definition it will default to being tagged with the  `send` product type in the `_meta` field.  If you would like to tag it as a different product use the object version of the `EndpointEntry` type.

## Security Considerations

### API key isolation

Your Mailgun API key is passed as an environment variable and is never exposed to the AI model itself — it is only used by the MCP server process to authenticate requests. The server does not log API keys, request parameters, or response data.

### Local execution

The server runs on your own machine or infrastructure. All communication with the Mailgun API is over HTTPS with TLS certificate validation enforced. No data is sent to third-party services beyond the Mailgun API.

### Exposing the HTTP transport

With the default stdio transport, only the process that spawned the server can talk to it. The HTTP transport removes that boundary, so treat the endpoint as a credential: it grants everything your Mailgun API key can do, and MCP defines no authentication of its own.

The defaults keep the blast radius small, and each can be widened deliberately:

- **Loopback bind.** The server binds `127.0.0.1`, so it is unreachable from other hosts. `--host 0.0.0.0` changes that.
- **DNS-rebinding protection.** Requests whose `Host` header is not a loopback alias for the listening port are rejected. This stops a page in your browser from resolving its own hostname to `127.0.0.1` and driving your server. Binding a non-loopback interface requires naming the hostnames clients will use via `--allowed-hosts` (for example `--allowed-hosts mcp.internal:3000`); the server warns at startup if you bind a routable interface without one, because it cannot guess a safe allowlist.
- **Bearer token.** Set `MAILGUN_MCP_AUTH_TOKEN` and every request must carry `Authorization: Bearer <token>`, compared in constant time. It is env-only so the secret never appears in `ps` output. The server warns at startup when the HTTP transport runs without a token.
- **No CORS headers.** Browser-based clients are not supported; front the server with a proxy if you need them.

Requests are capped at 4 MB. For anything beyond a trusted network, terminate TLS and enforce authentication in a reverse proxy in front of the server — the built-in bearer check is a guard rail, not an authorization system.

### API key permissions

Use a dedicated Mailgun API key with permissions scoped to only the operations you need. The server exposes read and update operations but does not expose any delete operations, which limits the blast radius of unintended actions.

### Rate limiting

The server does not implement client-side rate limiting. Each tool call from the AI translates directly into a Mailgun API request. The server relies on Mailgun's server-side rate limits to prevent abuse — requests that exceed those limits will return an error to the AI assistant.

### Prompt injection

As with any MCP server, a crafted or adversarial prompt could trick the AI assistant into calling operations you did not intend — for example, modifying tracking settings or reading mailing list members. Review your AI assistant's tool-call confirmations before approving actions, especially in untrusted prompt contexts.

### Webhook URLs

Webhook create and update operations accept arbitrary URLs provided through the AI assistant. The MCP server passes these URLs to the Mailgun API without additional validation. Mailgun is responsible for validating webhook destinations. Ensure your AI assistant does not set webhook URLs to unintended internal or sensitive addresses.

### Input validation

All tool parameters are validated against the Mailgun OpenAPI specification using Zod schemas. However, validation depends on the accuracy of the OpenAPI spec, and some edge-case parameters may fall back to permissive validation. The Mailgun API performs its own server-side validation as an additional layer of protection.

## Debugging

The MCP server communicates over stdio by default, or Streamable HTTP with `--transport http`. Diagnostics go to stderr in both cases, so they never corrupt the stdio protocol stream. Refer to the [MCP Debugging Guide](https://modelcontextprotocol.io/docs/tools/debugging) for troubleshooting.

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

## Contributing

We welcome contributions! Please feel free to submit a [Pull Request](https://github.com/mailgun/mailgun-mcp-server/pulls) or open an [Issue](https://github.com/mailgun/mailgun-mcp-server/issues).
