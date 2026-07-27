/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import {
  Env,
  ChatMessage,
  ClientContext,
  GeocodeResult,
  GeocodeResponse,
} from "./types";

// Default configuration values (can be overridden via environment variables)
const DEFAULT_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fast";
const DEFAULT_SYSTEM_PROMPT =
  "You're interacting with a test chatbot. Nothing here is stored or saved. Be direct and realistic in your responses. When faced with questions, consider multiple angles and don't hesitate to explore unconventional approaches. Challenge assumptions when appropriate. Keep responses clear and grounded without unnecessary enthusiasm. For time-sensitive questions, clearly state what date or time context you are using and be transparent if you do not have live web access.";
const DEFAULT_MAX_MESSAGE_LENGTH = 10000;
const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_TOKENS = 512;
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

// ── Address geocoding (real lookups via OpenStreetMap Nominatim) ──────────
//
// The original address lookup asked the language model to "look up" an
// address. Language models have no live data, so those answers were guesses:
// invented neighborhoods, postal codes, and landmarks presented as fact. This
// implementation performs a real geocode against the OpenStreetMap Nominatim
// service and returns verifiable coordinates and address components — a
// solution that actually works.

const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
// Nominatim's usage policy requires an identifying User-Agent.
const GEOCODE_USER_AGENT =
  "daddy-dig-address-lookup/1.0 (+https://github.com/drewc611/daddy-dig)";
const GEOCODE_TIMEOUT_MS = 10_000;
const MAX_GEOCODE_RESULTS = 5;
const MAX_ADDRESS_LENGTH = 500;
const GEOCODE_ATTRIBUTION = "Data © OpenStreetMap contributors (via Nominatim)";

/** Raw shape of a Nominatim result entry (all fields untrusted). */
interface NominatimEntry {
  display_name?: unknown;
  lat?: unknown;
  lon?: unknown;
  category?: unknown;
  type?: unknown;
  addresstype?: unknown;
  osm_type?: unknown;
  osm_id?: unknown;
  boundingbox?: unknown;
  address?: unknown;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function buildMapUrl(latitude: number, longitude: number): string {
  const zoom = 16;
  return (
    `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}` +
    `#map=${zoom}/${latitude}/${longitude}`
  );
}

/**
 * Converts a raw Nominatim entry into a validated GeocodeResult.
 *
 * Returns null when the entry is missing the coordinates or display name that
 * make a result meaningful, so callers can safely filter incomplete matches.
 */
export function normalizeGeocodeEntry(entry: NominatimEntry): GeocodeResult | null {
  const latitude = toFiniteNumber(entry.lat);
  const longitude = toFiniteNumber(entry.lon);
  const displayName =
    typeof entry.display_name === "string" ? entry.display_name.trim() : "";

  if (latitude === undefined || longitude === undefined || !displayName) {
    return null;
  }

  const address: Record<string, string> = {};
  if (entry.address && typeof entry.address === "object") {
    for (const [key, value] of Object.entries(
      entry.address as Record<string, unknown>,
    )) {
      if (typeof value === "string") {
        address[key] = value;
      }
    }
  }

  const boundingBox = Array.isArray(entry.boundingbox)
    ? entry.boundingbox.filter((v): v is string => typeof v === "string")
    : [];

  return {
    displayName,
    latitude,
    longitude,
    category: typeof entry.category === "string" ? entry.category : undefined,
    type: typeof entry.type === "string" ? entry.type : undefined,
    addressType:
      typeof entry.addresstype === "string" ? entry.addresstype : undefined,
    osmType: typeof entry.osm_type === "string" ? entry.osm_type : undefined,
    osmId: toFiniteNumber(entry.osm_id),
    boundingBox:
      boundingBox.length === 4
        ? (boundingBox as [string, string, string, string])
        : undefined,
    address: Object.keys(address).length > 0 ? address : undefined,
    mapUrl: buildMapUrl(latitude, longitude),
  };
}

/**
 * Geocodes an address query against OpenStreetMap Nominatim.
 *
 * @param query - The free-form address to resolve
 * @param options - Optional AbortSignal for timeout handling
 * @returns Validated, best-first matches (empty array when nothing matched)
 * @throws When the geocoding service is unreachable or returns an error status
 */
export async function geocodeAddress(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<GeocodeResult[]> {
  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(MAX_GEOCODE_RESULTS));
  url.searchParams.set("q", query);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": GEOCODE_USER_AGENT,
    },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Geocoding service returned status ${response.status}`);
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((entry) => normalizeGeocodeEntry(entry as NominatimEntry))
    .filter((result): result is GeocodeResult => result !== null);
}

/**
 * Handles address lookup API requests.
 *
 * Accepts an address string and returns real geocoding results from
 * OpenStreetMap Nominatim as JSON — verifiable coordinates and address
 * components rather than model-generated guesses.
 *
 * Request body format:
 * ```json
 * {
 *   "address": "123 Main St, Springfield, IL"
 * }
 * ```
 *
 * Response body ({@link GeocodeResponse}):
 * ```json
 * {
 *   "query": "123 Main St, Springfield, IL",
 *   "resultCount": 1,
 *   "results": [ { "displayName": "...", "latitude": 0, "longitude": 0, ... } ],
 *   "attribution": "Data © OpenStreetMap contributors (via Nominatim)"
 * }
 * ```
 *
 * Error responses:
 * - 400: Invalid request (missing/too-long address, bad JSON)
 * - 413: Request body too large
 * - 415: Unsupported Media Type
 * - 429: Rate limit exceeded
 * - 502: Geocoding service unavailable
 * - 504: Geocoding service timed out
 *
 * @param request - The incoming HTTP request
 * @param env - Environment bindings and configuration
 * @returns Response object (JSON results or error)
 */
export async function handleAddressLookup(
  request: Request,
  env: Env,
): Promise<Response> {
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

  const { address } = (parsedBody.data ?? {}) as { address?: unknown };

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

  const trimmedAddress = address.trim();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);

  try {
    const results = await geocodeAddress(trimmedAddress, {
      signal: controller.signal,
    });

    const payload: GeocodeResponse = {
      query: trimmedAddress,
      resultCount: results.length,
      results,
      attribution: GEOCODE_ATTRIBUTION,
    };

    return applySecurityHeaders(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: JSON_HEADERS,
      }),
      { cacheControl: "no-store" },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return applySecurityHeaders(
        new Response(
          JSON.stringify({
            error: "Address lookup timed out. Please try again.",
          }),
          { status: 504, headers: JSON_HEADERS },
        ),
        { cacheControl: "no-store" },
      );
    }

    console.error("Error processing address lookup:", error);
    return applySecurityHeaders(
      new Response(
        JSON.stringify({
          error:
            "Address lookup service is temporarily unavailable. Please try again.",
        }),
        { status: 502, headers: JSON_HEADERS },
      ),
      { cacheControl: "no-store" },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
