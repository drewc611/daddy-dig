# CLAUDE.md - AI Assistant Guide for daddy-dig

## Project Overview

**daddy-dig** is an LLM-powered chat application built on Cloudflare Workers AI. It provides a streaming chat interface with real-time responses, client context injection, and comprehensive security features.

### Tech Stack
- **Runtime**: Cloudflare Workers (serverless edge computing)
- **Language**: TypeScript (strict mode enabled)
- **AI Provider**: Cloudflare Workers AI
- **Testing**: Vitest
- **Build Tool**: Wrangler (Cloudflare Workers CLI)
- **Frontend**: Vanilla HTML/CSS/JavaScript

### Repository Structure

```
/
├── src/
│   ├── index.ts           # Main Worker entry point (routing, handlers, security)
│   ├── types.ts           # TypeScript type definitions
│   └── index.test.ts      # Vitest unit tests
├── public/
│   ├── index.html         # Chat UI (HTML + inline CSS)
│   └── chat.js            # Frontend chat logic
├── wrangler.jsonc         # Cloudflare Worker configuration
├── tsconfig.json          # TypeScript configuration (strict mode)
├── package.json           # Dependencies and scripts
├── worker-configuration.d.ts  # Auto-generated Worker types
└── .gitignore             # Git ignore patterns
```

## Core Architecture

### Request Flow
1. **Static Assets**: `/ => env.ASSETS.fetch()` serves frontend from `public/`
2. **Chat API**: `POST /api/chat => handleChatRequest()` processes messages
3. **AI Streaming**: Workers AI returns streaming JSON via SSE
4. **Security**: All responses pass through `applySecurityHeaders()`

### Key Components

#### Backend (`src/index.ts`)
- **Main Handler**: Routes requests to API endpoints or static assets
- **Chat Handler**: `handleChatRequest()` - validates input, checks rate limits, streams AI responses
- **Security**: Comprehensive security headers, CSP, request validation
- **Rate Limiting**: In-memory sliding window (resets on Worker restart)
- **Client Context**: Injects user timezone, locale, time, and user agent into system prompt

#### Frontend (`public/`)
- **UI**: Single-page chat interface with auto-resizing textarea
- **Streaming**: Processes Server-Sent Events (newline-delimited JSON)
- **Context**: Sends `clientContext` object with each request for time-aware responses
- **State Management**: Client-side chat history array

## Development Workflows

### Local Development
```bash
npm install              # Install dependencies
npm run cf-typegen       # Generate Worker type definitions
npm run dev              # Start local dev server (http://localhost:8787)
npm run check            # TypeScript check + dry-run deploy
npm test                 # Run Vitest tests
```

### Deployment
```bash
npm run deploy           # Deploy to Cloudflare Workers
npx wrangler tail        # View live logs
```

### Git Workflow
- **Feature Branches**: Use `claude/*` prefix (e.g., `claude/add-feature-xyz`)
- **Commits**: Clear, descriptive messages focusing on "what" and "why"
- **Pull Requests**: Always create PRs from feature branches to main

## Critical Conventions for AI Assistants

### 1. Security First
**ALWAYS** maintain security when modifying code:

- **Security Headers**: All responses must go through `applySecurityHeaders()`
  ```typescript
  return applySecurityHeaders(response, {
    isHtml: true,           // Adds CSP for HTML responses
    cacheControl: "no-store" // For API responses
  });
  ```

- **Input Validation**: Validate ALL user inputs
  - Message length: `MAX_MESSAGE_LENGTH` (default: 10,000 chars)
  - Message count: `MAX_MESSAGES` (default: 100)
  - Request body size: `MAX_BODY_BYTES` (default: 1MB)
  - Content-Type: Must be `application/json` for API requests

- **Rate Limiting**: Check rate limits before processing requests
  ```typescript
  if (checkRateLimit(clientIp, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    return 429 response with Retry-After header
  }
  ```

- **Never Skip**: Do NOT bypass security headers, validation, or rate limiting

### 2. Type Safety
- **Strict TypeScript**: All code must pass strict type checking
- **Type Guards**: Use `isChatMessage()` pattern for runtime validation
- **Env Types**: All environment variables defined in `Env` interface
- **No Any**: Avoid `any` type; use `unknown` for dynamic data

### 3. Configuration Management

