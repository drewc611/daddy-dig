import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  handleChatRequest,
  sanitizeContextValue,
  normalizeClientContext,
  buildContextualSystemPrompt,
  parseModelAllowlist,
  parsePositiveInt,
  applySecurityHeaders,
  parseJsonBodyWithLimit,
  isChatMessage,
  checkRateLimit,
  MAX_CONTEXT_FIELD_LENGTH,
} from "./index";
import type { Env } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant named daddy. If asked who you are or what your name is, respond exactly: \"hi I’m your daddy. I’m here to help you as your daddy. How can daddy help you\". If asked again, respond exactly: \"I’m here to be a daddy and to help you.\" Provide concise and accurate responses. For time-sensitive questions, clearly state what date or time context you are using and be transparent if you do not have live web access.";

function createEnv(
  runImplementation: () => Promise<Response> | Response = () =>
    Promise.resolve(new Response("ok")),
  envVars: Partial<Env> = {},
) {
  const runMock = vi.fn(runImplementation);

  const env = {
    AI: {
      run: runMock,
    },
    ASSETS: {
      fetch: vi.fn(),
    },
    ...envVars,
  } as unknown as Env;

  return { env, runMock };
}

// Helper to create a mock request
function createRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("handleChatRequest", () => {
  // Reset rate limiter state before each test
  beforeEach(() => {
    // Note: In a real scenario, you'd want to expose a way to reset the rate limiter
    // or use dependency injection. For now, tests will have independent IPs.
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const request = new Request("https://example.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "invalid json",
    });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("returns 400 when messages are not an array of chat messages", async () => {
    const request = createRequest({ messages: { role: "user" } });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request: messages must be an array of chat messages",
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("normalizes messages and injects the system prompt when missing", async () => {
    const requestMessages = [{ role: "user" as const, content: "Hello" }];
    const request = createRequest({ messages: requestMessages });

    const runMock = vi.fn().mockResolvedValue(new Response("ok"));
    const env = {
      AI: { run: runMock },
      ASSETS: { fetch: vi.fn() },
    } as unknown as Env;

    const response = await handleChatRequest(request, env);

    expect(runMock).toHaveBeenCalledTimes(1);
    const [modelId, options] = runMock.mock.calls[0];

    expect(modelId).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(options.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(options.messages[1]).toEqual(requestMessages[0]);
    expect(options.messages).not.toBe(requestMessages);
    expect(await response.text()).toBe("ok");
  });

  it("adds client context to the system prompt when provided", async () => {
    const requestMessages = [{ role: "user" as const, content: "Hello" }];
    const request = createRequest({
      messages: requestMessages,
      clientContext: {
        currentTimeIso: "2025-01-01T12:00:00.000Z",
        timeZone: "America/New_York",
        locale: "en-US",
      },
    });

    const runMock = vi.fn().mockResolvedValue(new Response("ok"));
    const env = {
      AI: { run: runMock },
      ASSETS: { fetch: vi.fn() },
    } as unknown as Env;

    await handleChatRequest(request, env);

    const [, options] = runMock.mock.calls[0];

    expect(options.messages[0]).toEqual({
      role: "system",
      content:
        `${SYSTEM_PROMPT}\n\nContext:\n- Current date/time (from user device): 2025-01-01T12:00:00.000Z\n- User time zone: America/New_York\n- User locale: en-US`,
    });
  });

  it("returns 400 when message content exceeds maximum length", async () => {
    const longMessage = "a".repeat(10001);
    const request = createRequest({
      messages: [{ role: "user", content: longMessage }],
    });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Message too long: maximum 10000 characters allowed",
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("returns 400 when too many messages are sent", async () => {
    const messages = Array.from({ length: 101 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const request = createRequest({ messages });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Too many messages: maximum 100 messages allowed",
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("respects custom configuration from environment variables", async () => {
    const requestMessages = [{ role: "user" as const, content: "Hello" }];
    const request = createRequest({ messages: requestMessages });

    const runMock = vi.fn().mockResolvedValue(new Response("ok"));
    const env = {
      AI: { run: runMock },
      ASSETS: { fetch: vi.fn() },
      MODEL_ID: "@cf/custom/model",
      SYSTEM_PROMPT: "Custom prompt",
      MAX_TOKENS: "2048",
    } as unknown as Env;

    const response = await handleChatRequest(request, env);

    expect(runMock).toHaveBeenCalledTimes(1);
    const [modelId, options] = runMock.mock.calls[0];

    expect(modelId).toBe("@cf/custom/model");
    expect(options.messages[0]).toEqual({ role: "system", content: "Custom prompt" });
    expect(options.max_tokens).toBe(2048);
    expect(await response.text()).toBe("ok");
  });

  it("returns 429 when rate limit is exceeded", async () => {
    const requestMessages = [{ role: "user" as const, content: "Hello" }];
    const clientIp = "192.168.1.100";

    // Set a low rate limit for testing
    const env = {
      AI: { run: vi.fn().mockResolvedValue(new Response("ok")) },
      ASSETS: { fetch: vi.fn() },
      RATE_LIMIT_REQUESTS: "2",
      RATE_LIMIT_WINDOW_MS: "60000",
    } as unknown as Env;

    // First request should succeed
    const request1 = createRequest({ messages: requestMessages }, { "CF-Connecting-IP": clientIp });
    const response1 = await handleChatRequest(request1, env);
    expect(response1.status).toBe(200);

    // Second request should succeed
    const request2 = createRequest({ messages: requestMessages }, { "CF-Connecting-IP": clientIp });
    const response2 = await handleChatRequest(request2, env);
    expect(response2.status).toBe(200);

    // Third request should be rate limited
    const request3 = createRequest({ messages: requestMessages }, { "CF-Connecting-IP": clientIp });
    const response3 = await handleChatRequest(request3, env);
    expect(response3.status).toBe(429);
    expect(await response3.json()).toEqual({
      error: "Rate limit exceeded. Please try again later.",
    });
    expect(response3.headers.get("Retry-After")).toBe("60");
  });

  it("handles errors gracefully", async () => {
    const requestMessages = [{ role: "user" as const, content: "Hello" }];
    const request = createRequest({ messages: requestMessages });

    const runMock = vi.fn().mockRejectedValue(new Error("AI service error"));
    const env = {
      AI: { run: runMock },
      ASSETS: { fetch: vi.fn() },
    } as unknown as Env;

    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to process request",
    });
  });

  it("returns 415 when Content-Type is not application/json", async () => {
    const request = new Request("https://example.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: "Content-Type must be application/json",
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("returns 415 when Content-Type header is missing", async () => {
    const request = new Request("https://example.com/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: "Content-Type must be application/json",
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("returns 413 when Content-Length exceeds MAX_BODY_BYTES", async () => {
    const request = new Request("https://example.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "2000000",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(413);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain("Request body too large");
    expect(runMock).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid model selection", async () => {
    const requestMessages = [{ role: "user" as const, content: "Hello" }];
    const request = createRequest({
      messages: requestMessages,
      model: "@cf/invalid/model",
    });

    const env = {
      AI: { run: vi.fn().mockResolvedValue(new Response("ok")) },
      ASSETS: { fetch: vi.fn() },
      MODEL_ALLOWLIST: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    } as unknown as Env;

    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid model selection. Please choose a model from the allowed list.",
    });
  });

  it("accepts valid model from allowlist", async () => {
    const requestMessages = [{ role: "user" as const, content: "Hello" }];
    const request = createRequest({
      messages: requestMessages,
      model: "@cf/custom/model",
    });

    const runMock = vi.fn().mockResolvedValue(new Response("ok"));
    const env = {
      AI: { run: runMock },
      ASSETS: { fetch: vi.fn() },
      MODEL_ALLOWLIST: "@cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/custom/model",
    } as unknown as Env;

    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(200);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][0]).toBe("@cf/custom/model");
  });

  it("handles X-Forwarded-For header for rate limiting", async () => {
    const requestMessages = [{ role: "user" as const, content: "Hello" }];
    const clientIp = "203.0.113.195";

    const env = {
      AI: { run: vi.fn().mockResolvedValue(new Response("ok")) },
      ASSETS: { fetch: vi.fn() },
      RATE_LIMIT_REQUESTS: "1",
      RATE_LIMIT_WINDOW_MS: "60000",
    } as unknown as Env;

    // First request should succeed
    const request1 = createRequest(
      { messages: requestMessages },
      { "X-Forwarded-For": `${clientIp}, 10.0.0.1` },
    );
    const response1 = await handleChatRequest(request1, env);
    expect(response1.status).toBe(200);

    // Second request should be rate limited
    const request2 = createRequest(
      { messages: requestMessages },
      { "X-Forwarded-For": `${clientIp}, 10.0.0.2` },
    );
    const response2 = await handleChatRequest(request2, env);
    expect(response2.status).toBe(429);
  });

  it("validates message role is valid", async () => {
    const request = createRequest({
      messages: [{ role: "moderator", content: "Hello" }],
    });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request: messages must be an array of chat messages",
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("validates message has content field", async () => {
    const request = createRequest({
      messages: [{ role: "user" }],
    });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request: messages must be an array of chat messages",
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("validates message content is a string", async () => {
    const request = createRequest({
      messages: [{ role: "user", content: 123 }],
    });

    const { env, runMock } = createEnv();
    const response = await handleChatRequest(request, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid request: messages must be an array of chat messages",
    });
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe("sanitizeContextValue", () => {
  it("returns undefined for non-string values", () => {
    expect(sanitizeContextValue(123)).toBeUndefined();
    expect(sanitizeContextValue(null)).toBeUndefined();
    expect(sanitizeContextValue(undefined)).toBeUndefined();
    expect(sanitizeContextValue({})).toBeUndefined();
    expect(sanitizeContextValue([])).toBeUndefined();
  });

  it("returns undefined for empty strings", () => {
    expect(sanitizeContextValue("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only strings", () => {
    expect(sanitizeContextValue("   ")).toBeUndefined();
    expect(sanitizeContextValue("\n\t")).toBeUndefined();
  });

  it("trims whitespace from valid strings", () => {
    expect(sanitizeContextValue("  hello  ")).toBe("hello");
    expect(sanitizeContextValue("\n\tworld\t\n")).toBe("world");
  });

  it("truncates strings exceeding MAX_CONTEXT_FIELD_LENGTH", () => {
    const longString = "a".repeat(500);
    const result = sanitizeContextValue(longString);
    expect(result?.length).toBe(MAX_CONTEXT_FIELD_LENGTH);
    expect(result).toBe("a".repeat(MAX_CONTEXT_FIELD_LENGTH));
  });

  it("preserves strings within length limit", () => {
    const validString = "a".repeat(100);
    expect(sanitizeContextValue(validString)).toBe(validString);
  });
});

describe("normalizeClientContext", () => {
  it("returns undefined for non-object values", () => {
    expect(normalizeClientContext(null)).toBeUndefined();
    expect(normalizeClientContext("string")).toBeUndefined();
    expect(normalizeClientContext(123)).toBeUndefined();
    expect(normalizeClientContext([])).toBeUndefined();
  });

  it("returns undefined when all fields are invalid", () => {
    expect(normalizeClientContext({})).toBeUndefined();
    expect(normalizeClientContext({ foo: "bar" })).toBeUndefined();
    expect(normalizeClientContext({ currentTimeIso: 123 })).toBeUndefined();
  });

  it("validates ISO date format", () => {
    const validContext = normalizeClientContext({
      currentTimeIso: "2025-01-01T12:00:00.000Z",
    });
    expect(validContext?.currentTimeIso).toBe("2025-01-01T12:00:00.000Z");

    const invalidContext = normalizeClientContext({
      currentTimeIso: "invalid-date",
    });
    expect(invalidContext).toBeUndefined();
  });

  it("normalizes partial context with only timeZone", () => {
    const context = normalizeClientContext({
      timeZone: "America/New_York",
    });
    expect(context).toEqual({
      timeZone: "America/New_York",
      currentTimeIso: undefined,
      locale: undefined,
      userAgent: undefined,
    });
  });

  it("normalizes partial context with only locale", () => {
    const context = normalizeClientContext({
      locale: "en-US",
    });
    expect(context).toEqual({
      locale: "en-US",
      currentTimeIso: undefined,
      timeZone: undefined,
      userAgent: undefined,
    });
  });

  it("normalizes partial context with only userAgent", () => {
    const context = normalizeClientContext({
      userAgent: "Mozilla/5.0",
    });
    expect(context).toEqual({
      userAgent: "Mozilla/5.0",
      currentTimeIso: undefined,
      timeZone: undefined,
      locale: undefined,
    });
  });

  it("normalizes full context with all fields", () => {
    const context = normalizeClientContext({
      currentTimeIso: "2025-01-01T12:00:00.000Z",
      timeZone: "America/New_York",
      locale: "en-US",
      userAgent: "Mozilla/5.0",
    });
    expect(context).toEqual({
      currentTimeIso: "2025-01-01T12:00:00.000Z",
      timeZone: "America/New_York",
      locale: "en-US",
      userAgent: "Mozilla/5.0",
    });
  });

  it("filters out empty string values", () => {
    const context = normalizeClientContext({
      timeZone: "",
      locale: "en-US",
    });
    expect(context).toEqual({
      locale: "en-US",
      timeZone: undefined,
      currentTimeIso: undefined,
      userAgent: undefined,
    });
  });

  it("truncates long field values", () => {
    const longString = "a".repeat(500);
    const context = normalizeClientContext({
      timeZone: longString,
    });
    expect(context?.timeZone?.length).toBe(MAX_CONTEXT_FIELD_LENGTH);
  });
});

describe("buildContextualSystemPrompt", () => {
  const basePrompt = "You are a helpful assistant.";

  it("returns base prompt when context is undefined", () => {
    expect(buildContextualSystemPrompt(basePrompt, undefined)).toBe(basePrompt);
  });

  it("returns base prompt when all context fields are undefined", () => {
    const emptyContext = {
      currentTimeIso: undefined,
      timeZone: undefined,
      locale: undefined,
      userAgent: undefined,
    };
    expect(buildContextualSystemPrompt(basePrompt, emptyContext)).toBe(basePrompt);
  });

  it("adds only currentTimeIso when present", () => {
    const context = {
      currentTimeIso: "2025-01-01T12:00:00.000Z",
      timeZone: undefined,
      locale: undefined,
      userAgent: undefined,
    };
    const result = buildContextualSystemPrompt(basePrompt, context);
    expect(result).toBe(
      `${basePrompt}\n\nContext:\n- Current date/time (from user device): 2025-01-01T12:00:00.000Z`,
    );
  });

  it("adds only timeZone when present", () => {
    const context = {
      currentTimeIso: undefined,
      timeZone: "America/New_York",
      locale: undefined,
      userAgent: undefined,
    };
    const result = buildContextualSystemPrompt(basePrompt, context);
    expect(result).toBe(`${basePrompt}\n\nContext:\n- User time zone: America/New_York`);
  });

  it("adds only locale when present", () => {
    const context = {
      currentTimeIso: undefined,
      timeZone: undefined,
      locale: "en-US",
      userAgent: undefined,
    };
    const result = buildContextualSystemPrompt(basePrompt, context);
    expect(result).toBe(`${basePrompt}\n\nContext:\n- User locale: en-US`);
  });

  it("adds only userAgent when present", () => {
    const context = {
      currentTimeIso: undefined,
      timeZone: undefined,
      locale: undefined,
      userAgent: "Mozilla/5.0",
    };
    const result = buildContextualSystemPrompt(basePrompt, context);
    expect(result).toBe(`${basePrompt}\n\nContext:\n- User agent: Mozilla/5.0`);
  });

  it("adds all context fields when present", () => {
    const context = {
      currentTimeIso: "2025-01-01T12:00:00.000Z",
      timeZone: "America/New_York",
      locale: "en-US",
      userAgent: "Mozilla/5.0",
    };
    const result = buildContextualSystemPrompt(basePrompt, context);
    expect(result).toBe(
      `${basePrompt}\n\nContext:\n- Current date/time (from user device): 2025-01-01T12:00:00.000Z\n- User time zone: America/New_York\n- User locale: en-US\n- User agent: Mozilla/5.0`,
    );
  });

  it("adds multiple partial context fields", () => {
    const context = {
      currentTimeIso: "2025-01-01T12:00:00.000Z",
      timeZone: undefined,
      locale: "en-US",
      userAgent: undefined,
    };
    const result = buildContextualSystemPrompt(basePrompt, context);
    expect(result).toBe(
      `${basePrompt}\n\nContext:\n- Current date/time (from user device): 2025-01-01T12:00:00.000Z\n- User locale: en-US`,
    );
  });
});

describe("parseModelAllowlist", () => {
  it("returns array with default model when allowlist is undefined", () => {
    const result = parseModelAllowlist(undefined, "@cf/default/model");
    expect(result).toEqual(["@cf/default/model"]);
  });

  it("returns array with default model when allowlist is empty string", () => {
    const result = parseModelAllowlist("", "@cf/default/model");
    expect(result).toEqual(["@cf/default/model"]);
  });

  it("parses comma-separated model list", () => {
    const result = parseModelAllowlist(
      "@cf/model1,@cf/model2,@cf/model3",
      "@cf/default/model",
    );
    expect(result).toEqual([
      "@cf/default/model",
      "@cf/model1",
      "@cf/model2",
      "@cf/model3",
    ]);
  });

  it("trims whitespace from model names", () => {
    const result = parseModelAllowlist(
      " @cf/model1 , @cf/model2 , @cf/model3 ",
      "@cf/default/model",
    );
    expect(result).toEqual([
      "@cf/default/model",
      "@cf/model1",
      "@cf/model2",
      "@cf/model3",
    ]);
  });

  it("removes duplicate models", () => {
    const result = parseModelAllowlist(
      "@cf/model1,@cf/model2,@cf/model1,@cf/model2",
      "@cf/default/model",
    );
    expect(result).toEqual(["@cf/default/model", "@cf/model1", "@cf/model2"]);
  });

  it("prepends default model if not in allowlist", () => {
    const result = parseModelAllowlist("@cf/model1,@cf/model2", "@cf/default/model");
    expect(result).toEqual(["@cf/default/model", "@cf/model1", "@cf/model2"]);
  });

  it("does not duplicate default model if already in allowlist", () => {
    const result = parseModelAllowlist(
      "@cf/model1,@cf/default/model,@cf/model2",
      "@cf/default/model",
    );
    expect(result).toEqual(["@cf/model1", "@cf/default/model", "@cf/model2"]);
  });

  it("filters out empty strings from allowlist", () => {
    const result = parseModelAllowlist("@cf/model1,,@cf/model2,", "@cf/default/model");
    expect(result).toEqual(["@cf/default/model", "@cf/model1", "@cf/model2"]);
  });
});

describe("parsePositiveInt", () => {
  it("returns fallback for undefined value", () => {
    expect(parsePositiveInt(undefined, 100)).toBe(100);
  });

  it("returns fallback for empty string", () => {
    expect(parsePositiveInt("", 100)).toBe(100);
  });

  it("returns fallback for non-numeric string", () => {
    expect(parsePositiveInt("abc", 100)).toBe(100);
    expect(parsePositiveInt("abc123", 100)).toBe(100);
  });

  it("returns fallback for zero", () => {
    expect(parsePositiveInt("0", 100)).toBe(100);
  });

  it("returns fallback for negative values", () => {
    expect(parsePositiveInt("-5", 100)).toBe(100);
    expect(parsePositiveInt("-100", 100)).toBe(100);
  });

  it("parses valid positive integers", () => {
    expect(parsePositiveInt("1", 100)).toBe(1);
    expect(parsePositiveInt("42", 100)).toBe(42);
    expect(parsePositiveInt("1000", 100)).toBe(1000);
  });

  it("handles leading/trailing whitespace", () => {
    expect(parsePositiveInt("  42  ", 100)).toBe(42);
  });

  it("returns fallback for decimal numbers", () => {
    expect(parsePositiveInt("3.14", 100)).toBe(3);
  });
});

describe("applySecurityHeaders", () => {
  it("adds base security headers to response", () => {
    const response = new Response("test");
    const secured = applySecurityHeaders(response);

    expect(secured.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(secured.headers.get("X-Frame-Options")).toBe("DENY");
    expect(secured.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(secured.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(secured.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(secured.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(secured.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(secured.headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("adds CSP header when isHtml is true", () => {
    const response = new Response("<html></html>");
    const secured = applySecurityHeaders(response, { isHtml: true });

    const csp = secured.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("does not add CSP header when isHtml is false", () => {
    const response = new Response(JSON.stringify({ data: "test" }));
    const secured = applySecurityHeaders(response, { isHtml: false });

    expect(secured.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("adds cache-control header when specified", () => {
    const response = new Response("test");
    const secured = applySecurityHeaders(response, { cacheControl: "no-store" });

    expect(secured.headers.get("Cache-Control")).toBe("no-store");
  });

  it("preserves response body and status", () => {
    const response = new Response("test body", { status: 404, statusText: "Not Found" });
    const secured = applySecurityHeaders(response);

    expect(secured.status).toBe(404);
    expect(secured.statusText).toBe("Not Found");
  });

  it("preserves existing headers", () => {
    const response = new Response("test", {
      headers: { "Content-Type": "application/json" },
    });
    const secured = applySecurityHeaders(response);

    expect(secured.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("parseJsonBodyWithLimit", () => {
  it("returns error when body exceeds maxBytes", async () => {
    const largeBody = "x".repeat(2000);
    const request = new Request("https://example.com", {
      method: "POST",
      body: largeBody,
    });

    const result = await parseJsonBodyWithLimit(request, 1000);

    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error.status).toBe(413);
      const json = (await result.error.json()) as { error: string };
      expect(json.error).toContain("Request body too large");
    }
  });

  it("returns error for invalid JSON", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "invalid json",
    });

    const result = await parseJsonBodyWithLimit(request, 1000);

    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error.status).toBe(400);
      const json = (await result.error.json()) as { error: string };
      expect(json.error).toBe("Invalid JSON body");
    }
  });

  it("parses valid JSON within limit", async () => {
    const data = { message: "hello", count: 42 };
    const request = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify(data),
    });

    const result = await parseJsonBodyWithLimit(request, 1000);

    expect(result).toHaveProperty("data");
    if ("data" in result) {
      expect(result.data).toEqual(data);
    }
  });

  it("handles empty body", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "",
    });

    const result = await parseJsonBodyWithLimit(request, 1000);

    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error.status).toBe(400);
    }
  });
});

describe("isChatMessage", () => {
  it("returns true for valid system message", () => {
    expect(isChatMessage({ role: "system", content: "You are helpful" })).toBe(true);
  });

  it("returns true for valid user message", () => {
    expect(isChatMessage({ role: "user", content: "Hello" })).toBe(true);
  });

  it("returns true for valid assistant message", () => {
    expect(isChatMessage({ role: "assistant", content: "Hi there" })).toBe(true);
  });

  it("returns false for invalid role", () => {
    expect(isChatMessage({ role: "moderator", content: "Hello" })).toBe(false);
    expect(isChatMessage({ role: "", content: "Hello" })).toBe(false);
  });

  it("returns false for missing role", () => {
    expect(isChatMessage({ content: "Hello" })).toBe(false);
  });

  it("returns false for missing content", () => {
    expect(isChatMessage({ role: "user" })).toBe(false);
  });

  it("returns false for non-string content", () => {
    expect(isChatMessage({ role: "user", content: 123 })).toBe(false);
    expect(isChatMessage({ role: "user", content: null })).toBe(false);
    expect(isChatMessage({ role: "user", content: {} })).toBe(false);
  });

  it("returns false for non-object values", () => {
    expect(isChatMessage(null)).toBe(false);
    expect(isChatMessage(undefined)).toBe(false);
    expect(isChatMessage("string")).toBe(false);
    expect(isChatMessage(123)).toBe(false);
  });
});

describe("checkRateLimit", () => {
  it("allows first request", () => {
    const isLimited = checkRateLimit("test-ip-1", 5, 60000);
    expect(isLimited).toBe(false);
  });

  it("allows requests within limit", () => {
    const ip = "test-ip-2";
    expect(checkRateLimit(ip, 3, 60000)).toBe(false);
    expect(checkRateLimit(ip, 3, 60000)).toBe(false);
    expect(checkRateLimit(ip, 3, 60000)).toBe(false);
  });

  it("blocks requests exceeding limit", () => {
    const ip = "test-ip-3";
    expect(checkRateLimit(ip, 2, 60000)).toBe(false);
    expect(checkRateLimit(ip, 2, 60000)).toBe(false);
    expect(checkRateLimit(ip, 2, 60000)).toBe(true);
    expect(checkRateLimit(ip, 2, 60000)).toBe(true);
  });

  it("tracks different IPs independently", () => {
    expect(checkRateLimit("ip-a", 2, 60000)).toBe(false);
    expect(checkRateLimit("ip-b", 2, 60000)).toBe(false);
    expect(checkRateLimit("ip-a", 2, 60000)).toBe(false);
    expect(checkRateLimit("ip-b", 2, 60000)).toBe(false);
    expect(checkRateLimit("ip-a", 2, 60000)).toBe(true);
    expect(checkRateLimit("ip-b", 2, 60000)).toBe(true);
  });
});
