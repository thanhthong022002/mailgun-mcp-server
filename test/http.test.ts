import http from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  defaultAllowedHosts,
  isAuthorized,
  isLoopbackBind,
  startHttpServer,
  type HttpServerHandle,
  type StartHttpServerOptions,
} from "../src/http.js";
import { DEFAULT_HTTP_ENDPOINT } from "../src/cli.js";

const PROTOCOL_VERSION = "2025-06-18";
const ACCEPT_BOTH = "application/json, text/event-stream";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// Hand-rolled client rather than fetch(): the DNS-rebinding tests need to set a
// Host header, which fetch() forbids.
function request(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<RawResponse> {
  const { method = "POST", path = DEFAULT_HTTP_ENDPOINT, headers = {}, body } = options;
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          Accept: ACCEPT_BOTH,
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// A POST that carries JSON-RPC requests comes back as an SSE stream that the
// server closes once every response is written.
function parseSse(body: string): Record<string, unknown> {
  const line = body.split("\n").find((candidate) => candidate.startsWith("data:"));
  if (line === undefined) throw new Error(`No SSE data frame in response: ${body}`);
  return JSON.parse(line.slice("data:".length).trim());
}

function jsonRpcBody(body: string): Record<string, unknown> {
  return body.includes("data:") ? parseSse(body) : (JSON.parse(body) as Record<string, unknown>);
}

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
};

function createStubServer(): McpServer {
  const server = new McpServer({ name: "mailgun-test", version: "1.0.0" });
  server.registerTool(
    "ping_tool",
    { description: "Test tool", inputSchema: { value: z.string() } },
    ({ value }) => ({ content: [{ type: "text" as const, text: `pong:${value}` }] }),
  );
  return server;
}

let handle: HttpServerHandle | undefined;

async function start(overrides: Partial<StartHttpServerOptions> = {}): Promise<HttpServerHandle> {
  handle = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    endpoint: DEFAULT_HTTP_ENDPOINT,
    allowedHosts: [],
    authToken: undefined,
    createServer: createStubServer,
    ...overrides,
  });
  return handle;
}

