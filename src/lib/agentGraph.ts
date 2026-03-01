import { logRenderer } from "../../shared/logger";
import {
  ActionExecutionResult,
  AgentRunInput,
  AgentRunOutput,
  AgentTimelineEvent,
  BrowserAction,
  McpToolCall,
  McpToolCallResult,
  McpToolDescriptor,
  PageObservation,
  PageSummary,
  PlanActionInput,
  PlanActionResult,
  SafetyValidationResult,
  SidebarChoice,
} from "../../shared/types";
import { choiceToAction } from "./choiceAction";
import { buildAgentGraph } from "./agentGraphLangGraph";

export type GraphDeps = {
  inferIntent: (rawGoal: string) => Promise<{
    inferredGoal: string;
    plan: string;
    planSteps?: string[];
    completion_point?: string;
    searchQuery?: string;
  }>;
  observe: () => Promise<PageObservation>;
  semanticInterpreter: (
    observation: PageObservation,
    userGoal: string,
    opts?: { searchQuery?: string },
  ) => Promise<PageSummary & { current_step?: string }>;
  plan: (input: PlanActionInput) => Promise<PlanActionResult>;
  safetySupervisor: (
    userGoal: string,
    action: BrowserAction,
    context: { url: string; currentStep?: string },
  ) => Promise<SafetyValidationResult>;
  act: (action: BrowserAction) => Promise<ActionExecutionResult>;
  goBack?: () => void;
  canGoBack?: () => boolean;
  /** Check if current page is relevant to goal; if false after navigate/click, agent will go back. */
  isPageRelevantToGoal?: (
    observation: PageObservation,
    goal: string,
    opts?: { planSteps?: string[]; planStepIndex?: number },
  ) => Promise<boolean>;
  /** Check if goal is fully achieved on this page; if true, agent stops immediately. */
  isGoalAchieved?: (observation: PageObservation, goal: string) => Promise<boolean>;
  /** Check if current page matches completion_point from inferIntent; if true, agent stops. */
  isAtCompletionPoint?: (
    observation: PageObservation,
    completionPoint: string,
  ) => Promise<boolean>;
  listMcpTools: () => Promise<McpToolDescriptor[]>;
  callMcpTool: (call: McpToolCall) => Promise<McpToolCallResult>;
  askUser: (question: string) => Promise<string | null>;
  /** Map user's natural-language answer to choice index (1-based). When absent, only heuristic matching is used. */
  resolveUserChoice?: (
    answer: string,
    choices: SidebarChoice[],
    question?: string,
  ) => Promise<number | null>;
  isRiskyForHITL: (action: BrowserAction) => boolean;
  maxSteps: number;
  actionTimeoutMs: number;
  verifyTimeoutMs: number;
  maxRetriesPerStep: number;
  fastMode: boolean;
  enableSafetyGuardrails: boolean;
  requireApprovalForRiskyActions: boolean;
  /** Called in real-time as each timeline event is emitted */
  onEvent?: (kind: AgentTimelineEvent["kind"], message: string) => void;
};

export type LoopToolCall =
  | {
      kind: "ask_user";
      question: string;
      reason: string;
    }
  | {
      kind: "execute_action";
      action: BrowserAction;
      source: string;
      label?: string;
      choiceIndex?: number;
    }
  | {
      kind: "execute_mcp";
      call: McpToolCall;
      source: string;
    };

