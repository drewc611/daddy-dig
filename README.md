# LLM Chat Application Template

A simple, ready-to-deploy chat application template powered by Cloudflare Workers AI. This template provides a clean starting point for building AI chat applications with streaming responses.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/llm-chat-app-template)

<!-- dash-content-start -->

## Demo

This template demonstrates how to build an AI-powered chat interface using Cloudflare Workers AI with streaming responses. It features:

- Real-time streaming of AI responses using Server-Sent Events (SSE)
- Easy customization of models and system prompts
- Support for AI Gateway integration
- Clean, responsive UI that works on mobile and desktop

## Features

- 💬 Simple and responsive chat interface
- ⚡ Server-Sent Events (SSE) for streaming responses
- 🧠 Powered by Cloudflare Workers AI LLMs
- 🛠️ Built with TypeScript and Cloudflare Workers
- 📱 Mobile-friendly design
- 🔄 Maintains chat history on the client
- 🔎 Built-in Observability logging
<!-- dash-content-end -->

## Directions (Start-to-Finish)

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or newer)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- A Cloudflare account with Workers AI access

### Installation (one-time setup)

1. Clone this repository:

   ```bash
   git clone https://github.com/cloudflare/templates.git
   cd templates/llm-chat-app
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Generate Worker type definitions:
   ```bash
   npm run cf-typegen
   ```

### Configure the system

1. Open `wrangler.jsonc` and confirm:
   - `MODEL_ID` is set to the model you want.
   - Any environment variables you need are defined for dev and production.
2. (Optional) Enable the model switcher by setting `MODEL_ALLOWLIST` to a comma-separated list of models.
3. (Optional) Update the system prompt in `src/index.ts` to define the assistant’s behavior.

### Development (local run)

Start a local development server:

```bash
npm run dev
```

This will start a local server at http://localhost:8787.

Note: Using Workers AI accesses your Cloudflare account even during local development, which will incur usage charges.

### Deployment (go live)

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

### Monitor (operations)

View real-time logs associated with any deployed Worker:

```bash
npm wrangler tail
```

## Project Structure

```
/
├── public/             # Static assets
│   ├── index.html      # Chat UI HTML
│   └── chat.js         # Chat UI frontend script
├── src/
│   ├── index.ts        # Main Worker entry point
│   └── types.ts        # TypeScript type definitions
├── test/               # Test files
├── wrangler.jsonc      # Cloudflare Worker configuration
├── tsconfig.json       # TypeScript configuration
└── README.md           # This documentation
```

## How It Works

### System Architecture (What We Bought & How It Fits Together)

This system is a complete chat application stack that includes:

1. **Frontend UI** (browser): A responsive chat interface served from `public/` that captures user input and renders streaming responses.
2. **API/Worker** (Cloudflare Workers): A serverless backend in `src/index.ts` that receives chat messages and streams responses via SSE.
3. **LLM Provider** (Workers AI): The model runtime accessed through the Workers AI binding, configured in `wrangler.jsonc`.
4. **Optional AI Gateway**: Adds caching, rate limiting, and analytics when enabled in the Worker.

**Data flow**

1. User sends a message in the browser UI.
2. The UI POSTs to `/api/chat`.
3. The Worker forwards the request to Workers AI and streams tokens back using SSE.
4. The UI renders the streaming response in real time.

### Backend

The backend is built with Cloudflare Workers and uses the Workers AI platform to generate responses. The main components are:

1. **API Endpoint** (`/api/chat`): Accepts POST requests with chat messages and streams responses
2. **Streaming**: Uses Server-Sent Events (SSE) for real-time streaming of AI responses
3. **Workers AI Binding**: Connects to Cloudflare's AI service via the Workers AI binding

### Frontend

The frontend is a simple HTML/CSS/JavaScript application that:

1. Presents a chat interface
2. Sends user messages to the API
3. Processes streaming responses in real-time
4. Maintains chat history on the client side

## Customization

### Changing the Model

To use a different AI model, update the `MODEL_ID` variable in `wrangler.jsonc` (or set it as a Worker environment variable). You can find available models in the [Cloudflare Workers AI documentation](https://developers.cloudflare.com/workers-ai/models/).

To allow users to upgrade or switch models from the UI:

1. Set a comma-separated allowlist in `MODEL_ALLOWLIST`, for example:
   ```
   MODEL_ALLOWLIST="@cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/meta/llama-3.1-70b-instruct"
   ```
2. Deploy the Worker. The UI will fetch `/api/config` and populate the model picker with the allowlisted models.
3. Select the desired model in the UI before sending messages.

### Using AI Gateway

The template includes commented code for AI Gateway integration, which provides additional capabilities like rate limiting, caching, and analytics.

To enable AI Gateway:

1. [Create an AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway) in your Cloudflare dashboard
2. Uncomment the gateway configuration in `src/index.ts`
3. Replace `YOUR_GATEWAY_ID` with your actual AI Gateway ID
4. Configure other gateway options as needed:
   - `skipCache`: Set to `true` to bypass gateway caching
   - `cacheTtl`: Set the cache time-to-live in seconds

Learn more about [AI Gateway](https://developers.cloudflare.com/ai-gateway/).

### Modifying the System Prompt

The default system prompt can be changed by updating the `SYSTEM_PROMPT` constant in `src/index.ts`. The server always prepends it; `system` messages sent by clients are dropped.

### Rate Limiting

`/api/chat` and `/api/address-lookup` are limited per client IP, using only the `CF-Connecting-IP` header that Cloudflare's edge sets. `X-Forwarded-For` is ignored because a client can set it. Requests without `CF-Connecting-IP` (for example local dev) share one bucket.

By default the limit is an in-memory counter (`RATE_LIMIT_REQUESTS` per `RATE_LIMIT_WINDOW_MS`). It is per isolate and resets when the isolate is evicted, so treat it as best-effort protection against casual abuse, not a hard cost cap.

For a stronger limit, add a [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) named `RATE_LIMITER` to `wrangler.jsonc`. The Worker uses it automatically when present and falls back to the in-memory counter if it is absent or errors:

```jsonc
"ratelimits": [
  {
    "name": "RATE_LIMITER",
    "namespace_id": "<a positive integer unused in your Cloudflare account>",
    "simple": { "limit": 20, "period": 60 }
  }
]
```

`namespace_id` must be unique within your account, so it is not set in this repository. `period` must be 10 or 60. Cloudflare counts per location, so the limit is per location rather than global. A global cap needs a Durable Object counter, which this project does not include. To cap Workers AI spend, also set a usage limit or alert on the Cloudflare account.

### Styling

The UI styling is contained in the `<style>` section of `public/index.html`. You can modify the CSS variables at the top to quickly change the color scheme.

## Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers AI Documentation](https://developers.cloudflare.com/workers-ai/)
- [Workers AI Models](https://developers.cloudflare.com/workers-ai/models/)
