# Changelog: Per-file changes

## shared/isRiskyAction.ts (NEW)
- Extracted `isRiskyAction` helper from App.tsx into shared module
- Detects payment/checkout/transfer actions for HITL approval

## electron/main/agentRunner.ts (NEW)
- Runs agent graph in main process (avoids LangGraph node:async_hooks in renderer)
- IPC handlers: request observe, act, goBack, canGoBack, askUser from renderer
- setupAgentIpcHandlers wires agent to webContents and MCP manager

## src/lib/agentGraphLangGraph.ts (NEW)
- LangGraph-based agent loop (planNode, executeNode, checkControls)
- Replaces inline loop in agentGraph.ts
- 5s wait after landing on new page; go-back only when no forward route
- Capped timeline/executedActions to prevent RangeError

## electron/main/llm.ts
- Added resolveUserChoiceToIndex: maps natural-language answer to choice index via LLM
- Semantic reasoning for "the first one", "search", "click continue", etc.

## electron/main/index.ts
- Import and call setupAgentIpcHandlers after setupIpcHandlers
- Pass webContents getter and mcpManager to agent runner

## electron/preload/index.ts
- Agent IPC listeners: agent:requestObserve, requestAct, requestGoBack, requestCanGoBack, requestAskUser
- registerAgentHandlers, runAgent, abortAgent exposed on window.steadyhands

## src/types/global.d.ts
- Added ActionExecutionResult import
- Added registerAgentHandlers, runAgent, abortAgent to steadyhands API types

## src/lib/agentGraph.ts
- Refactored: buildAgentGraph from agentGraphLangGraph, runAgentGraph delegates
- Exported GraphDeps, LoopState, pushTimeline, withTimeout, getObservationFingerprint, etc.
- Added resolveUserChoice optional dep for semantic choice resolution

## src/App.tsx
- Agent runs via window.steadyhands.runAgent() (main process) instead of runAgentGraph (renderer)
- Reset browser to Google per prompt; register agent handlers before run
- Removed intent confirmation flow (pendingIntentConfirmation, pendingIntentRefine)
- Use shared isRiskyAction; runIdRef instead of abortControllerRef

## src/components/AssistantPanel.tsx
- Removed intent confirmation UI (confirmCard, onProceedIntent, onRefineIntent, etc.)
- Removed pendingIntentConfirmation, pendingIntentRefine props and handlers
- Simplified input state: only goal vs pendingQuestion

## src/lib/actionExecutor.ts
- Always press Enter after typing into input (was google.com-only)
- Use form.requestSubmit or keydown/keypress/keyup Enter on any site

## tests/agentGraph.test.cjs
- Added resolveUserChoice mock to baseDeps (yes/no semantic mapping)