export type LoopState = {
  goal: string;
  searchQuery?: string;
  /** Final state from inferIntent; when reached, agent stops. */
  completion_point?: string;
  /** Queued plan steps. Planner focuses on planStepIndex. */
  planSteps: string[];
  planStepIndex: number;
  mode: "manual" | "assist" | "auto";
  observation: PageObservation;
  observationFingerprint: string;
  lastSemanticFingerprint: string;
  availableActions: SidebarChoice[];
  availableMcpTools: McpToolDescriptor[];
  currentStep: string;
  summary: PageSummary | null;
  timeline: AgentTimelineEvent[];
  steps: number;
  completed: boolean;
  finalAnswer: string;
  compactedContext: string;
  contextLedger: string[];
  actionFailureStreak: Record<string, number>;
  noProgressCycles: number;
  noProgressFallbacks: number;
  stallCycles: number;
  lastOfferedChoiceIndex: number | null;
  prefetchedSemanticPromise: Promise<(PageSummary & { current_step?: string })> | null;
  prefetchedSemanticFingerprint: string | null;
  decisionCache: Map<string, LoopToolCall>;
  /** Timer-based loop detection: fingerprint we've been stuck on. */
  pageStuckFingerprint: string | null;
  /** When we first saw this fingerprint (ms). */
  pageStuckSince: number | null;
  /** Step count when we first got stuck on this page. */
  stepsWhenPageStuck: number;
  /** Full sequence of browser actions executed this run (for path storage). */
  executedActions: BrowserAction[];
  /** URLs we navigated to that were irrelevant; skip when picking next search result. */
  triedDestinationUrls: Set<string>;
  metrics: {
    semanticCalls: number;
    planCalls: number;
    safetyCalls: number;
    mcpCalls: number;
    fastPathDecisions: number;
    planCacheHits: number;
    stepDurationsMs: number[];
  };
};

export const LOOP_STUCK_MS = 5000;
export const LOOP_GOBACK_WAIT_MS = 2000;

type ActionRunResult = {
  ok: boolean;
  timeline: AgentTimelineEvent[];
  lastMessage: string;
  reason: "ok" | "target_not_found" | "failure";
};

const COMPACTION_TRIGGER_TOKENS = 5000;
const COMPACTION_KEEP_RECENT_ITEMS = 24;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

// Module-level sink so the pure pushTimeline helper can fire realtime callbacks
let _activeOnEvent: ((kind: AgentTimelineEvent["kind"], message: string) => void) | undefined;

export function pushTimeline(
  timeline: AgentTimelineEvent[],
  kind: AgentTimelineEvent["kind"],
  message: string,
): AgentTimelineEvent[] {
  _activeOnEvent?.(kind, message);
  return [
    ...timeline,
    {
      ts: new Date().toISOString(),
      kind,
      message,
    },
  ];
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function getObservationFingerprint(observation: PageObservation): string {
  const elementSlice = observation.elements
    .slice(0, 24)
    .map((el) => `${el.id}|${el.tag}|${el.role ?? ""}|${el.text ?? ""}`)
    .join(";");
  const textSlice = observation.mainText.slice(0, 1200);
  return `${observation.url}::${observation.title}::${observation.elements.length}::${textSlice}::${elementSlice}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function compactLines(lines: string[]): string {
  const compacted = lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((line) => (line.length > 180 ? `${line.slice(0, 180)}...` : line))
    .join("\n");
  return compacted.slice(-6000);
}

export function describeAction(action: BrowserAction): string {
  if (action.type === "click") return `click ${action.elementId}`;
  if (action.type === "type") return `type \"${action.text}\" into ${action.elementId}`;
  if (action.type === "select") return `select \"${action.value}\" in ${action.elementId}`;
  if (action.type === "scroll") return `scroll ${action.elementId}`;
  return `navigate ${action.url}`;
}

export function getActionSignature(action: BrowserAction): string {
  if (action.type === "click") return `click:${action.elementId}`;
  if (action.type === "type") return `type:${action.elementId}:${action.text}`;
  if (action.type === "select") return `select:${action.elementId}:${action.value}`;
  if (action.type === "scroll") return `scroll:${action.elementId}`;
  return `navigate:${action.url}`;
}

function getToolManifest(
  choices: SidebarChoice[],
  mcpTools: McpToolDescriptor[],
): string {
  const baseTools = [
    "ask_user(question): ask a short clarification in chat",
    "execute_action(action): execute browser click/type/select/scroll/navigate",
    "execute_mcp(call): execute MCP tool call for external data/workflows",
  ];
  const optionTools = choices
    .map((choice, index) => {
      const executable = choiceToAction(choice);
      return `${index + 1}. ${choice.label} | executable=${executable ? "yes" : "no"} | actionType=${choice.actionType ?? "-"} | elementId=${choice.elementId ?? "-"}`;
    })
    .join("\n");
  const mcpLines = mcpTools
    .map((tool, index) => {
      return `${index + 1}. ${tool.server}/${tool.name} | ${tool.description ?? "-"}`;
    })
    .join("\n");

  return `${baseTools.join("\n")}\nsidebar_options:\n${optionTools || "(none)"}\nmcp_tools:\n${mcpLines || "(none)"}`;
}

export function shortQuestion(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Choose next option.";
  const firstSentence = cleaned.split(/[.!?]/)[0]?.trim() || cleaned;
  const words = firstSentence.split(" ").filter(Boolean);
  return words.slice(0, 14).join(" ") + (words.length > 14 ? "?" : "");
}

export function isConfirmationQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  return (
    /\b(confirm|proceed|sure|yes\/no|are you sure)\b/.test(lower) ||
    /\?.*\b(yes|no)\b/i.test(question)
  );
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 24);
}

