import { describe, expect, it, vi } from "vitest";
import { handleChatRequest } from "./index";
import type { Env } from "./types";

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

function createEnv(runImplementation: () => Promise<Response> | Response = () =>
  Promise.resolve(new Response("ok")),
) {
  const runMock = vi.fn(runImplementation);

  const env = {
    AI: {
      run: runMock,
    },
    ASSETS: {
      fetch: vi.fn(),
    },
  } as unknown as Env;

  return { env, runMock };
}

describe("handleChatRequest", () => {
  const url = "https://example.com/api/chat";

  it("returns 400 when the body is not valid JSON", async () => {
    const request = new Request(url, {
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
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: { role: "user" } }),
    });

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
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: requestMessages }),
    });

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
});
