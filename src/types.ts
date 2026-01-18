/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
  /**
   * Binding for the Workers AI API.
   */
  AI: Ai;

  /**
   * Binding for static assets.
   */
  ASSETS: { fetch: (request: Request) => Promise<Response> };

  /**
   * Configuration variables
   */
  MODEL_ID?: string;
  MODEL_ALLOWLIST?: string;
  SYSTEM_PROMPT?: string;
  MAX_MESSAGE_LENGTH?: string;
  MAX_MESSAGES?: string;
  MAX_TOKENS?: string;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_MS?: string;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Context data sent from the client to improve responses.
 */
export interface ClientContext {
  currentTimeIso?: string;
  timeZone?: string;
  locale?: string;
  userAgent?: string;
}
