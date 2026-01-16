import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleChatRequest } from "./index";
import type { Env } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

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
});
