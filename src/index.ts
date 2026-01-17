/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Default configuration values (can be overridden via environment variables)
const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, friendly assistant named daddy. If asked what your name is, respond exactly: \"hi my name is daddy. I’m here to be your daddy.\" Provide concise and accurate responses.";
const DEFAULT_MAX_MESSAGE_LENGTH = 10000;
const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_RATE_LIMIT_REQUESTS = 20; // 20 requests
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000; // per 60 seconds

// Simple in-memory rate limiter (resets on Worker restart)
// For production, consider using Durable Objects or Rate Limiting API
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

export default {
  /**
   * Main request handler for the Worker
   *
   * Routes incoming requests to appropriate handlers:
   * - `/api/chat` (POST) - Chat API endpoint
   * - `/` and other paths - Static assets
   *
   * @param request - The incoming HTTP request
   * @param env - Environment bindings (AI, ASSETS, configuration)
   * @param ctx - Execution context for async operations
   * @returns Response object
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle static assets (frontend)
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/config") {
      if (request.method === "GET") {
        return handleConfigRequest(env);
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // API Routes
    if (url.pathname === "/api/chat") {
      // Handle POST requests for chat
      if (request.method === "POST") {
        return handleChatRequest(request, env);
      }

      // Method not allowed for other request types
      return new Response("Method not allowed", { status: 405 });
    }

    // Handle 404 for unmatched routes
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * JSON response headers constant
 */
const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * Set of valid chat message roles
 */
const VALID_ROLES = new Set<ChatMessage["role"]>(["system", "user", "assistant"]);

function parseModelAllowlist(
  allowlistValue: string | undefined,
  defaultModel: string,
): string[] {
  const models = (allowlistValue ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  if (models.length === 0) {
    return [defaultModel];
  }

  if (!models.includes(defaultModel)) {
    models.unshift(defaultModel);
  }

  return Array.from(new Set(models));
}

async function handleConfigRequest(env: Env): Promise<Response> {
  const MODEL_ID = env.MODEL_ID || DEFAULT_MODEL_ID;
  const models = parseModelAllowlist(env.MODEL_ALLOWLIST, MODEL_ID);

  return new Response(
    JSON.stringify({
      defaultModel: MODEL_ID,
      models,
    }),
    { headers: JSON_HEADERS },
  );
}

/**
 * Type guard to validate if a value is a valid ChatMessage
 *
 * @param value - The value to check
 * @returns True if the value is a valid ChatMessage, false otherwise
 */
function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const { role, content } = value as Partial<ChatMessage>;
  return (
    typeof role === "string" &&
    VALID_ROLES.has(role as ChatMessage["role"]) &&
    typeof content === "string"
  );
}

/**
 * Check rate limit for a given identifier (e.g., IP address)
 *
 * Uses a simple in-memory sliding window algorithm. Resets on Worker restart.
 * For production use, consider Cloudflare's Rate Limiting API or Durable Objects.
 *
 * @param identifier - Unique identifier (typically IP address)
 * @param maxRequests - Maximum number of requests allowed in the window
 * @param windowMs - Time window in milliseconds
 * @returns True if rate limit is exceeded, false otherwise
 */
function checkRateLimit(
  identifier: string,
  maxRequests: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(identifier);

  if (!record || now > record.resetTime) {
    // First request or window expired, create new record
    rateLimitMap.set(identifier, { count: 1, resetTime: now + windowMs });
    return false;
  }

  if (record.count >= maxRequests) {
    // Rate limit exceeded
    return true;
  }

  // Increment count
  record.count++;
  return false;
}

/**
 * Handles chat API requests
 *
 * Validates input, checks rate limits, and streams AI responses.
 *
 * Request body format:
 * ```json
 * {
 *   "messages": [
 *     { "role": "user", "content": "Hello" }
 *   ]
 * }
 * ```
 *
 * Response: Streaming JSON with format `{"response": "text chunk"}\n`
 *
 * Error responses:
 * - 400: Invalid request (malformed JSON, invalid messages, too long, too many)
 * - 429: Rate limit exceeded
 * - 500: Server error
 *
 * @param request - The incoming HTTP request
 * @param env - Environment bindings and configuration
 * @returns Response object (streaming or error)
 */
export async function handleChatRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  // Get configuration from environment variables or use defaults
  const MODEL_ID = env.MODEL_ID || DEFAULT_MODEL_ID;
  const MODEL_ALLOWLIST = parseModelAllowlist(env.MODEL_ALLOWLIST, MODEL_ID);
  const SYSTEM_PROMPT = env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  const MAX_MESSAGE_LENGTH = parseInt(
    env.MAX_MESSAGE_LENGTH || String(DEFAULT_MAX_MESSAGE_LENGTH),
  );
  const MAX_MESSAGES = parseInt(env.MAX_MESSAGES || String(DEFAULT_MAX_MESSAGES));
  const MAX_TOKENS = parseInt(env.MAX_TOKENS || String(DEFAULT_MAX_TOKENS));
  const RATE_LIMIT_REQUESTS = parseInt(
    env.RATE_LIMIT_REQUESTS || String(DEFAULT_RATE_LIMIT_REQUESTS),
  );
  const RATE_LIMIT_WINDOW_MS = parseInt(
    env.RATE_LIMIT_WINDOW_MS || String(DEFAULT_RATE_LIMIT_WINDOW_MS),
  );

  // Check rate limit using IP address or CF-Connecting-IP header
  const clientIp =
    request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";

  if (checkRateLimit(clientIp, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    return new Response(
      JSON.stringify({
        error: `Rate limit exceeded. Please try again later.`,
      }),
      {
        status: 429,
        headers: {
          ...JSON_HEADERS,
          "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
        }
      },
    );
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    const { messages, model } = (body ?? {}) as {
      messages?: unknown;
      model?: unknown;
    };

    if (!Array.isArray(messages) || !messages.every(isChatMessage)) {
      return new Response(
        JSON.stringify({
          error: "Invalid request: messages must be an array of chat messages",
        }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // Validate message count
    if (messages.length > MAX_MESSAGES) {
      return new Response(
        JSON.stringify({
          error: `Too many messages: maximum ${MAX_MESSAGES} messages allowed`,
        }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // Validate message lengths
    for (const message of messages) {
      if (message.content.length > MAX_MESSAGE_LENGTH) {
        return new Response(
          JSON.stringify({
            error: `Message too long: maximum ${MAX_MESSAGE_LENGTH} characters allowed`,
          }),
          { status: 400, headers: JSON_HEADERS },
        );
      }
    }

    const requestedModel = typeof model === "string" ? model.trim() : undefined;
    if (requestedModel && !MODEL_ALLOWLIST.includes(requestedModel)) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid model selection. Please choose a model from the allowed list.",
        }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    const modelToUse = requestedModel || MODEL_ID;

    const normalizedMessages = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    // Add system prompt if not present
    if (!normalizedMessages.some((msg) => msg.role === "system")) {
      normalizedMessages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    const response = await env.AI.run(
      modelToUse,
      {
        messages: normalizedMessages,
        max_tokens: MAX_TOKENS,
      },
      {
        returnRawResponse: true,
        // Uncomment to use AI Gateway
        // gateway: {
        //   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
        //   skipCache: false,      // Set to true to bypass cache
        //   cacheTtl: 3600,        // Cache time-to-live in seconds
        // },
      },
    );

    // Return streaming response
    return response;
  } catch (error) {
    console.error("Error processing chat request:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process request" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
