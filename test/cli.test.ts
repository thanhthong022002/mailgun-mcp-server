import { describe, test, expect } from "vitest";
import {
  DEFAULT_HTTP_ENDPOINT,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  formatHelp,
  formatInvalidTagsMessage,
  formatTagList,
  resolveActiveTags,
} from "../src/cli.js";
import { KNOWN_TAGS } from "../src/tags.js";

describe("resolveActiveTags()", () => {
  test('returns "all" when neither flag nor env is set', () => {
    const result = resolveActiveTags([], {});
    expect(result.activeTags).toBe("all");
    expect(result.showHelp).toBe(false);
    expect(result.listTags).toBe(false);
    expect(result.invalid).toEqual([]);
  });

  test("parses MAILGUN_MCP_TAGS env var when no CLI flag", () => {
    const result = resolveActiveTags([], { MAILGUN_MCP_TAGS: "send,validate" });
    expect(result.activeTags).toEqual(new Set(["send", "validate"]));
  });

  test("parses --tags CLI flag", () => {
    const result = resolveActiveTags(["--tags", "validate,inspect"], {});
    expect(result.activeTags).toEqual(new Set(["validate", "inspect"]));
  });

  test("supports --tags=value syntax", () => {
    const result = resolveActiveTags(["--tags=validate,inspect"], {});
    expect(result.activeTags).toEqual(new Set(["validate", "inspect"]));
  });

  test("CLI overrides env when both are set", () => {
    const result = resolveActiveTags(["--tags", "inspect"], {
      MAILGUN_MCP_TAGS: "send,validate",
    });
    expect(result.activeTags).toEqual(new Set(["inspect"]));
  });

  test("last --tags wins when specified twice", () => {
    const result = resolveActiveTags(["--tags", "send", "--tags", "validate,inspect"], {});
    expect(result.activeTags).toEqual(new Set(["validate", "inspect"]));
  });

  test("--help is reflected in result without exiting", () => {
    const result = resolveActiveTags(["--help"], {});
    expect(result.showHelp).toBe(true);
    expect(result.activeTags).toBe("all");
  });

  test("-h is treated as --help", () => {
    const result = resolveActiveTags(["-h"], {});
    expect(result.showHelp).toBe(true);
  });

  test("--list-tags is reflected in result", () => {
    const result = resolveActiveTags(["--list-tags"], {});
    expect(result.listTags).toBe(true);
    expect(result.activeTags).toBe("all");
  });

  test("unknown tags populate invalid and leave activeTags as default", () => {
    const result = resolveActiveTags(["--tags", "send,foo,bar"], {});
    expect(result.invalid).toEqual(["foo", "bar"]);
    expect(result.activeTags).toBe("all");
  });

  test("empty --tags value is treated as default (all)", () => {
    const result = resolveActiveTags(["--tags", ""], {
      MAILGUN_MCP_TAGS: "validate",
    });
    expect(result.activeTags).toBe("all");
  });

  test('--tags "," is treated as default (all), not a zero-tool filter', () => {
    const result = resolveActiveTags(["--tags", ","], {});
    expect(result.activeTags).toBe("all");
    expect(result.invalid).toEqual([]);
  });

  test('--tags " , , " is treated as default (all), not a zero-tool filter', () => {
    const result = resolveActiveTags(["--tags", " , , "], {});
    expect(result.activeTags).toBe("all");
    expect(result.invalid).toEqual([]);
  });

  test("MAILGUN_MCP_TAGS containing only separators is treated as default (all)", () => {
    const result = resolveActiveTags([], { MAILGUN_MCP_TAGS: " , , " });
    expect(result.activeTags).toBe("all");
    expect(result.invalid).toEqual([]);
  });

  test("ignores unrelated argv tokens", () => {
    const result = resolveActiveTags(["--unknown-flag", "value", "--tags", "send"], {});
    expect(result.activeTags).toEqual(new Set(["send"]));
  });
});

describe("transport selection", () => {
  test("defaults to stdio with loopback HTTP defaults", () => {
    const result = resolveActiveTags([], {});
    expect(result.transport).toBe("stdio");
    expect(result.errors).toEqual([]);
    expect(result.http).toEqual({
      host: DEFAULT_HTTP_HOST,
      port: DEFAULT_HTTP_PORT,
      endpoint: DEFAULT_HTTP_ENDPOINT,
      allowedHosts: [],
      authToken: undefined,
    });
  });

  test("--transport http selects the HTTP transport", () => {
    expect(resolveActiveTags(["--transport", "http"], {}).transport).toBe("http");
    expect(resolveActiveTags(["--transport=http"], {}).transport).toBe("http");
  });

  test("MAILGUN_MCP_TRANSPORT selects the transport when no flag is given", () => {
    expect(resolveActiveTags([], { MAILGUN_MCP_TRANSPORT: "http" }).transport).toBe("http");
  });

  test("CLI transport overrides the env var", () => {
    const result = resolveActiveTags(["--transport", "stdio"], { MAILGUN_MCP_TRANSPORT: "http" });
    expect(result.transport).toBe("stdio");
  });

  test("transport value is case-insensitive", () => {
    expect(resolveActiveTags(["--transport", "HTTP"], {}).transport).toBe("http");
  });

  test("an unknown transport is a fatal error", () => {
    const result = resolveActiveTags(["--transport", "grpc"], {});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("grpc");
  });

  test("sse gets a dedicated deprecation error", () => {
    const result = resolveActiveTags(["--transport", "sse"], {});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/deprecated/i);
    expect(result.errors[0]).toContain("--transport http");
  });

  test("an empty transport value falls back to stdio", () => {
    expect(resolveActiveTags(["--transport", ""], {}).transport).toBe("stdio");
    expect(resolveActiveTags([], { MAILGUN_MCP_TRANSPORT: "  " }).transport).toBe("stdio");
  });
});