**Environment Variables** (defined in `wrangler.jsonc` and `src/types.ts`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `MODEL_ID` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Default AI model |
| `MODEL_ALLOWLIST` | Same as MODEL_ID | Comma-separated allowed models |
| `SYSTEM_PROMPT` | Custom daddy persona | System prompt for AI |
| `MAX_MESSAGE_LENGTH` | `10000` | Max characters per message |
| `MAX_MESSAGES` | `100` | Max messages in conversation |
| `MAX_TOKENS` | `1024` | Max AI response tokens |
| `MAX_BODY_BYTES` | `1000000` | Max request body size (bytes) |
| `RATE_LIMIT_REQUESTS` | `20` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (60s) |

**Reading Configuration**:
```typescript
const MODEL_ID = env.MODEL_ID || DEFAULT_MODEL_ID;
const MAX_TOKENS = parsePositiveInt(env.MAX_TOKENS, DEFAULT_MAX_TOKENS);
```

### 4. Client Context Feature

The app sends client context to make responses time-aware:

**Frontend** (`public/chat.js`):
```javascript
function getClientContext() {
  return {
    currentTimeIso: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
    userAgent: navigator.userAgent
  };
}
```

**Backend** (`src/index.ts`):
```typescript
const normalizedClientContext = normalizeClientContext(clientContext);
const contextualSystemPrompt = buildContextualSystemPrompt(
  SYSTEM_PROMPT,
  normalizedClientContext
);
```

**Result**: System prompt is enhanced with real-time context:
```
You are a helpful assistant...

Context:
- Current date/time (from user device): 2026-01-18T10:30:00.000Z
- User time zone: America/New_York
- User locale: en-US
- User agent: Mozilla/5.0...
```

### 5. Testing Requirements

**Test Files**: `src/index.test.ts` using Vitest

**Test Coverage Should Include**:
- ✅ Invalid JSON body handling
- ✅ Message validation (array, roles, content)
- ✅ System prompt injection
- ✅ Client context integration
- ✅ Message length limits
- ✅ Message count limits
- ✅ Rate limiting behavior
- ✅ Custom environment variables
- ✅ Error handling

**Running Tests**:
```bash
npm test                 # Run all tests
npm test -- --watch      # Watch mode
```

**Writing Tests**:
```typescript
import { describe, expect, it, vi } from "vitest";
import { handleChatRequest } from "./index";

it("returns 400 for invalid messages", async () => {
  const request = createRequest({ messages: "invalid" });
  const response = await handleChatRequest(request, mockEnv);
  expect(response.status).toBe(400);
});
```

### 6. Error Handling Patterns

**Always return proper HTTP status codes**:

| Status | Use Case |
|--------|----------|
| `400` | Invalid request (bad JSON, invalid messages, too long) |
| `405` | Method not allowed |
| `413` | Request body too large |
| `415` | Unsupported Media Type (not application/json) |
| `429` | Rate limit exceeded (include `Retry-After` header) |
| `500` | Server error (AI failure, unexpected errors) |

**Error Response Format**:
```typescript
return applySecurityHeaders(
  new Response(
    JSON.stringify({ error: "Descriptive error message" }),
    { status: 400, headers: JSON_HEADERS }
  ),
  { cacheControl: "no-store" }
);
```

### 7. Streaming Response Pattern

**Backend** (Workers AI):
```typescript
const response = await env.AI.run(
  modelToUse,
  {
    messages: normalizedMessages,
    max_tokens: MAX_TOKENS,
  },
  {
    returnRawResponse: true,  // Return streaming response directly
    // gateway: { ... }        // Optional AI Gateway config
  }
);

return applySecurityHeaders(response, { cacheControl: "no-store" });
```

**Frontend** (consuming stream):
```javascript
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value, { stream: true });
  buffer += chunk;

  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    const jsonData = JSON.parse(line);
    if (jsonData.response) {
      responseText += jsonData.response;
      // Update UI
    }
  }
}
```

### 8. Code Style Guidelines

**Formatting**:
- **Indentation**: 2 spaces
- **Quotes**: Double quotes for strings
- **Semicolons**: Required
- **Line Length**: ~80-100 characters preferred

**Comments**:
- Use JSDoc for exported functions
- Explain "why" not "what" for complex logic
- Keep inline comments concise

**Naming**:
- `camelCase` for variables and functions
- `PascalCase` for types and interfaces
- `SCREAMING_SNAKE_CASE` for constants
- Descriptive names (e.g., `handleChatRequest` not `handle`)

**File Organization**:
- Constants at top (after imports)
- Type guards and utilities in middle
- Main logic at bottom
- One primary export per file

### 9. Common Modification Scenarios

#### Adding a New Environment Variable

1. **Define in `src/types.ts`**:
   ```typescript
   export interface Env {
     // ... existing
     NEW_SETTING?: string;
   }
   ```

2. **Add default in `src/index.ts`**:
   ```typescript
   const DEFAULT_NEW_SETTING = "default_value";
   ```

3. **Read in handler**:
   ```typescript
   const NEW_SETTING = env.NEW_SETTING || DEFAULT_NEW_SETTING;
   ```

4. **Update `wrangler.jsonc`**:
   ```jsonc
   "vars": {
     "NEW_SETTING": "production_value"
   }
   ```

5. **Regenerate types**: `npm run cf-typegen`

#### Adding a New API Endpoint

1. **Add route in `src/index.ts` fetch handler**:
   ```typescript
   if (url.pathname === "/api/new-endpoint") {
     if (request.method === "POST") {
       return handleNewRequest(request, env);
     }
     return applySecurityHeaders(
       new Response("Method not allowed", { status: 405 }),
       { cacheControl: "no-store" }
     );
   }
   ```

2. **Implement handler function**:
   ```typescript
   async function handleNewRequest(request: Request, env: Env): Promise<Response> {
     // Validate, process, return with security headers
   }
   ```

3. **Add tests**:
   ```typescript
   describe("handleNewRequest", () => {
     it("returns expected response", async () => {
       // Test implementation
     });
   });
   ```

#### Updating the AI Model

1. **Change in `wrangler.jsonc`**:
   ```jsonc
   "vars": {
     "MODEL_ID": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
   }
   ```

2. **View available models**: [Workers AI Models](https://developers.cloudflare.com/workers-ai/models/)

3. **Deploy**: `npm run deploy`

#### Modifying System Prompt

1. **Update in `wrangler.jsonc`**:
   ```jsonc
   "vars": {
     "SYSTEM_PROMPT": "Your new system prompt here"
   }
   ```

2. **Or update default in `src/index.ts`**:
   ```typescript
   const DEFAULT_SYSTEM_PROMPT = "Your new default prompt";
   ```

3. **Update tests** if prompt behavior changes

### 10. Debugging and Logging

**Local Development**:
```bash
npm run dev              # Logs appear in terminal
```

**Production**:
```bash
npx wrangler tail        # Live log streaming
npx wrangler tail --format json  # JSON format
```

**Console Logging**:
```typescript
console.log("Info message");
console.error("Error message:", error);
console.warn("Warning message");
```

**Observability**: Enabled in `wrangler.jsonc`:
```jsonc
"observability": {
  "enabled": true
}
```

## Important Notes for AI Assistants

### DO:
✅ Validate ALL user inputs before processing
✅ Apply security headers to ALL responses
✅ Check rate limits before expensive operations
✅ Use type guards for runtime type checking
✅ Parse environment variables with defaults
✅ Include client context for time-sensitive responses
✅ Write tests for new functionality
✅ Follow existing code patterns and conventions
✅ Return proper HTTP status codes
✅ Add descriptive comments for complex logic

### DON'T:
❌ Remove or bypass security headers
❌ Skip input validation
❌ Use `any` type in TypeScript
❌ Hardcode configuration values (use env vars)
❌ Ignore rate limiting
❌ Forget to regenerate types after schema changes
❌ Deploy without running tests
❌ Commit sensitive data or secrets
❌ Modify security-critical code without careful review
❌ Break streaming response format

## Quick Reference Commands

```bash
# Development
npm install              # First-time setup
npm run cf-typegen       # Generate types (after env changes)
npm run dev              # Local dev server
npm run check            # Type check + dry-run deploy
npm test                 # Run tests

# Deployment
npm run deploy           # Deploy to production
npx wrangler tail        # View live logs
npx wrangler whoami      # Check logged-in account

# Git
git checkout -b claude/feature-name    # Create feature branch
git add .                              # Stage changes
git commit -m "Clear message"          # Commit
git push -u origin claude/feature-name # Push feature branch
```

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Workers AI Docs](https://developers.cloudflare.com/workers-ai/)
- [Workers AI Models](https://developers.cloudflare.com/workers-ai/models/)
- [AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [Vitest Docs](https://vitest.dev/)

## Project-Specific Context

### The "Daddy" Persona
This chatbot uses a custom persona called "daddy" with specific identity responses:
- First identity question: "hi I'm your daddy. I'm here to help you as your daddy. How can daddy help you"
- Subsequent questions: "I'm here to be a daddy and to help you."

**Important**: When modifying the system prompt, preserve this identity pattern as it's core to the application's personality.

### Recent Changes (Git History Context)
- ✅ Client context feature added for time-aware responses
- ✅ Security headers hardened (CSP, CORP, COEP, etc.)
- ✅ Request body size limits enforced
- ✅ Model visibility removed from UI
- ✅ UI refresh with presence status indicators

When making changes, consider how they interact with these recent improvements.

---

**Last Updated**: 2026-01-18
**Maintainer**: AI assistants working on daddy-dig
**Version**: 1.0.0