export function getDecisionCacheKey(state: LoopState): string {
  const actionSig = state.availableActions
    .slice(0, 8)
    .map((choice) => {
      const action = choiceToAction(choice);
      if (!action) return `${choice.label}:none`;
      return `${choice.label}:${getActionSignature(action)}`;
    })
    .join("|");
  return `${state.observationFingerprint}::${state.currentStep}::${state.goal.slice(0, 220)}::${actionSig}`;
}

function deriveGoalQuery(goal: string): string {
  const firstLine = goal.split("\n").map((line) => line.trim()).find(Boolean) ?? goal;
  return firstLine.replace(/^user clarification:\s*/i, "").slice(0, 140);
}

export function detectStuckLoop(state: LoopState): boolean {
  const fp = state.observationFingerprint;
  const now = Date.now();
  if (state.pageStuckFingerprint !== fp) {
    return false;
  }
  if (state.pageStuckSince == null) return false;
  const stuckMs = now - state.pageStuckSince;
  const stepsIncreased = state.steps > state.stepsWhenPageStuck;
  return stuckMs >= LOOP_STUCK_MS && stepsIncreased;
}

export function pickDeterministicAction(
  state: LoopState,
  excludeChoiceIndices?: Set<number>,
): { action: BrowserAction; label?: string; choiceIndex?: number; source: string } | null {
  const executable = state.availableActions
    .map((choice, index) => ({
      choice,
      index: index + 1,
      action: choiceToAction(choice),
    }))
    .filter((entry): entry is { choice: SidebarChoice; index: number; action: BrowserAction } => !!entry.action)
    .filter((entry) => !excludeChoiceIndices?.has(entry.index));

  if (executable.length === 0) return null;
  if (executable.length === 1) {
    return {
      action: executable[0].action,
      label: executable[0].choice.label,
      choiceIndex: executable[0].index,
      source: "deterministic single executable option",
    };
  }

  const url = state.observation.url.toLowerCase();
  const goalLower = state.goal.toLowerCase();
  const query = deriveGoalQuery(state.goal);

    if (url.includes("google.com") && /flight|search|find|book|ticket|from|to/.test(goalLower)) {
    const hasTypedRecently = state.timeline
      .slice(-8)
      .some((event) => event.kind === "act" && /Typed into/i.test(event.message));
      if (!hasTypedRecently) {
        const typeCandidate = executable.find((entry) => {
          if (entry.action.type !== "type") return false;
          const text = `${entry.choice.label} ${entry.choice.rationale} ${entry.choice.suggestedAction}`.toLowerCase();
          return /search|google|flight|find/.test(text);
        });
        if (typeCandidate && typeCandidate.action.type === "type") {
          return {
            action: {
              type: "type",
              elementId: typeCandidate.action.elementId,
              text: query,
            },
            label: typeCandidate.choice.label,
            choiceIndex: typeCandidate.index,
            source: "deterministic google search typing",
        };
      }
    }

    const clickCandidate = executable.find((entry) => {
      if (entry.action.type !== "click") return false;
      const text = `${entry.choice.label} ${entry.choice.rationale} ${entry.choice.suggestedAction}`.toLowerCase();
      return /search|submit|go|find/.test(text);
    });
    if (clickCandidate) {
      return {
        action: clickCandidate.action,
        label: clickCandidate.choice.label,
        choiceIndex: clickCandidate.index,
        source: "deterministic google search submit",
      };
    }
  }

  // When on search results page: pick first organic result (external link), skip already-tried URLs
  if (/\/search/i.test(url) && executable.length >= 1) {
    const linkEntries = executable
      .filter((e) => {
        if (e.action.type !== "click") return false;
        const href = getChoiceDestinationUrl(e.choice, state.observation.elements);
        if (!href) return false;
        if (!isOrganicLink(href)) return false;
        const normalized = normalizeUrlForTried(href);
        if (state.triedDestinationUrls.has(normalized)) return false;
        return true;
      })
      .sort((a, b) => {
        const idxA = state.observation.elements.findIndex((el) => el.id === a.choice.elementId);
        const idxB = state.observation.elements.findIndex((el) => el.id === b.choice.elementId);
        return idxA - idxB;
      });
    if (linkEntries.length > 0) {
      return {
        action: linkEntries[0].action,
        label: linkEntries[0].choice.label,
        choiceIndex: linkEntries[0].index,
        source: "deterministic first search result",
      };
    }
    // Exhausted organic results - return null so caller can go back
  }

  const tokens = tokenize(state.goal);
  const scored = executable
    .map((entry) => {
      const haystack = `${entry.choice.label} ${entry.choice.rationale} ${entry.choice.suggestedAction} ${entry.choice.actionValue ?? ""}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += 3;
      }
      if (entry.action.type === "navigate") {
        const url = (entry.choice.actionValue ?? "").toLowerCase();
        const urlRelevant = tokens.some((t) => url.includes(t));
        score += urlRelevant ? 4 : 0;
      }
      const failurePenalty = state.actionFailureStreak[getActionSignature(entry.action)] ?? 0;
      return { ...entry, score: score - failurePenalty * 4 };
    })
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  if (scored[0].score <= 0) return null;
  const secondScore = scored[1]?.score ?? -999;
  if (scored[0].score - secondScore < 2) return null;

  return {
    action: scored[0].action,
    label: scored[0].choice.label,
    choiceIndex: scored[0].index,
    source: "deterministic relevance-ranked option",
  };
}

export function buildPromptGoal(state: LoopState, _input: AgentRunInput): string {
  const recentUserNotes = state.contextLedger
    .filter((line) => line.startsWith("user:") || line.startsWith("tool_result:"))
    .slice(-4)
    .join("\n");
  const compactContext = state.compactedContext ? state.compactedContext.slice(-1200) : "";
  const parts: string[] = [
    state.goal.slice(0, 1200),
    `Current page step: ${state.currentStep || "Unknown"}`,
    `Current URL: ${state.observation.url}`,
  ];
  if (state.planSteps.length > 0) {
    const idx = Math.min(state.planStepIndex, state.planSteps.length - 1);
    const currentPlanStep = state.planSteps[idx];
    const fullQueue = state.planSteps
      .map((s, i) => `${i + 1}. ${s}${i === idx ? " <-- CURRENT" : ""}`)
      .join("\n");
    parts.push(
      `\nPlan queue (reference before each decision):\n${fullQueue}\n\nSelect the action that achieves the CURRENT step.`,
    );
  }
  if (recentUserNotes) parts.push(`Recent notes:\n${recentUserNotes}`);
  if (compactContext) parts.push(`Compact context:\n${compactContext}`);
  return parts.filter(Boolean).join("\n\n");
}

export function resolveToolCallFromPlan(
  plan: PlanActionResult,
  availableActions: SidebarChoice[],
  availableMcpTools: McpToolDescriptor[],
): LoopToolCall {
  if (plan.done) {
    return {
      kind: "ask_user",
      question: "Planner returned done unexpectedly. Confirm next option.",
      reason: "internal_mismatch",
    };
  }

  if (plan.askQuestion) {
    return {
      kind: "ask_user",
      question: plan.askQuestion,
      reason: "planner_ask",
    };
  }

  const executableCount = availableActions.filter((choice) => !!choiceToAction(choice)).length;

  if (plan.selectedChoiceIndex != null) {
    const selectedIndex = plan.selectedChoiceIndex - 1;
    const selectedChoice = availableActions[selectedIndex];

    if (!selectedChoice) {
      return {
        kind: "ask_user",
        question: "Which option would you like? Describe what you want to do.",
        reason: "invalid_option",
      };
    }

    const selectedAction = choiceToAction(selectedChoice);
    if (!selectedAction) {
      return {
        kind: "ask_user",
        question: "That option cannot run. Which other option would you prefer? Describe what you want.",
        reason: "non_executable_option",
      };
    }

    return {
      kind: "execute_action",
      action: selectedAction,
      source: `selected option ${plan.selectedChoiceIndex}`,
      label: selectedChoice.label,
      choiceIndex: plan.selectedChoiceIndex,
    };
  }

  if (plan.mcpToolCall) {
    const exists = availableMcpTools.some(
      (tool) =>
        tool.server === plan.mcpToolCall?.server &&
        tool.name === plan.mcpToolCall?.name,
    );
    if (!exists) {
      return {
        kind: "ask_user",
        question: "That tool is unavailable. Which option would you like instead? Describe what you want to do.",
        reason: "unknown_mcp_tool",
      };
    }

    return {
      kind: "execute_mcp",
      call: plan.mcpToolCall,
      source: `mcp ${plan.mcpToolCall.server}/${plan.mcpToolCall.name}`,
    };
  }

  if (plan.action) {
    if (executableCount > 0) {
      return {
        kind: "ask_user",
        question: "Which option would you like? Describe what you want to do.",
        reason: "raw_action_while_options_exist",
      };
    }

    return {
      kind: "execute_action",
      action: plan.action,
      source: "fallback raw action",
    };
  }

  return {
    kind: "ask_user",
    question: "Which option would you like me to run? Describe what you want.",
    reason: "no_action",
  };
}

export function maybeCompactContext(state: LoopState): LoopState {
  const combined = `${state.compactedContext}\n${state.contextLedger.join("\n")}`;
  if (estimateTokens(combined) <= COMPACTION_TRIGGER_TOKENS) {
    return state;
  }

  const cut = Math.max(0, state.contextLedger.length - COMPACTION_KEEP_RECENT_ITEMS);
  if (cut <= 0) return state;

  const oldItems = state.contextLedger.slice(0, cut);
  const recent = state.contextLedger.slice(cut);
  const chunkSummary = compactLines(oldItems);
  const compactedContext = compactLines([state.compactedContext, chunkSummary].filter(Boolean));

  return {
    ...state,
    compactedContext,
    contextLedger: recent,
    timeline: pushTimeline(
      state.timeline,
      "summary",
      `Compacted context (${oldItems.length} items) to keep planning fast.`,
    ),
  };
}

export function getNavigateFallbackAction(state: LoopState): BrowserAction | null {
  const goal = state.goal.toLowerCase();
  const url = state.observation.url.toLowerCase();
  const query = state.searchQuery ?? deriveGoalQuery(state.goal);
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query.slice(0, 120))}`;

  if (/flight|ticket|airline|travel/.test(goal)) {
    if (!url.includes("google.com/travel/flights")) {
      return { type: "navigate", url: "https://www.google.com/travel/flights" };
    }
    return { type: "navigate", url: "https://www.skyscanner.com" };
  }

  // On Google with no progress: try direct search URL
  if (url.includes("google.com") && state.noProgressCycles >= 2) {
    return { type: "navigate", url: searchUrl };
  }

  // On a completely different site with no progress: first we tried the page's search/links;
  // can't go anywhere, so go to Google and start there.
  if (!url.includes("google.com") && state.noProgressCycles >= 2) {
    return { type: "navigate", url: searchUrl };
  }

  return null;
}

export function normalizeUrlForTried(url: string): string {
  return url.replace(/\/$/, "").toLowerCase().trim();
}

function getChoiceDestinationUrl(choice: SidebarChoice, elements: { id: string; href: string | null }[]): string | null {
  if (!choice.elementId) return null;
  const el = elements.find((e) => e.id === choice.elementId);
  return el?.href ?? null;
}

/** True if href points to external site (not Google-owned). */
function isOrganicLink(href: string): boolean {
  const lower = href.toLowerCase();
  return !/google\.com|\.google\.|ai\.google|youtube\.|gstatic\.|gmail\.|googleapis\./i.test(lower);
}

/** On search page: get first organic link from DOM (elements are in DOM order). Bypasses semantic choices. */
export function getFirstOrganicLinkFromPage(
  state: LoopState,
): { action: BrowserAction; label: string; elementId: string } | null {
  const elements = state.observation.elements;
  for (const el of elements) {
    const href = el.href;
    if (!href) continue;
    if (el.tag !== "a" && el.role !== "link") continue;
    if (!isOrganicLink(href)) continue;
    const normalized = normalizeUrlForTried(href);
    if (state.triedDestinationUrls.has(normalized)) continue;
    const label = [el.text, el.ariaLabel].filter(Boolean).join(" ").trim().slice(0, 80) || href;
    return {
      action: { type: "click" as const, elementId: el.id },
      label,
      elementId: el.id,
    };
  }
  return null;
}

export async function executeActionWithRetries(
  deps: GraphDeps,
  action: BrowserAction,
  timeline: AgentTimelineEvent[],
): Promise<ActionRunResult> {
  const totalAttempts = deps.maxRetriesPerStep + 1;
  let nextTimeline = timeline;
  let lastMessage = "";

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    let result: ActionExecutionResult;
    try {
      result = await withTimeout(
        deps.act(action),
        deps.actionTimeoutMs,
        `Action timed out after ${deps.actionTimeoutMs}ms`,
      );
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error ? error.message : `Action failed on attempt ${attempt}`,
        action,
      };
    }

    lastMessage = result.message;
    nextTimeline = pushTimeline(
      nextTimeline,
      "act",
      `Attempt ${attempt}/${totalAttempts}: ${result.message}`,
    );

    if (result.ok) {
      return { ok: true, timeline: nextTimeline, lastMessage, reason: "ok" };
    }

    if (/Target element not found/i.test(result.message)) {
      return {
        ok: false,
        timeline: nextTimeline,
        lastMessage,
        reason: "target_not_found",
      };
    }
  }

  return { ok: false, timeline: nextTimeline, lastMessage, reason: "failure" };
}