async function initializeSession(port: number, headers: Record<string, string> = {}) {
  const res = await request(port, { body: initializeRequest, headers });
  const sessionId = res.headers["mcp-session-id"];
  return { res, sessionId: typeof sessionId === "string" ? sessionId : undefined };
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("startHttpServer() — session lifecycle", () => {
  test("initialize returns a session id and the server info", async () => {
    const server = await start();
    const { res, sessionId } = await initializeSession(server.port);

    expect(res.status).toBe(200);
    expect(sessionId).toBeTypeOf("string");
    const message = jsonRpcBody(res.body);
    expect(message.id).toBe(1);
    expect((message.result as Record<string, unknown>).protocolVersion).toBeTypeOf("string");
    expect(server.sessionCount()).toBe(1);
  });

  test("a session id from initialize can list tools", async () => {
    const server = await start();
    const { sessionId } = await initializeSession(server.port);

    const res = await request(server.port, {
      headers: { "mcp-session-id": sessionId!, "mcp-protocol-version": PROTOCOL_VERSION },
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });

    expect(res.status).toBe(200);
    const result = jsonRpcBody(res.body).result as { tools: { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toEqual(["ping_tool"]);
  });

  test("a registered tool is callable over HTTP", async () => {
    const server = await start();
    const { sessionId } = await initializeSession(server.port);

    const res = await request(server.port, {
      headers: { "mcp-session-id": sessionId!, "mcp-protocol-version": PROTOCOL_VERSION },
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ping_tool", arguments: { value: "hi" } },
      },
    });

    const result = jsonRpcBody(res.body).result as { content: { text: string }[] };
    expect(result.content[0].text).toBe("pong:hi");
  });

  test("DELETE terminates the session and later requests are rejected", async () => {
    const server = await start();
    const { sessionId } = await initializeSession(server.port);

    const deleted = await request(server.port, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(deleted.status).toBeLessThan(300);
    expect(server.sessionCount()).toBe(0);

    const after = await request(server.port, {
      headers: { "mcp-session-id": sessionId! },
      body: { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
    });
    expect(after.status).toBe(404);
  });

  test("each initialize creates an independent session", async () => {
    const server = await start();
    const first = await initializeSession(server.port);
    const second = await initializeSession(server.port);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(server.sessionCount()).toBe(2);
  });
});

describe("startHttpServer() — request validation", () => {
  test("a non-initialize POST without a session id is a 400", async () => {
    const server = await start();
    const res = await request(server.port, {
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.message).toMatch(/session ID/i);
  });

  test("an unknown session id is a 404", async () => {
    const server = await start();
    const res = await request(server.port, {
      headers: { "mcp-session-id": "does-not-exist" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(res.status).toBe(404);
  });

  test("GET without a session id is a 400", async () => {
    const server = await start();
    const res = await request(server.port, { method: "GET" });
    expect(res.status).toBe(400);
  });

  test("malformed JSON is a parse error", async () => {
    const server = await start();
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          method: "POST",
          path: DEFAULT_HTTP_ENDPOINT,
          headers: { Accept: ACCEPT_BOTH, "Content-Type": "application/json" },
        },
        (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            raw += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: raw }),
          );
        },
      );
      req.on("error", reject);
      req.end("{ not json");
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32700);
  });

  test("an unknown path is a 404", async () => {
    const server = await start();
    const res = await request(server.port, { path: "/nope", body: initializeRequest });
    expect(res.status).toBe(404);
  });

  test("the endpoint is configurable", async () => {
    const server = await start({ endpoint: "/mailgun/mcp" });
    const res = await request(server.port, { path: "/mailgun/mcp", body: initializeRequest });
    expect(res.status).toBe(200);
  });

  test("an unsupported method is a 405", async () => {
    const server = await start();
    const res = await request(server.port, { method: "PUT", body: initializeRequest });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, POST, DELETE");
  });
});

describe("startHttpServer() — bearer auth", () => {
  test("requests without the token are rejected", async () => {
    const server = await start({ authToken: "s3cret" });
    const res = await request(server.port, { body: initializeRequest });

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
    expect(server.sessionCount()).toBe(0);
  });

  test("a wrong token is rejected", async () => {
    const server = await start({ authToken: "s3cret" });
    const res = await request(server.port, {
      headers: { Authorization: "Bearer wrong-value" },
      body: initializeRequest,
    });
    expect(res.status).toBe(401);
  });

  test("the right token is accepted", async () => {
    const server = await start({ authToken: "s3cret" });
    const { res, sessionId } = await initializeSession(server.port, {
      Authorization: "Bearer s3cret",
    });

    expect(res.status).toBe(200);
    expect(sessionId).toBeTypeOf("string");
  });
});

describe("startHttpServer() — DNS rebinding protection", () => {
  test("a foreign Host header is rejected on a loopback bind", async () => {
    const server = await start();
    const res = await request(server.port, {
      headers: { Host: "evil.example.com" },
      body: initializeRequest,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(server.sessionCount()).toBe(0);
  });

  test("an explicit allowlist replaces the loopback defaults", async () => {
    const server = await start({ allowedHosts: ["mcp.internal:8080"] });
    const allowed = await request(server.port, {
      headers: { Host: "mcp.internal:8080" },
      body: initializeRequest,
    });
    expect(allowed.status).toBe(200);

    const rejected = await request(server.port, {
      headers: { Host: "evil.example.com" },
      body: initializeRequest,
    });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
  });
});

describe("isAuthorized()", () => {
  test("allows everything when no token is configured", () => {
    expect(isAuthorized(undefined, undefined)).toBe(true);
    expect(isAuthorized("Bearer anything", undefined)).toBe(true);
  });

  test("requires a matching bearer token", () => {
    expect(isAuthorized("Bearer abc", "abc")).toBe(true);
    expect(isAuthorized("bearer abc", "abc")).toBe(true);
    expect(isAuthorized("Bearer abcd", "abc")).toBe(false);
    expect(isAuthorized("Basic abc", "abc")).toBe(false);
    expect(isAuthorized(undefined, "abc")).toBe(false);
  });
});

describe("host helpers", () => {
  test("loopback binds are recognised", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "0.0.0.0", " LOCALHOST "]) {
      expect(isLoopbackBind(host)).toBe(true);
    }
    expect(isLoopbackBind("10.0.0.5")).toBe(false);
  });

  test("default allowlist names the port on every loopback alias", () => {
    expect(defaultAllowedHosts(3000)).toEqual(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]);
  });
});
