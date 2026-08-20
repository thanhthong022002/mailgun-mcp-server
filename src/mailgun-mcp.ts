#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { formatHelp, formatInvalidTagsMessage, formatTagList, resolveActiveTags } from "./cli.js";
import { OPENAPI_YAML } from "./config.js";
import { loadAccountsConfig, setActiveAccountsConfig, type AccountsConfig } from "./accounts.js";
import { createMcpServer } from "./create-server.js";
import { startHttpServer, isLoopbackBind, type HttpServerHandle } from "./http.js";
import { loadOpenApiSpec } from "./openapi.js";

export { createMcpServer };

export async function main(): Promise<void> {
  try {
    const cli = resolveActiveTags(process.argv.slice(2), process.env);

    if (cli.showHelp) {
      console.log(formatHelp());
      process.exit(0);
    }

    if (cli.listTags) {
      console.log(formatTagList());
      process.exit(0);
    }

    if (cli.invalid.length > 0) {
      console.error(formatInvalidTagsMessage(cli.invalid));
      process.exit(1);
    }

    if (cli.errors.length > 0) {
      for (const error of cli.errors) console.error(error);
      process.exit(1);
    }

    let accounts: AccountsConfig;
    try {
      accounts = loadAccountsConfig({ accountsFile: cli.accountsFile });
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
      return;
    }
    setActiveAccountsConfig(accounts);
    console.error(formatAccountsBanner(accounts));

    const openApiSpec = loadOpenApiSpec(OPENAPI_YAML);

    if (cli.transport === "http") {
      const handle = await startHttpServer({
        ...cli.http,
        createServer: () => createMcpServer(openApiSpec, cli.activeTags),
      });
      console.error(`Mailgun MCP Server listening on ${handle.url} (Streamable HTTP)`);
      if (!cli.http.authToken) {
        console.error(
          "Warning: no MAILGUN_MCP_AUTH_TOKEN set — anything that can reach this endpoint " +
            "can use your Mailgun API key.",
        );
      }
      if (cli.http.allowedHosts.length === 0 && !isLoopbackBind(cli.http.host)) {
        console.error(
          `Warning: DNS-rebinding protection is disabled because ${cli.http.host} is not a ` +
            "loopback interface and --allowed-hosts was not set.",
        );
      }
      installShutdownHandlers(handle);
      return;
    }

    const server = createMcpServer(openApiSpec, cli.activeTags);
    await server.connect(new StdioServerTransport());
    console.error("Mailgun MCP Server running on stdio");
  } catch (error) {
    console.error("Fatal error in main():", error);
    if (process.env.NODE_ENV !== "test") {
      process.exit(1);
    }
  }
}

export function formatAccountsBanner(accounts: AccountsConfig): string {
  const names = [...accounts.accounts.keys()];
  const plural = names.length === 1 ? "account" : "accounts";
  const suffix =
    accounts.defaultAccount === undefined
      ? " (no default — tool calls must name an account)"
      : ` (default: ${accounts.defaultAccount})`;
  return `Mailgun MCP Server: ${names.length} ${plural} from ${accounts.source}: ${names.join(", ")}${suffix}`;
}

function installShutdownHandlers(handle: HttpServerHandle): void {
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      handle
        .close()
        .catch((error: unknown) => {
          console.error(`Error during shutdown: ${(error as Error).message}`);
        })
        .finally(() => {
          process.exit(0);
        });
    });
  }
}

if (process.env.NODE_ENV !== "test") {
  main();
}
