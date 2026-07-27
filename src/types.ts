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
  MAX_BODY_BYTES?: string;
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

/**
 * A single verified geocoding result returned by the address lookup API.
 *
 * These fields come from a real geocoding service (OpenStreetMap Nominatim),
 * not from a language model, so the coordinates and address components are
 * verifiable data rather than generated guesses.
 */
export interface GeocodeResult {
  /** Full, human-readable address as resolved by the geocoder. */
  displayName: string;
  /** Decimal latitude. */
  latitude: number;
  /** Decimal longitude. */
  longitude: number;
  /** High-level classification (e.g. "place", "building", "highway"). */
  category?: string;
  /** Specific classification (e.g. "house", "city", "postcode"). */
  type?: string;
  /** The kind of address the match represents (e.g. "road", "city"). */
  addressType?: string;
  /** Underlying OpenStreetMap object type (node/way/relation). */
  osmType?: string;
  /** Underlying OpenStreetMap object id. */
  osmId?: number;
  /** [minLat, maxLat, minLon, maxLon] as returned by the geocoder. */
  boundingBox?: [string, string, string, string];
  /** Structured address components (house number, road, city, etc.). */
  address?: Record<string, string>;
  /** Link to view the location on OpenStreetMap. */
  mapUrl: string;
}

/**
 * Response payload for the address lookup API.
 */
export interface GeocodeResponse {
  /** The query that was geocoded. */
  query: string;
  /** Number of matches returned. */
  resultCount: number;
  /** Verified matches, best first. */
  results: GeocodeResult[];
  /** Required data attribution string. */
  attribution: string;
}
