/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage, ClientContext } from "./types";

// Default configuration values (can be overridden via environment variables)
const DEFAULT_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fast";
const DEFAULT_SYSTEM_PROMPT =
  "You're interacting with a test chatbot. Nothing here is stored or saved. Be direct and realistic in your responses. When faced with questions, consider multiple angles and don't hesitate to explore unconventional approaches. Challenge assumptions when appropriate. Keep responses clear and grounded without unnecessary enthusiasm. For time-sensitive questions, clearly state what date or time context you are using and be transparent if you do not have live web access.";
const DEFAULT_MAX_MESSAGE_LENGTH = 10000;
const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_ADDRESS_LOOKUP_MAX_TOKENS = 1024;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_RATE_LIMIT_REQUESTS = 20; // 20 requests
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000; // per 60 seconds
export const MAX_CONTEXT_FIELD_LENGTH = 300;

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
      const response = await env.ASSETS.fetch(request);
      const contentType = response.headers.get("content-type") || "";
      return applySecurityHeaders(response, {
        isHtml: contentType.includes("text/html"),
      });
    }

    // API Routes
    if (url.pathname === "/api/chat") {
      // Handle POST requests for chat
      if (request.method === "POST") {
        return handleChatRequest(request, env);
      }

      // Method not allowed for other request types
      return applySecurityHeaders(new Response("Method not allowed", { status: 405 }), {
        cacheControl: "no-store",
      });
    }

    if (url.pathname === "/api/address-lookup") {
      if (request.method === "POST") {
        return handleAddressLookup(request, env);
      }

      return applySecurityHeaders(new Response("Method not allowed", { status: 405 }), {
        cacheControl: "no-store",
      });
    }

    if (url.pathname === "/api/intake-licensee") {
      if (request.method === "POST") {
        return handleIntakeLicensee(request, env);
      }

      return applySecurityHeaders(new Response("Method not allowed", { status: 405 }), {
        cacheControl: "no-store",
      });
    }

    // Handle 404 for unmatched routes
    return applySecurityHeaders(new Response("Not found", { status: 404 }), {
      cacheControl: "no-store",
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * JSON response headers constant
 */
const JSON_HEADERS = { "content-type": "application/json" } as const;
const BASE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
} as const;
const HTML_CONTENT_SECURITY_POLICY =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "object-src 'none'";

/**
 * Set of valid chat message roles
 */
const VALID_ROLES = new Set<ChatMessage["role"]>(["system", "user", "assistant"]);

export function sanitizeContextValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, MAX_CONTEXT_FIELD_LENGTH);
}

export function normalizeClientContext(value: unknown): ClientContext | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const raw = value as ClientContext;

  const currentTimeIso = sanitizeContextValue(raw.currentTimeIso);
  const parsedTime =
    currentTimeIso && Number.isNaN(Date.parse(currentTimeIso))
      ? undefined
      : currentTimeIso;

  const timeZone = sanitizeContextValue(raw.timeZone);
  const locale = sanitizeContextValue(raw.locale);
  const userAgent = sanitizeContextValue(raw.userAgent);

  if (!parsedTime && !timeZone && !locale && !userAgent) {
    return undefined;
  }

  return {
    currentTimeIso: parsedTime,
    timeZone,
    locale,
    userAgent,
  };
}