describe("HTTP options", () => {
  test("host, port and endpoint come from flags", () => {
    const result = resolveActiveTags(
      ["--host", "0.0.0.0", "--port", "8080", "--endpoint", "/mailgun"],
      {},
    );
    expect(result.http.host).toBe("0.0.0.0");
    expect(result.http.port).toBe(8080);
    expect(result.http.endpoint).toBe("/mailgun");
    expect(result.errors).toEqual([]);
  });

  test("host, port and endpoint come from env vars", () => {
    const result = resolveActiveTags([], {
      MAILGUN_MCP_HOST: "0.0.0.0",
      MAILGUN_MCP_PORT: "8080",
      MAILGUN_MCP_ENDPOINT: "/mailgun",
    });
    expect(result.http.host).toBe("0.0.0.0");
    expect(result.http.port).toBe(8080);
    expect(result.http.endpoint).toBe("/mailgun");
  });

  test("port 0 is allowed and means any free port", () => {
    const result = resolveActiveTags(["--port", "0"], {});
    expect(result.http.port).toBe(0);
    expect(result.errors).toEqual([]);
  });

  test.each(["abc", "-1", "70000", "8080.5"])("rejects invalid port %s", (port) => {
    const result = resolveActiveTags(["--port", port], {});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(port);
  });

  test("endpoint gains a leading slash and loses trailing slashes", () => {
    expect(resolveActiveTags(["--endpoint", "mcp"], {}).http.endpoint).toBe("/mcp");
    expect(resolveActiveTags(["--endpoint", "/mcp/"], {}).http.endpoint).toBe("/mcp");
    expect(resolveActiveTags(["--endpoint", "/"], {}).http.endpoint).toBe("/");
    expect(resolveActiveTags(["--endpoint", "///"], {}).http.endpoint).toBe("/");
  });

  test("allowed hosts are split, trimmed, lowercased and deduped", () => {
    const result = resolveActiveTags(["--allowed-hosts", " MCP.internal:8080, a:1 ,, a:1 "], {});
    expect(result.http.allowedHosts).toEqual(["mcp.internal:8080", "a:1"]);
  });

  test("the auth token is read from the environment only", () => {
    expect(resolveActiveTags([], { MAILGUN_MCP_AUTH_TOKEN: " s3cret " }).http.authToken).toBe(
      "s3cret",
    );
    expect(resolveActiveTags([], { MAILGUN_MCP_AUTH_TOKEN: "" }).http.authToken).toBeUndefined();
    expect(resolveActiveTags(["--auth-token", "s3cret"], {}).http.authToken).toBeUndefined();
  });

  test("HTTP options coexist with tag filtering", () => {
    const result = resolveActiveTags(["--transport", "http", "--tags", "send,validate"], {});
    expect(result.transport).toBe("http");
    expect(result.activeTags).toEqual(new Set(["send", "validate"]));
  });
});

describe("formatHelp()", () => {
  test("includes every known tag in the help output", () => {
    const help = formatHelp();
    for (const tag of KNOWN_TAGS) {
      expect(help).toContain(tag);
    }
    expect(help).toMatch(/--tags/);
    expect(help).toMatch(/--list-tags/);
    expect(help).toMatch(/--help/);
  });

  test("documents the transport and HTTP options", () => {
    const help = formatHelp();
    for (const flag of ["--transport", "--host", "--port", "--endpoint", "--allowed-hosts"]) {
      expect(help).toContain(flag);
    }
    expect(help).toContain("MAILGUN_MCP_TRANSPORT");
    expect(help).toContain("MAILGUN_MCP_AUTH_TOKEN");
  });
});

describe("formatTagList()", () => {
  test("lists every known tag, one per line", () => {
    const lines = formatTagList().split("\n");
    expect(lines).toEqual([...KNOWN_TAGS]);
  });
});

describe("formatInvalidTagsMessage()", () => {
  test("lists offenders and the valid tag set", () => {
    const msg = formatInvalidTagsMessage(["foo", "bar"]);
    expect(msg).toContain("foo");
    expect(msg).toContain("bar");
    for (const tag of KNOWN_TAGS) {
      expect(msg).toContain(tag);
    }
  });

  test("uses singular form for a single invalid tag", () => {
    const msg = formatInvalidTagsMessage(["foo"]);
    expect(msg).toMatch(/Unknown tag:/);
  });

  test("uses plural form for multiple invalid tags", () => {
    const msg = formatInvalidTagsMessage(["foo", "bar"]);
    expect(msg).toMatch(/Unknown tags:/);
  });
});
