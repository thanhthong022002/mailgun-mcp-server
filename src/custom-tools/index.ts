import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ActiveTags, KNOWN_TAGS, shouldRegister, type Tag } from "../tags.js";
import { register as registerGetMetricsSummary } from "./get-metrics-summary.js";
import { register as registerListAccounts } from "./list-accounts.js";

interface CustomToolManifestEntry {
  tags: readonly Tag[];
  register: (server: McpServer, tags: readonly Tag[]) => void;
}

const customTools: readonly CustomToolManifestEntry[] = [
  { tags: ["send"], register: registerGetMetricsSummary },
  // Account discovery is a prerequisite for every product, so it registers
  // under all tags rather than just `send`.
  { tags: KNOWN_TAGS, register: registerListAccounts },
];

export function registerCustomTools(server: McpServer, activeTags: ActiveTags = "all"): void {
  for (const { tags, register } of customTools) {
    if (!shouldRegister(activeTags, tags)) continue;
    register(server, tags);
  }
}