export async function refreshObservationAndSemantic(
  deps: GraphDeps,
  state: LoopState,
  reason: string,
): Promise<LoopState> {
  try {
    const prevFingerprint = state.observationFingerprint;
    const observed = await withTimeout(
      deps.observe(),
      deps.verifyTimeoutMs,
      `Refresh timed out after ${deps.verifyTimeoutMs}ms`,
    );
    const fingerprint = getObservationFingerprint(observed);
    const semantic = await deps.semanticInterpreter(observed, state.goal, {
      searchQuery: /google\.com/i.test(observed.url) ? state.searchQuery : undefined,
    });
    const noProgressCycles = fingerprint === prevFingerprint ? state.noProgressCycles + 1 : 0;

    return {
      ...state,
      observation: observed,
      observationFingerprint: fingerprint,
      lastSemanticFingerprint: fingerprint,
      summary: semantic,
      availableActions: semantic.choices ?? [],
      currentStep: semantic.current_step ?? observed.title,
      prefetchedSemanticPromise: null,
      prefetchedSemanticFingerprint: null,
      noProgressCycles,
      timeline: pushTimeline(
        state.timeline,
        "observe",
        `Observed ${observed.elements.length} actionable elements on ${observed.url} (${reason})`,
      ),
      contextLedger: [
        ...state.contextLedger,
        `observe: ${observed.url} (${observed.elements.length} elements, reason=${reason})`,
        `semantic: step=${semantic.current_step ?? observed.title}, choices=${semantic.choices?.length ?? 0}`,
      ],
    };
  } catch (error) {
    return {
      ...state,
      timeline: pushTimeline(
        state.timeline,
        "plan",
        error instanceof Error
          ? `${error.message}. Replanning automatically.`
          : "Refresh failed. Replanning automatically.",
      ),
      contextLedger: [
        ...state.contextLedger,
        `refresh_error: ${error instanceof Error ? error.message : "unknown"}`,
      ],
    };
  }
}

