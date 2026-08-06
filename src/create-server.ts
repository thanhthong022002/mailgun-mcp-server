import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenApiSpec } from "./types.js";
import type { ActiveTags } from "./tags.js";
import { generateToolsFromOpenApi } from "./tools.js";
import { registerCustomTools } from "./custom-tools/index.js";

export const SERVER_NAME = "mailgun";
export const SERVER_VERSION = "1.0.0";

// Builds a fully registered server instance. Each MCP session needs its own,
// because a server can only be connected to one transport at a time: stdio uses
// a single instance for the process lifetime, HTTP creates one per session.
export function createMcpServer(openApiSpec: OpenApiSpec, activeTags: ActiveTags): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  generateToolsFromOpenApi(openApiSpec, server, activeTags);
  registerCustomTools(server, activeTags);
  return server;
}
