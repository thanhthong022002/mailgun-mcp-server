import { z } from "zod";
import type {
  OpenApiOperation,
  OpenApiParameter,
  OpenApiRequestBody,
  OpenApiSchema,
  OpenApiSpec,
  ParamsSchemaResult,
} from "./types.js";
import { openapiToZod, resolveReference } from "./openapi.js";
import { toOptional } from "./zod-utils.js";
import { tryGetActiveAccountsConfig } from "./accounts.js";

export function sanitizePropertyKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

export function sanitizeToolId(operationId: string): string {
  return operationId
    .replace(/[^\w-]/g, "-")
    .replace(/_name(?=-|$)/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 53);
}

export function buildParamsSchema(
  operation: OpenApiOperation,
  openApiSpec: OpenApiSpec,
): ParamsSchemaResult {
  const paramsSchema: Record<string, z.ZodType> = {};
  const keyMapping: Record<string, string> = {};

  const pathParams = operation.parameters?.filter((p) => p.in === "path") || [];
  processParameters(pathParams, paramsSchema, openApiSpec, keyMapping);

  const queryParams = operation.parameters?.filter((p) => p.in === "query") || [];
  processParameters(queryParams, paramsSchema, openApiSpec, keyMapping);

  if (operation.requestBody) {
    processRequestBody(operation.requestBody, paramsSchema, openApiSpec, keyMapping);
  }

  return { paramsSchema, keyMapping };
}

export function processParameters(
  parameters: OpenApiParameter[],
  paramsSchema: Record<string, z.ZodType>,
  openApiSpec: OpenApiSpec,
  keyMapping: Record<string, string> = {},
): void {
  for (const param of parameters) {
    const sanitizedKey = sanitizePropertyKey(param.name);
    if (sanitizedKey !== param.name) {
      keyMapping[sanitizedKey] = param.name;
    }
    const schema =
      param.description && !param.schema?.description
        ? { ...param.schema, description: param.description }
        : param.schema;
    const zodParam = openapiToZod(schema, openApiSpec);
    paramsSchema[sanitizedKey] = param.required ? zodParam : toOptional(zodParam);
  }
}

export function processRequestBody(
  requestBody: OpenApiRequestBody,
  paramsSchema: Record<string, z.ZodType>,
  openApiSpec: OpenApiSpec,
  keyMapping: Record<string, string> = {},
): void {
  if (!requestBody.content) return;

  const contentTypes = [
    "application/json",
    "multipart/form-data",
    "application/x-www-form-urlencoded",
  ] as const;

  for (const contentType of contentTypes) {
    if (!requestBody.content[contentType]) continue;

    let bodySchema: OpenApiSchema = requestBody.content[contentType].schema;

    if (bodySchema.$ref) {
      bodySchema = resolveReference(bodySchema.$ref, openApiSpec);
    }

    if (bodySchema?.properties) {
      for (const [prop, propSchema] of Object.entries(bodySchema.properties)) {
        const sanitizedKey = sanitizePropertyKey(prop);
        if (sanitizedKey !== prop) {
          keyMapping[sanitizedKey] = prop;
        }

        const zodProp = openapiToZod(propSchema, openApiSpec);
        paramsSchema[sanitizedKey] = bodySchema.required?.includes(prop)
          ? zodProp
          : toOptional(zodProp);
      }
    }

    break;
  }
}

// --- Account selection ---

export const ACCOUNT_PARAM = "account";
// Used when an operation already defines a parameter called `account`.
export const ACCOUNT_PARAM_FALLBACK = "mailgun_account";

// Describes the configured accounts as an enum so the model can only pick a real
// one. Falls back to a plain string when no configuration has loaded yet, which
// keeps schema construction independent of startup validation.
export function accountParamSchema(): z.ZodType {
  const config = tryGetActiveAccountsConfig();
  const names = config ? [...config.accounts.keys()] : [];

  if (names.length === 0) {
    return toOptional(z.string().describe("Mailgun account to act on."));
  }

  const suffix =
    config?.defaultAccount !== undefined
      ? ` Defaults to "${config.defaultAccount}" when omitted.`
      : " This server has no default account, so it must be set explicitly.";
  const described = z
    .enum(names as [string, ...string[]])
    .describe(
      `Mailgun account to act on. Each account is a separate Mailgun API key owning its own domains. ` +
        `Configured accounts: ${names.join(", ")}.${suffix} ` +
        `Use list_mailgun_accounts to see which domains each account manages.`,
    );

  // Required exactly when there is nothing sensible to fall back to.
  return config?.defaultAccount === undefined ? described : toOptional(described);
}

// Adds the account selector to a generated tool schema and reports the key it
// landed on. Returns undefined when both candidate names are already taken, in
// which case the tool silently uses the default account.
export function addAccountParam(paramsSchema: Record<string, z.ZodType>): string | undefined {
  const key =
    paramsSchema[ACCOUNT_PARAM] === undefined
      ? ACCOUNT_PARAM
      : paramsSchema[ACCOUNT_PARAM_FALLBACK] === undefined
        ? ACCOUNT_PARAM_FALLBACK
        : undefined;
  if (key === undefined) return undefined;

  paramsSchema[key] = accountParamSchema();
  return key;
}
