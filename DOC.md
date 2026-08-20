# Mailgun MCP Server

Connect MCP-compatible clients (Claude Desktop, Claude Code, Cursor, and others) to a workflow-oriented Mailgun interface so agents can send email, diagnose deliverability issues, and take practical account actions.

## Features

- Send email and retrieve stored message content.
- Manage domains and verify DNS status.
- Configure tracking options and webhooks.
- Manage inbound routes, SMTP credentials, mailing lists, and templates.
- Query analytics, aggregate stats, suppressions, IPs, and account limits.
- Analyze bounce classification metrics.
- Manage several Mailgun accounts from a single server.

## Prerequisites

- Node.js 20.12 or newer.
- A Mailgun account and API key.
- An MCP-compatible client.

## Setup

Use the server with stdio and `npx`:

```json
{
  "mcpServers": {
    "mailgun": {
      "command": "npx",
      "args": ["-y", "@mailgun/mcp-server"],
      "env": {
        "MAILGUN_API_KEY": "YOUR_MAILGUN_API_KEY",
        "MAILGUN_API_REGION": "us"
      }
    }
  }
}
```

## Environment variables

One credential source is required:

- `MAILGUN_ACCOUNTS`: inline JSON describing one or more accounts, e.g.
  `{"accounts":{"acme":{"apiKey":"key-...","region":"us"}},"defaultAccount":"acme"}`.
- `MAILGUN_ACCOUNTS_FILE` (or `--accounts-file`): the same JSON, read from a file.
- `MAILGUN_API_KEY`: a single Mailgun API key, registered as the account `default`.
  Used only when neither of the above is set.

Optional:

- `MAILGUN_API_REGION`: `us` or `eu` (default `us`), applied to `MAILGUN_API_KEY`.

- `MAILGUN_DOMAIN_CACHE_TTL`: how long, in seconds, to cache each account's domain list
  (default `86400`, i.e. 24 hours). `0` disables caching.

Every tool takes an `account` parameter naming which configured account to act on. It is
required only when several accounts are configured without a `defaultAccount`. Use the
`list_mailgun_accounts` tool to see which domains each account manages; its results are
cached for 24 hours, and `refresh: true` re-reads them.

## Security notes

- The server runs locally.
- It communicates only with Mailgun HTTPS APIs.
- It does not read local files or databases for tool execution, beyond the optional accounts file read once at startup.
- API keys stay in the server process; the model only ever sees account names.

For deeper details, see `README.md` and `SECURITY.md`.