export async function runAgentGraph(
  deps: GraphDeps,
  input: AgentRunInput,
): Promise<AgentRunOutput> {
  logRenderer("agentGraph", "runAgentGraph start", {
    goal: input.goal?.slice(0, 60),
    mode: input.mode,
  });

  // Wire up realtime event callback for the duration of this run
  _activeOnEvent = deps.onEvent;

  const hasStepLimit = Number.isFinite(deps.maxSteps) && deps.maxSteps > 0;
  const recursionLimit = hasStepLimit ? Math.max(120, deps.maxSteps * 12 + 40) : 400;
  logRenderer("agentGraph", "invoke config", {
    maxSteps: deps.maxSteps,
    hasStepLimit,
    recursionLimit,
    fastMode: deps.fastMode,
  });

  if (input.mode === "manual") {
    return {
      completed: true,
      finalAnswer: "Manual mode: no actions executed.",
      finalSummary: {
        summary: "Manual mode run.",
        purpose: "No automatic execution",
        choices: [],
      },
      timeline: [
        {
          ts: new Date().toISOString(),
          kind: "plan",
          message: "Manual mode: no actions executed.",
        },
      ],
    };
  }

  const rawGoal = input.goal;
  let resolvedGoal: string;
  let searchQuery: string | undefined = input.searchQuery;
  let planSteps: string[] = input.planSteps ?? [];
  let completion_point: string | undefined = input.completion_point;
  if (input.resolvedGoal) {
    resolvedGoal = input.resolvedGoal;
    logRenderer("agentGraph", "using pre-resolved goal", { len: resolvedGoal.length });
  } else {
    const inferred = await deps.inferIntent(rawGoal);
    resolvedGoal = [
      `Inferred goal: ${inferred.inferredGoal}`,
      ``,
      `Plan:`,
      inferred.plan,
      ``,
      `Original user message: ${rawGoal}`,
    ].join("\n");
    searchQuery = inferred.searchQuery ?? searchQuery;
    if (inferred.planSteps?.length) {
      planSteps = inferred.planSteps;
    }
    completion_point = inferred.completion_point ?? completion_point;
    logRenderer("agentGraph", "intent inferred", {
      inferredGoalLen: inferred.inferredGoal.length,
      planLen: inferred.plan.length,
      planSteps: planSteps.length,
      completion_point: completion_point?.slice(0, 60),
      searchQuery: searchQuery?.slice(0, 40),
    });
  }

  let initialTimeline = pushTimeline(
    pushTimeline(
      [],
      "plan",
      `Goal: ${resolvedGoal.slice(0, 120)}${resolvedGoal.length > 120 ? "…" : ""}`,
    ),
    "observe",
    `Observed ${input.initialObservation.elements.length} actionable elements on ${input.initialObservation.url} (cached verification snapshot)`,
  );
  let initialContextLedger = [
    `observe: ${input.initialObservation.url} (${input.initialObservation.elements.length} elements)`,
  ];

  let availableMcpTools: McpToolDescriptor[] = [];
  try {
    availableMcpTools = await deps.listMcpTools();
    if (availableMcpTools.length > 0) {
      initialTimeline = pushTimeline(
        initialTimeline,
        "plan",
        `Discovered ${availableMcpTools.length} MCP tools.`,
      );
      initialContextLedger = [...initialContextLedger, `mcp_tools: ${availableMcpTools.length}`];
    }
  } catch (error) {
    initialTimeline = pushTimeline(
      initialTimeline,
      "plan",
      "MCP tools unavailable. Continuing with browser-only tools.",
    );
    initialContextLedger = [
      ...initialContextLedger,
      `mcp_tools_error: ${error instanceof Error ? error.message : "unknown"}`,
    ];
  }

  const graph = buildAgentGraph();
  const initialState = {
    goal: resolvedGoal,
    searchQuery,
    completion_point,
    planSteps,
    planStepIndex: 0,
    mode: input.mode,
    observation: input.initialObservation,
    observationFingerprint: getObservationFingerprint(input.initialObservation),
    lastSemanticFingerprint: "",
    availableActions: [] as SidebarChoice[],
    availableMcpTools,
    currentStep: "",
    summary: null as PageSummary | null,
    timeline: initialTimeline,
    steps: 0,
    completed: false,
    finalAnswer: "",
    compactedContext: "",
    contextLedger: initialContextLedger,
    actionFailureStreak: {} as Record<string, number>,
    noProgressCycles: 0,
    noProgressFallbacks: 0,
    stallCycles: 0,
    lastOfferedChoiceIndex: null as number | null,
    decisionCache: {} as Record<string, LoopToolCall>,
    pageStuckFingerprint: null as string | null,
    pageStuckSince: null as number | null,
    stepsWhenPageStuck: 0,
    executedActions: [] as BrowserAction[],
    triedDestinationUrls: [] as string[],
    metrics: {
      semanticCalls: 0,
      planCalls: 0,
      safetyCalls: 0,
      mcpCalls: 0,
      fastPathDecisions: 0,
      planCacheHits: 0,
      stepDurationsMs: [] as number[],
    },
    toolCall: null as LoopToolCall | null,
    nextRoute: undefined as string | undefined,
  };

  let finalState: Awaited<ReturnType<typeof graph.invoke>>;
  try {
    finalState = await graph.invoke(initialState, {
      configurable: { deps, input },
      signal: input.signal,
      recursionLimit,
    });
  } catch (error) {
    if (input.signal?.aborted) {
      _activeOnEvent = undefined;
      return {
        completed: true,
        finalAnswer: "Interrupted by user.",
        finalSummary: {
          summary: "No summary available.",
          purpose: "Unknown",
          choices: [],
        },
        timeline: initialTimeline.concat([
          {
            ts: new Date().toISOString(),
            kind: "plan",
            message: "Interrupted by user.",
          },
        ]),
      };
    }
    throw error;
  }

  const state = finalState as typeof initialState & {
    completed?: boolean;
    finalAnswer?: string;
    timeline?: AgentTimelineEvent[];
    summary?: PageSummary | null;
    executedActions?: BrowserAction[];
  };

  const totalDuration = (state.metrics?.stepDurationsMs ?? []).reduce(
    (sum: number, value: number) => sum + value,
    0,
  );
  const stepDurations = state.metrics?.stepDurationsMs ?? [];
  const avgStepMs =
    stepDurations.length > 0 ? Math.round(totalDuration / stepDurations.length) : 0;
  const p50StepMs = Math.round(percentile(stepDurations, 50));
  const p95StepMs = Math.round(percentile(stepDurations, 95));
  const perfSummary = `Perf: avgStep=${avgStepMs}ms p50=${p50StepMs}ms p95=${p95StepMs}ms semantic=${state.metrics?.semanticCalls ?? 0} plan=${state.metrics?.planCalls ?? 0} safety=${state.metrics?.safetyCalls ?? 0} mcp=${state.metrics?.mcpCalls ?? 0} fastPath=${state.metrics?.fastPathDecisions ?? 0} planCacheHits=${state.metrics?.planCacheHits ?? 0}`;
  const finalTimeline = pushTimeline(
    state.timeline ?? initialTimeline,
    "summary",
    perfSummary,
  );

  logRenderer("agentGraph", "runAgentGraph done", {
    completed: state.completed,
    timelineLen: finalTimeline.length,
    metrics: state.metrics,
  });

  _activeOnEvent = undefined;

  return {
    completed: state.completed ?? false,
    finalAnswer:
      state.finalAnswer || "Task ended. Review the simplified summary in the sidebar.",
    finalSummary:
      state.summary ?? {
        summary: "No summary available.",
        purpose: "Unknown",
        choices: [],
      },
    timeline: finalTimeline,
    executedActions: state.executedActions ?? [],
  };
}
