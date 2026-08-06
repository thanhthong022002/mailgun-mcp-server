import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpOptions } from "./cli.js";

const SESSION_HEADER = "mcp-session-id";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// JSON-RPC error codes. -32000 is the server-defined code the MCP spec uses for
// transport-level refusals (missing/expired session).
const JsonRpcError = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  SERVER_ERROR: -32000,
} as const;

const LOOPBACK_BINDS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0.0.0.0",
  "::",
]);

export interface StartHttpServerOptions extends HttpOptions {
  // Called once per MCP session. Returns a server instance dedicated to that session.
  createServer: () => McpServer;
}

export interface HttpServerHandle {
  port: number;
  url: string;
  sessionCount: () => number;
  close: () => Promise<void>;
}

class PayloadTooLargeError extends Error {}

// The Host values accepted when DNS-rebinding protection is on. An explicit
// allowlist always wins; otherwise we derive the loopback aliases for the port,
// which covers the common "server on this machine" case.
export function defaultAllowedHosts(port: number): string[] {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_BINDS.has(host.trim().toLowerCase());
}

function sendJsonRpcError(
  res: http.ServerResponse,
  statusCode: number,
  code: number,
  message: string,
  headers: http.OutgoingHttpHeaders = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(statusCode, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Constant-time bearer check. Returns true when no token is configured.
export function isAuthorized(
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  if (!token) return true;
  if (typeof authorization !== "string") return false;
  const prefix = "bearer ";
  if (!authorization.toLowerCase().startsWith(prefix)) return false;
  const provided = Buffer.from(authorization.slice(prefix.length).trim(), "utf8");
  const expected = Buffer.from(token, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function getSessionId(req: http.IncomingMessage): string | undefined {
  const value = req.headers[SESSION_HEADER];
  const sessionId = Array.isArray(value) ? value[0] : value;
  return sessionId === undefined || sessionId === "" ? undefined : sessionId;
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<HttpServerHandle> {
  const { host, port, endpoint, allowedHosts, authToken, createServer } = options;

  interface Session {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
  }
  const sessions = new Map<string, Session>();

  // Resolved after listen(), because port 0 means "pick a free one" and the
  // Host allowlist has to name the real port.
  let hostAllowlist: string[] = [];
  let dnsRebindingProtection = false;

  async function createSession(): Promise<StreamableHTTPServerTransport> {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: dnsRebindingProtection,
      allowedHosts: hostAllowlist,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server });
      },
    });
    // McpServer.close() closes its transport, and the SDK chains this handler
    // onto the transport's own onclose — so without the guard, closing either
    // side recurses until the stack blows.
    let teardownStarted = false;
    transport.onclose = () => {
      if (teardownStarted) return;
      teardownStarted = true;
      const sessionId = transport.sessionId;
      if (sessionId !== undefined) sessions.delete(sessionId);
      void server.close();
    };
    await server.connect(transport);
    return transport;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== endpoint) {
      sendJsonRpcError(res, 404, JsonRpcError.INVALID_REQUEST, `Not found: ${pathname}`);
      return;
    }

    if (!isAuthorized(req.headers.authorization, authToken)) {
      sendJsonRpcError(res, 401, JsonRpcError.SERVER_ERROR, "Unauthorized", {
        "WWW-Authenticate": 'Bearer realm="mailgun-mcp"',
      });
      return;
    }

    const sessionId = getSessionId(req);

    if (req.method === "GET" || req.method === "DELETE") {
      const session = sessionId === undefined ? undefined : sessions.get(sessionId);
      if (!session) {
        sendJsonRpcError(
          res,
          sessionId === undefined ? 400 : 404,
          JsonRpcError.SERVER_ERROR,
          sessionId === undefined
            ? "Bad Request: Mcp-Session-Id header is required"
            : "Session not found",
        );
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== "POST") {
      sendJsonRpcError(
        res,
        405,
        JsonRpcError.INVALID_REQUEST,
        `Method not allowed: ${req.method}`,
        {
          Allow: "GET, POST, DELETE",
        },
      );
      return;
    }

    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw === "" ? undefined : JSON.parse(raw);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJsonRpcError(res, 413, JsonRpcError.INVALID_REQUEST, "Request body too large");
      } else {
        sendJsonRpcError(res, 400, JsonRpcError.PARSE_ERROR, "Parse error: invalid JSON body");
      }
      return;
    }

    const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId !== undefined) {
      sendJsonRpcError(res, 404, JsonRpcError.SERVER_ERROR, "Session not found");
      return;
    }
    if (!isInitializeRequest(body)) {
      sendJsonRpcError(
        res,
        400,
        JsonRpcError.SERVER_ERROR,
        "Bad Request: no valid session ID provided. Send an initialize request first.",
      );
      return;
    }

    const transport = await createSession();
    await transport.handleRequest(req, res, body);
  }

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(`Error handling ${req.method} ${req.url}: ${(error as Error).message}`);
      sendJsonRpcError(res, 500, JsonRpcError.SERVER_ERROR, "Internal server error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", onError);
      resolve();
    });
  });

  const actualPort = (httpServer.address() as AddressInfo).port;
  hostAllowlist =
    allowedHosts.length > 0
      ? allowedHosts
      : isLoopbackBind(host)
        ? defaultAllowedHosts(actualPort)
        : [];
  dnsRebindingProtection = hostAllowlist.length > 0;

  return {
    port: actualPort,
    url: `http://${host}:${actualPort}${endpoint}`,
    sessionCount: () => sessions.size,
    close: async () => {
      // Snapshot first: closing a transport removes its own map entry.
      const open = Array.from(sessions.values());
      sessions.clear();
      for (const { transport } of open) {
        await transport.close();
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        // Keep-alive sockets would otherwise hold the server open.
        httpServer.closeAllConnections();
      });
    },
  };
}