export function buildContextualSystemPrompt(
  basePrompt: string,
  clientContext?: ClientContext,
): string {
  if (!clientContext) {
    return basePrompt;
  }

  const contextLines: string[] = [];

  if (clientContext.currentTimeIso) {
    contextLines.push(
      `Current date/time (from user device): ${clientContext.currentTimeIso}`,
    );
  }
  if (clientContext.timeZone) {
    contextLines.push(`User time zone: ${clientContext.timeZone}`);
  }
  if (clientContext.locale) {
    contextLines.push(`User locale: ${clientContext.locale}`);
  }
  if (clientContext.userAgent) {
    contextLines.push(`User agent: ${clientContext.userAgent}`);
  }

  if (contextLines.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}\n\nContext:\n- ${contextLines.join("\n- ")}`;
}

export function parseModelAllowlist(
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

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function applySecurityHeaders(
  response: Response,
  options: { isHtml?: boolean; cacheControl?: string } = {},
): Response {
  const headers = new Headers(response.headers);

  Object.entries(BASE_SECURITY_HEADERS).forEach(([key, value]) => {
    headers.set(key, value);
  });

  if (options.cacheControl) {
    headers.set("Cache-Control", options.cacheControl);
  }

  if (options.isHtml) {
    headers.set("Content-Security-Policy", HTML_CONTENT_SECURITY_POLICY);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function parseJsonBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<{ data: unknown } | { error: Response }> {
  const bodyBuffer = await request.arrayBuffer();

  if (bodyBuffer.byteLength > maxBytes) {
    return {
      error: new Response(
        JSON.stringify({
          error: `Request body too large: maximum ${maxBytes} bytes allowed`,
        }),
        { status: 413, headers: JSON_HEADERS },
      ),
    };
  }

  try {
    const text = new TextDecoder().decode(bodyBuffer);
    return { data: JSON.parse(text) };
  } catch {
    return {
      error: new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: JSON_HEADERS },
      ),
    };
  }
}

/**
 * Type guard to validate if a value is a valid ChatMessage
 *
 * @param value - The value to check
 * @returns True if the value is a valid ChatMessage, false otherwise
 */
export function isChatMessage(value: unknown): value is ChatMessage {
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
export function checkRateLimit(
  identifier: string,
  maxRequests: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(identifier);

  // Clean up expired entries to prevent memory leak (limit to 1000 entries max)
  if (rateLimitMap.size > 1000) {
    for (const [key, value] of rateLimitMap.entries()) {
      if (now > value.resetTime) {
        rateLimitMap.delete(key);
      }
    }
  }

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
  const MAX_MESSAGE_LENGTH = parsePositiveInt(
    env.MAX_MESSAGE_LENGTH,
    DEFAULT_MAX_MESSAGE_LENGTH,
  );
  const MAX_MESSAGES = parsePositiveInt(env.MAX_MESSAGES, DEFAULT_MAX_MESSAGES);
  const MAX_TOKENS = parsePositiveInt(env.MAX_TOKENS, DEFAULT_MAX_TOKENS);
  const MAX_BODY_BYTES = parsePositiveInt(
    env.MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
  );
  const RATE_LIMIT_REQUESTS = parsePositiveInt(
    env.RATE_LIMIT_REQUESTS,
    DEFAULT_RATE_LIMIT_REQUESTS,
  );
  const RATE_LIMIT_WINDOW_MS = parsePositiveInt(
    env.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
  );

  // Check rate limit using IP address or CF-Connecting-IP header
  const forwardedFor = request.headers.get("X-Forwarded-For") || "";
  const forwardedIp = forwardedFor.split(",")[0]?.trim();
  const clientIp =
    request.headers.get("CF-Connecting-IP") ||
    forwardedIp ||
    "unknown";

  if (checkRateLimit(clientIp, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    return applySecurityHeaders(
      new Response(
        JSON.stringify({
          error: `Rate limit exceeded. Please try again later.`,
        }),
        {
          status: 429,
          headers: {
            ...JSON_HEADERS,
            "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
          },
        },
      ),
      { cacheControl: "no-store" },
    );
  }

  try {
    let body: unknown;
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({ error: "Content-Type must be application/json" }),
          { status: 415, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: `Request body too large: maximum ${MAX_BODY_BYTES} bytes allowed`,
          }),
          { status: 413, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const parsedBody = await parseJsonBodyWithLimit(request, MAX_BODY_BYTES);
    if ("error" in parsedBody) {
      return applySecurityHeaders(parsedBody.error, { cacheControl: "no-store" });
    }

    body = parsedBody.data;

    const { messages, model, clientContext } = (body ?? {}) as {
      messages?: unknown;
      model?: unknown;
      clientContext?: unknown;
    };

    if (!Array.isArray(messages) || !messages.every(isChatMessage)) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: "Invalid request: messages must be an array of chat messages",
          }),
          { status: 400, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    // Validate message count
    if (messages.length > MAX_MESSAGES) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: `Too many messages: maximum ${MAX_MESSAGES} messages allowed`,
          }),
          { status: 400, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    // Validate message lengths
    for (const message of messages) {
      if (message.content.length > MAX_MESSAGE_LENGTH) {
        return applySecurityHeaders(
          new Response(
            JSON.stringify({
              error: `Message too long: maximum ${MAX_MESSAGE_LENGTH} characters allowed`,
            }),
            { status: 400, headers: JSON_HEADERS },
          ),
          { cacheControl: "no-store" },
        );
      }
    }

    const requestedModel = typeof model === "string" ? model.trim() : undefined;
    if (requestedModel && !MODEL_ALLOWLIST.includes(requestedModel)) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error:
              "Invalid model selection. Please choose a model from the allowed list.",
          }),
          { status: 400, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const modelToUse = (requestedModel || MODEL_ID) as keyof AiModels;
    const normalizedClientContext = normalizeClientContext(clientContext);
    const contextualSystemPrompt = buildContextualSystemPrompt(
      SYSTEM_PROMPT,
      normalizedClientContext,
    );

    const normalizedMessages = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    // Add system prompt if not present
    if (!normalizedMessages.some((msg) => msg.role === "system")) {
      normalizedMessages.unshift({
        role: "system",
        content: contextualSystemPrompt,
      });
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
    return applySecurityHeaders(response, { cacheControl: "no-store" });
  } catch (error) {
    console.error("Error processing chat request:", error);
    return applySecurityHeaders(
      new Response(
        JSON.stringify({ error: "Failed to process request" }),
        { status: 500, headers: JSON_HEADERS },
      ),
      { cacheControl: "no-store" },
    );
  }
}

const ADDRESS_LOOKUP_SYSTEM_PROMPT =
  "You are an address lookup assistant. When given an address, provide useful information about it. " +
  "Include details such as: the general area or neighborhood, the city/state/country, postal code if known, " +
  "and any notable landmarks or points of interest nearby. " +
  "If the address appears incomplete or ambiguous, mention that and provide your best interpretation. " +
  "Keep your response concise and well-structured. " +
  "If the input does not appear to be a valid address, politely indicate that and ask for clarification.";

/**
 * Handles address lookup API requests
 *
 * Accepts an address string, sends it to the AI model for lookup information,
 * and returns a streaming response.
 *
 * Request body format:
 * ```json
 * {
 *   "address": "123 Main St, Springfield, IL"
 * }
 * ```
 *
 * @param request - The incoming HTTP request
 * @param env - Environment bindings and configuration
 * @returns Response object (streaming or error)
 */
export async function handleAddressLookup(
  request: Request,
  env: Env,
): Promise<Response> {
  const MODEL_ID = env.MODEL_ID || DEFAULT_MODEL_ID;
  const MAX_BODY_BYTES = parsePositiveInt(
    env.MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
  );
  const MAX_TOKENS = parsePositiveInt(env.MAX_TOKENS, DEFAULT_ADDRESS_LOOKUP_MAX_TOKENS);
  const RATE_LIMIT_REQUESTS = parsePositiveInt(
    env.RATE_LIMIT_REQUESTS,
    DEFAULT_RATE_LIMIT_REQUESTS,
  );
  const RATE_LIMIT_WINDOW_MS = parsePositiveInt(
    env.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
  );

  const forwardedFor = request.headers.get("X-Forwarded-For") || "";
  const forwardedIp = forwardedFor.split(",")[0]?.trim();
  const clientIp =
    request.headers.get("CF-Connecting-IP") ||
    forwardedIp ||
    "unknown";

  if (checkRateLimit(clientIp, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    return applySecurityHeaders(
      new Response(
        JSON.stringify({
          error: "Rate limit exceeded. Please try again later.",
        }),
        {
          status: 429,
          headers: {
            ...JSON_HEADERS,
            "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
          },
        },
      ),
      { cacheControl: "no-store" },
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({ error: "Content-Type must be application/json" }),
          { status: 415, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: `Request body too large: maximum ${MAX_BODY_BYTES} bytes allowed`,
          }),
          { status: 413, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const parsedBody = await parseJsonBodyWithLimit(request, MAX_BODY_BYTES);
    if ("error" in parsedBody) {
      return applySecurityHeaders(parsedBody.error, { cacheControl: "no-store" });
    }

    const { address, clientContext } = (parsedBody.data ?? {}) as {
      address?: unknown;
      clientContext?: unknown;
    };

    if (typeof address !== "string" || !address.trim()) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: "Invalid request: address must be a non-empty string",
          }),
          { status: 400, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const MAX_ADDRESS_LENGTH = 500;
    if (address.length > MAX_ADDRESS_LENGTH) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: `Address too long: maximum ${MAX_ADDRESS_LENGTH} characters allowed`,
          }),
          { status: 400, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const normalizedClientContext = normalizeClientContext(clientContext);
    const contextualSystemPrompt = buildContextualSystemPrompt(
      ADDRESS_LOOKUP_SYSTEM_PROMPT,
      normalizedClientContext,
    );

    const messages = [
      { role: "system" as const, content: contextualSystemPrompt },
      { role: "user" as const, content: `Look up the following address and provide information about it:\n\n${address.trim()}` },
    ];

    const modelToUse = (env.MODEL_ID || DEFAULT_MODEL_ID) as keyof AiModels;

    const response = await env.AI.run(
      modelToUse,
      {
        messages,
        max_tokens: MAX_TOKENS,
      },
      {
        returnRawResponse: true,
      },
    );

    return applySecurityHeaders(response, { cacheControl: "no-store" });
  } catch (error) {
    console.error("Error processing address lookup:", error);
    return applySecurityHeaders(
      new Response(
        JSON.stringify({ error: "Failed to process address lookup" }),
        { status: 500, headers: JSON_HEADERS },
      ),
      { cacheControl: "no-store" },
    );
  }
}

const INTAKE_LICENSEE_SYSTEM_PROMPT =
  "You are a licensee intake processing assistant for administrators. " +
  "When given licensee information, review the data and produce a structured summary. " +
  "Verify that the information appears complete and consistent. " +
  "Flag any fields that look incomplete, inconsistent, or potentially incorrect. " +
  "Format your response as a clear intake summary with sections for: " +
  "Licensee Details, Contact Information, License Information, and any Notes or Flags. " +
  "If critical fields are missing (name or license number), clearly indicate what is needed.";

const VALID_LICENSE_TYPES = new Set([
  "business",
  "professional",
  "contractor",
  "real_estate",
  "medical",
  "financial",
  "other",
]);

/**
 * Validates that a value is a non-empty trimmed string within a max length.
 * Returns the trimmed string or undefined if invalid.
 */
function validateStringField(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

/**
 * Handles licensee intake form submissions
 *
 * Accepts licensee data from an admin form, validates the fields,
 * and uses AI to produce a structured intake summary.
 *
 * Request body format:
 * ```json
 * {
 *   "licenseeName": "Jane Doe",
 *   "licenseNumber": "LIC-12345",
 *   "licenseType": "professional",
 *   "contactEmail": "jane@example.com",
 *   "contactPhone": "555-0100",
 *   "address": "123 Main St, Springfield, IL",
 *   "notes": "Renewal pending"
 * }
 * ```
 *
 * @param request - The incoming HTTP request
 * @param env - Environment bindings and configuration
 * @returns Response object (streaming or error)
 */
export async function handleIntakeLicensee(
  request: Request,
  env: Env,
): Promise<Response> {
  const MAX_BODY_BYTES = parsePositiveInt(
    env.MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
  );
  const MAX_TOKENS = parsePositiveInt(env.MAX_TOKENS, DEFAULT_ADDRESS_LOOKUP_MAX_TOKENS);
  const RATE_LIMIT_REQUESTS = parsePositiveInt(
    env.RATE_LIMIT_REQUESTS,
    DEFAULT_RATE_LIMIT_REQUESTS,
  );
  const RATE_LIMIT_WINDOW_MS = parsePositiveInt(
    env.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
  );

  const forwardedFor = request.headers.get("X-Forwarded-For") || "";
  const forwardedIp = forwardedFor.split(",")[0]?.trim();
  const clientIp =
    request.headers.get("CF-Connecting-IP") ||
    forwardedIp ||
    "unknown";

  if (checkRateLimit(clientIp, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    return applySecurityHeaders(
      new Response(
        JSON.stringify({
          error: "Rate limit exceeded. Please try again later.",
        }),
        {
          status: 429,
          headers: {
            ...JSON_HEADERS,
            "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
          },
        },
      ),
      { cacheControl: "no-store" },
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({ error: "Content-Type must be application/json" }),
          { status: 415, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: `Request body too large: maximum ${MAX_BODY_BYTES} bytes allowed`,
          }),
          { status: 413, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const parsedBody = await parseJsonBodyWithLimit(request, MAX_BODY_BYTES);
    if ("error" in parsedBody) {
      return applySecurityHeaders(parsedBody.error, { cacheControl: "no-store" });
    }

    const {
      licenseeName,
      licenseNumber,
      licenseType,
      contactEmail,
      contactPhone,
      address,
      notes,
      clientContext,
    } = (parsedBody.data ?? {}) as {
      licenseeName?: unknown;
      licenseNumber?: unknown;
      licenseType?: unknown;
      contactEmail?: unknown;
      contactPhone?: unknown;
      address?: unknown;
      notes?: unknown;
      clientContext?: unknown;
    };

    // Validate required fields
    const validName = validateStringField(licenseeName, 200);
    if (!validName) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: "Invalid request: licenseeName is required and must be a non-empty string (max 200 characters)",
          }),
          { status: 400, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    const validLicenseNumber = validateStringField(licenseNumber, 100);
    if (!validLicenseNumber) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: "Invalid request: licenseNumber is required and must be a non-empty string (max 100 characters)",
          }),
          { status: 400, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    // Validate license type
    const validLicenseType = validateStringField(licenseType, 50);
    if (!validLicenseType || !VALID_LICENSE_TYPES.has(validLicenseType)) {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: `Invalid request: licenseType must be one of: ${Array.from(VALID_LICENSE_TYPES).join(", ")}`,
          }),
          { status: 400, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    // Validate optional fields
    const validEmail = validateStringField(contactEmail, 254);
    const validPhone = validateStringField(contactPhone, 30);
    const validAddress = validateStringField(address, 500);
    const validNotes = validateStringField(notes, 2000);

    // Build the intake data string for the AI
    const intakeLines: string[] = [
      `Licensee Name: ${validName}`,
      `License Number: ${validLicenseNumber}`,
      `License Type: ${validLicenseType}`,
    ];

    if (validEmail) intakeLines.push(`Contact Email: ${validEmail}`);
    if (validPhone) intakeLines.push(`Contact Phone: ${validPhone}`);
    if (validAddress) intakeLines.push(`Address: ${validAddress}`);
    if (validNotes) intakeLines.push(`Notes: ${validNotes}`);

    const intakeData = intakeLines.join("\n");

    const normalizedClientContext = normalizeClientContext(clientContext);
    const contextualSystemPrompt = buildContextualSystemPrompt(
      INTAKE_LICENSEE_SYSTEM_PROMPT,
      normalizedClientContext,
    );

    const messages = [
      { role: "system" as const, content: contextualSystemPrompt },
      {
        role: "user" as const,
        content: `Process the following licensee intake form submission and provide a structured summary:\n\n${intakeData}`,
      },
    ];

    const modelToUse = (env.MODEL_ID || DEFAULT_MODEL_ID) as keyof AiModels;

    const response = await env.AI.run(
      modelToUse,
      {
        messages,
        max_tokens: MAX_TOKENS,
      },
      {
        returnRawResponse: true,
      },
    );

    return applySecurityHeaders(response, { cacheControl: "no-store" });
  } catch (error) {
    console.error("Error processing licensee intake:", error);
    return applySecurityHeaders(
      new Response(
        JSON.stringify({ error: "Failed to process licensee intake" }),
        { status: 500, headers: JSON_HEADERS },
      ),
      { cacheControl: "no-store" },
    );
  }
}
