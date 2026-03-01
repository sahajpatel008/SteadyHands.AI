# SteadyHands.AI

Desktop accessibility assistant for seniors:

- Right side: live Chromium browser inside the app (`webview`)
- Left side: AI sidebar with simplified page purpose, choices, and agent timeline
- Shared control: user can browse directly, AI can also click/type/navigate

## Stack

- Electron + React + TypeScript
- Gemini 2.5 Flash (planner + summarizer)
- Observe -> Plan -> Act -> Verify loop
- Strict env-driven runtime config (no hardcoded model IDs or API keys)

## Environment setup

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

Required values:

- `GOOGLE_GENERATIVE_AI_API_KEY`
- `STEADYHANDS_PLANNER_MODEL`
- `STEADYHANDS_SUMMARIZER_MODEL`
- `STEADYHANDS_MAX_STEPS`
- `STEADYHANDS_AGENT_MODE_DEFAULT`
- `STEADYHANDS_OBSERVE_TEXT_LIMIT`
- `STEADYHANDS_ACTION_TIMEOUT_MS`
- `STEADYHANDS_VERIFY_TIMEOUT_MS`
- `STEADYHANDS_MAX_RETRIES_PER_STEP`
- `STEADYHANDS_ENABLE_COORDINATE_FALLBACK`
- `STEADYHANDS_ENABLE_AUTO_HIGHLIGHT`
- `STEADYHANDS_LOG_LEVEL`
- `STEADYHANDS_REQUIRE_APPROVAL_FOR_RISKY_ACTIONS`
- `STEADYHANDS_CONFIDENCE_THRESHOLD`
- Optional: `STEADYHANDS_FAST_PLANNER_MODEL` (lower-latency planner model)
- Optional: `STEADYHANDS_TURBO_MODE` (`true` by default)
- Optional: `STEADYHANDS_MCP_SERVERS` (JSON map of MCP stdio servers)

Example MCP config:

```json
{
  "exa": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "exa-mcp-server"],
    "env": { "EXA_API_KEY": "..." }
  },
  "remote_research": {
    "transport": "http",
    "url": "https://your-mcp-host.example.com/mcp"
  }
}
```

## Run

Install dependencies:

```bash
npm install
```

Start development app:

```bash
npm run dev
```

Build:

```bash
npm run build
```
