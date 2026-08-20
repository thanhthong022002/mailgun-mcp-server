import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeMailgunRequest, MailgunApiError } from "../api.js";
import { getActiveAccountsConfig, type MailgunAccount } from "../accounts.js";
import {
  type DomainListing,
  type DomainSummary,
  getCachedDomains,
  invalidateDomains,
  setCachedDomains,
} from "../domain-cache.js";
import { META_TAGS_KEY, type Tag } from "../tags.js";

// Mailgun caps /v4/domains at 1000 per page; one page is far more than any
// realistic workspace, and `truncated` reports the rare overflow.
const DOMAIN_PAGE_LIMIT = 1000;

interface DomainItem {
  name?: string;
  state?: string;
  type?: string;
  is_disabled?: boolean;
}

interface DomainsResponse {
  items?: DomainItem[];
  total_count?: number;
}

export type { DomainSummary };

export interface AccountSummary {
  account: string;
  region: string;
  description?: string;
  is_default: boolean;
  domains?: DomainSummary[];
  domain_count?: number;
  truncated?: boolean;
  // Present when the domain list came from cache rather than a live lookup.
  domains_cached_at?: string;
  // Set instead of `domains` when the domain lookup failed for this account,
  // so one bad key does not hide the accounts that do work.
  error?: string;
}

export interface ListAccountsOutput {
  accounts: AccountSummary[];
  default_account: string | null;
  account_required: boolean;
}

export function summarizeDomains(response: DomainsResponse): DomainListing {
  const items = Array.isArray(response.items) ? response.items : [];
  const domains: DomainSummary[] = [];

  for (const item of items) {
    if (typeof item?.name !== "string" || item.name === "") continue;
    const summary: DomainSummary = { name: item.name };
    if (typeof item.state === "string") summary.state = item.state;
    if (typeof item.type === "string") summary.type = item.type;
    if (item.is_disabled === true) summary.disabled = true;
    domains.push(summary);
  }

  const total = typeof response.total_count === "number" ? response.total_count : domains.length;
  return { domains, domain_count: total, truncated: total > domains.length };
}

function describeError(error: unknown): string {
  if (error instanceof MailgunApiError) {
    return `HTTP ${error.statusCode}: ${error.apiMessage ?? error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function summarizeAccount(
  account: MailgunAccount,
  isDefault: boolean,
  includeDomains: boolean,
  refresh: boolean,
): Promise<AccountSummary> {
  const summary: AccountSummary = {
    account: account.name,
    region: account.region,
    is_default: isDefault,
  };
  if (account.description !== undefined) summary.description = account.description;
  if (!includeDomains) return summary;

  if (refresh) {
    invalidateDomains(account.name);
  } else {
    const cached = getCachedDomains(account.name);
    if (cached !== undefined) {
      summary.domains = cached.domains;
      summary.domain_count = cached.domain_count;
      if (cached.truncated) summary.truncated = true;
      summary.domains_cached_at = new Date(cached.fetchedAt).toISOString();
      return summary;
    }
  }

  try {
    const response = (await makeMailgunRequest(
      "GET",
      `/v4/domains?limit=${DOMAIN_PAGE_LIMIT}`,
      null,
      "application/x-www-form-urlencoded",
      account.name,
    )) as DomainsResponse;

    const listing = summarizeDomains(response);
    setCachedDomains(account.name, listing);
    summary.domains = listing.domains;
    summary.domain_count = listing.domain_count;
    if (listing.truncated) summary.truncated = true;
  } catch (error) {
    summary.error = describeError(error);
  }

  return summary;
}

export function register(server: McpServer, tags: readonly Tag[] = []): void {
  server.registerTool(
    "list_mailgun_accounts",
    {
      description:
        "List the Mailgun accounts this server is configured for and the sending domains each one manages. " +
        "Every other Mailgun tool takes an 'account' parameter that must be one of the names returned here. " +
        "Call this first whenever a request names a domain but not an account, or when you do not yet know " +
        "which accounts exist — do not guess an account name. Domain lists are cached for 24 hours; pass " +
        "refresh: true if a domain was just added in Mailgun and is missing from the listing.",
      inputSchema: {
        include_domains: z
          .boolean()
          .optional()
          .describe(
            "Look up the sending domains owned by each account (one API call per account). Defaults to true.",
          ),
        account: z
          .string()
          .optional()
          .describe("Restrict the listing to a single configured account by name."),
        refresh: z
          .boolean()
          .optional()
          .describe(
            "Bypass the cached domain lists and re-read them from the Mailgun API. Defaults to false.",
          ),
      },
      _meta: { [META_TAGS_KEY]: [...tags] },
    },
    async (params) => {
      const includeDomains = params.include_domains !== false;

      let config;
      try {
        config = getActiveAccountsConfig();
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${describeError(error)}` }],
        };
      }

      const all = [...config.accounts.values()];
      const requested = typeof params.account === "string" ? params.account.trim() : "";
      const selected = requested === "" ? all : all.filter((a) => a.name === requested);

      if (selected.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Error: unknown Mailgun account "${requested}". ` +
                `Configured accounts: ${all.map((a) => a.name).join(", ")}.`,
            },
          ],
        };
      }

      const accounts = await Promise.all(
        selected.map((account) =>
          summarizeAccount(
            account,
            account.name === config.defaultAccount,
            includeDomains,
            params.refresh === true,
          ),
        ),
      );

      const output: ListAccountsOutput = {
        accounts,
        default_account: config.defaultAccount ?? null,
        account_required: config.defaultAccount === undefined,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    },
  );
}
