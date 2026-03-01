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

type GraphDeps = {
  inferIntent: (rawGoal: string) => Promise<{ inferredGoal: string; plan: string }>;
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
  onBannedActions?: (signatures: string[]) => void;
  listMcpTools: () => Promise<McpToolDescriptor[]>;
  callMcpTool: (call: McpToolCall) => Promise<McpToolCallResult>;
  askUser: (question: string) => Promise<string | null>;
  isRiskyForHITL: (action: BrowserAction) => boolean;
  maxSteps: number;
  actionTimeoutMs: number;
  verifyTimeoutMs: number;
  maxRetriesPerStep: number;
  fastMode: boolean;
  enableSafetyGuardrails: boolean;
  requireApprovalForRiskyActions: boolean;
};

type LoopToolCall =
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

type LoopState = {
  goal: string;
  searchQuery?: string;
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
  bannedActions: Set<string>;
  actionFailureStreak: Record<string, number>;
  noProgressCycles: number;
  noProgressFallbacks: number;
  stallCycles: number;
  lastOfferedChoiceIndex: number | null;
  prefetchedSemanticPromise: Promise<(PageSummary & { current_step?: string })> | null;
  prefetchedSemanticFingerprint: string | null;
  decisionCache: Map<string, LoopToolCall>;
  /** Choice indices to skip when planner keeps picking non-executable options. */
  bannedChoiceIndices: Set<number>;
  /** Timer-based loop detection: fingerprint we've been stuck on. */
  pageStuckFingerprint: string | null;
  /** When we first saw this fingerprint (ms). */
  pageStuckSince: number | null;
  /** Step count when we first got stuck on this page. */
  stepsWhenPageStuck: number;
  /** Action signatures executed on current page; banned when we go back from a stuck loop. */
  actionsOnCurrentPage: string[];
  /** Full sequence of browser actions executed this run (for path storage). */
  executedActions: BrowserAction[];
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

const LOOP_STUCK_MS = 15000;
const LOOP_GOBACK_WAIT_MS = 2000;

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

function pushTimeline(
  timeline: AgentTimelineEvent[],
  kind: AgentTimelineEvent["kind"],
  message: string,
): AgentTimelineEvent[] {
  return [
    ...timeline,
    {
      ts: new Date().toISOString(),
      kind,
      message,
    },
  ];
}

function withTimeout<T>(
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

function getObservationFingerprint(observation: PageObservation): string {
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

function describeAction(action: BrowserAction): string {
  if (action.type === "click") return `click ${action.elementId}`;
  if (action.type === "type") return `type \"${action.text}\" into ${action.elementId}`;
  if (action.type === "select") return `select \"${action.value}\" in ${action.elementId}`;
  if (action.type === "scroll") return `scroll ${action.elementId}`;
  return `navigate ${action.url}`;
}

function getActionSignature(action: BrowserAction): string {
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

function shortQuestion(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Choose next option.";
  const firstSentence = cleaned.split(/[.!?]/)[0]?.trim() || cleaned;
  const words = firstSentence.split(" ").filter(Boolean);
  return words.slice(0, 14).join(" ") + (words.length > 14 ? "?" : "");
}

function isConfirmationQuestion(question: string): boolean {
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

function getDecisionCacheKey(state: LoopState): string {
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

function detectStuckLoop(state: LoopState): boolean {
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

function pickDeterministicAction(
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
    .filter((entry) => !state.bannedActions.has(getActionSignature(entry.action)))
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

  const tokens = tokenize(state.goal);
  const scored = executable
    .map((entry) => {
      const haystack = `${entry.choice.label} ${entry.choice.rationale} ${entry.choice.suggestedAction} ${entry.choice.actionValue ?? ""}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += 2;
      }
      if (entry.action.type === "navigate") score += 1;
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

function buildPromptGoal(state: LoopState, _input: AgentRunInput): string {
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
    const queueInfo = `Queued plan step ${idx + 1}/${state.planSteps.length}: ${currentPlanStep}`;
    parts.push(`\n${queueInfo}\nSelect the action that achieves THIS step.`);
  }
  if (recentUserNotes) parts.push(`Recent notes:\n${recentUserNotes}`);
  if (compactContext) parts.push(`Compact context:\n${compactContext}`);
  return parts.filter(Boolean).join("\n\n");
}

function resolveToolCallFromPlan(
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
        question: `Option ${plan.selectedChoiceIndex} not found. Choose 1-${availableActions.length}.`,
        reason: "invalid_option",
      };
    }

    const selectedAction = choiceToAction(selectedChoice);
    if (!selectedAction) {
      return {
        kind: "ask_user",
        question: `Option ${plan.selectedChoiceIndex} cannot run. Choose another option number.`,
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
        question: `MCP tool ${plan.mcpToolCall.server}/${plan.mcpToolCall.name} is unavailable. Choose a sidebar option.`,
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
        question: "Choose sidebar option number.",
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
    question: "Which option should I run next?",
    reason: "no_action",
  };
}

function maybeCompactContext(state: LoopState): LoopState {
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

function getNavigateFallbackAction(state: LoopState): BrowserAction | null {
  const goal = state.goal.toLowerCase();
  const url = state.observation.url.toLowerCase();

  if (/flight|ticket|airline|travel/.test(goal)) {
    if (!url.includes("google.com/travel/flights")) {
      return { type: "navigate", url: "https://www.google.com/travel/flights" };
    }
    return { type: "navigate", url: "https://www.skyscanner.com" };
  }

  if (url.includes("google.com") && state.noProgressCycles >= 2) {
    return {
      type: "navigate",
      url: `https://www.google.com/search?q=${encodeURIComponent(state.goal.slice(0, 120))}`,
    };
  }

  return null;
}

function pickAlternativeAction(
  choices: SidebarChoice[],
  bannedSignatures: Set<string>,
): { action: BrowserAction; index: number; label: string } | null {
  for (let i = 0; i < choices.length; i += 1) {
    const action = choiceToAction(choices[i]);
    if (!action) continue;
    if (bannedSignatures.has(getActionSignature(action))) continue;
    return { action, index: i + 1, label: choices[i].label };
  }
  return null;
}

async function executeActionWithRetries(
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

function findChoiceIndexFromAnswer(
  answer: string,
  availableActions: SidebarChoice[],
  lastOfferedChoiceIndex: number | null,
): number | null {
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return null;

  const optionMatch = trimmed.match(/(?:option\s*)?(\d+)/i);
  if (optionMatch) {
    const n = parseInt(optionMatch[1], 10);
    if (n >= 1 && n <= availableActions.length) return n;
  }

  if (/^yes\b/.test(trimmed)) {
    if (lastOfferedChoiceIndex != null) return lastOfferedChoiceIndex;
    if (availableActions.length === 1) return 1;
  }

  const token = trimmed.split(/\s+/)[0];
  if (token) {
    const candidates = availableActions
      .map((choice, index) => ({
        index: index + 1,
        text: `${choice.label} ${choice.rationale} ${choice.suggestedAction}`.toLowerCase(),
      }))
      .filter((entry) => entry.text.includes(token));
    if (candidates.length === 1) return candidates[0].index;
  }

  return null;
}

async function refreshObservationAndSemantic(
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
    logRenderer("agentGraph", "intent inferred", {
      inferredGoalLen: inferred.inferredGoal.length,
      planLen: inferred.plan.length,
      planSteps: planSteps.length,
      searchQuery: searchQuery?.slice(0, 40),
    });
  }

  let state: LoopState = {
    goal: resolvedGoal,
    searchQuery,
    planSteps,
    planStepIndex: 0,
    mode: input.mode,
    observation: input.initialObservation,
    observationFingerprint: getObservationFingerprint(input.initialObservation),
    lastSemanticFingerprint: "",
    availableActions: [],
    availableMcpTools: [],
    currentStep: "",
    summary: null,
    timeline: [],
    steps: 0,
    completed: false,
    finalAnswer: "",
    compactedContext: "",
    contextLedger: [],
    bannedActions: new Set<string>(input.initialBannedActions ?? []),
    actionFailureStreak: {},
    noProgressCycles: 0,
    noProgressFallbacks: 0,
    stallCycles: 0,
    lastOfferedChoiceIndex: null,
    prefetchedSemanticPromise: null,
    prefetchedSemanticFingerprint: null,
    decisionCache: new Map<string, LoopToolCall>(),
    bannedChoiceIndices: new Set<number>(),
    pageStuckFingerprint: null,
    pageStuckSince: null,
    stepsWhenPageStuck: 0,
    actionsOnCurrentPage: [],
    executedActions: [],
    metrics: {
      semanticCalls: 0,
      planCalls: 0,
      safetyCalls: 0,
      mcpCalls: 0,
      fastPathDecisions: 0,
      planCacheHits: 0,
      stepDurationsMs: [],
    },
  };

  state.timeline = pushTimeline(
    state.timeline,
    "plan",
    `Goal: ${state.goal.slice(0, 120)}${state.goal.length > 120 ? "…" : ""}`,
  );
  state.timeline = pushTimeline(
    state.timeline,
    "observe",
    `Observed ${state.observation.elements.length} actionable elements on ${state.observation.url} (cached verification snapshot)`,
  );
  state.contextLedger.push(
    `observe: ${state.observation.url} (${state.observation.elements.length} elements)`,
  );

  try {
    state.availableMcpTools = await deps.listMcpTools();
    if (state.availableMcpTools.length > 0) {
      state.timeline = pushTimeline(
        state.timeline,
        "plan",
        `Discovered ${state.availableMcpTools.length} MCP tools.`,
      );
      state.contextLedger.push(`mcp_tools: ${state.availableMcpTools.length}`);
    }
  } catch (error) {
    state.timeline = pushTimeline(
      state.timeline,
      "plan",
      "MCP tools unavailable. Continuing with browser-only tools.",
    );
    state.contextLedger.push(
      `mcp_tools_error: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  if (input.presavedPath && input.presavedPath.length > 0) {
    state.timeline = pushTimeline(
      state.timeline,
      "plan",
      `Using presaved path (${input.presavedPath.length} actions).`,
    );
    for (const action of input.presavedPath) {
      if (input.signal?.aborted) {
        state.completed = true;
        state.finalAnswer = "Interrupted by user.";
        break;
      }
      const exec = await executeActionWithRetries(deps, action, state.timeline);
      state.timeline = exec.timeline;
      state.executedActions = [...state.executedActions, action];
      if (!exec.ok) {
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `Presaved path failed at step: ${exec.lastMessage}. Continuing with planning.`,
        );
        break;
      }
      state.steps += 1;
      const observed = await deps.observe();
      state.observation = observed;
      state.observationFingerprint = getObservationFingerprint(observed);
    }
    if (state.steps === input.presavedPath.length) {
      state.completed = true;
      state.finalAnswer = "Completed using presaved path.";
    }
  }

  let transitions = 0;
  while (!state.completed && transitions < recursionLimit) {
    if (input.signal?.aborted) {
      state.completed = true;
      state.finalAnswer = "Interrupted by user.";
      state.timeline = pushTimeline(state.timeline, "plan", "Interrupted by user.");
      break;
    }
    const loopStart = Date.now();
    transitions += 1;
    try {

    if (state.observationFingerprint !== state.pageStuckFingerprint) {
      state.pageStuckFingerprint = state.observationFingerprint;
      state.pageStuckSince = Date.now();
      state.stepsWhenPageStuck = state.steps;
    } else if (state.pageStuckSince == null) {
      state.pageStuckSince = Date.now();
      state.stepsWhenPageStuck = state.steps;
    }

    if (detectStuckLoop(state) && deps.canGoBack?.() && deps.goBack) {
      const fromUrl = state.observation.url;
      const toBan = [...state.actionsOnCurrentPage];
      for (const sig of toBan) {
        state.bannedActions.add(sig);
      }
      deps.onBannedActions?.(toBan);
      state.goal = `${state.goal}\nDo NOT repeat the actions that led to the stuck page.`;
      state.timeline = pushTimeline(
        state.timeline,
        "plan",
        `Stuck on same page for ${LOOP_STUCK_MS / 1000}s with steps increasing. Going back and banning ${toBan.length} action(s) to avoid same route.`,
      );
      deps.goBack();
      await new Promise((r) => setTimeout(r, LOOP_GOBACK_WAIT_MS));
      const observed = await deps.observe();
      state.observation = observed;
      state.observationFingerprint = getObservationFingerprint(observed);
      state.pageStuckFingerprint = state.observationFingerprint;
      state.pageStuckSince = Date.now();
      state.stepsWhenPageStuck = state.steps;
      state.actionsOnCurrentPage = [];
      state.lastSemanticFingerprint = "";
      state.decisionCache.clear();
      state.contextLedger.push(`loop_recovery: went back from ${fromUrl} to ${observed.url}, banned ${toBan.length} action(s)`);
      continue;
    }

    if (hasStepLimit && state.steps >= deps.maxSteps) {
      state.completed = true;
      state.finalAnswer =
        "Stopped after max steps. Review the summary and continue if needed.";
      state.timeline = pushTimeline(state.timeline, "plan", "Reached max steps.");
      break;
    }

    const canReuseSemantic =
      deps.fastMode &&
      !!state.observationFingerprint &&
      state.observationFingerprint === state.lastSemanticFingerprint &&
      state.availableActions.length > 0;

    if (!canReuseSemantic) {
      let semantic: PageSummary & { current_step?: string };
      if (
        deps.fastMode &&
        state.prefetchedSemanticPromise &&
        state.prefetchedSemanticFingerprint === state.observationFingerprint
      ) {
        try {
          semantic = await state.prefetchedSemanticPromise;
        } catch {
          state.metrics.semanticCalls += 1;
          semantic = await deps.semanticInterpreter(state.observation, state.goal, {
            searchQuery: /google\.com/i.test(state.observation.url) ? state.searchQuery : undefined,
          });
        }
      } else {
        state.metrics.semanticCalls += 1;
        semantic = await deps.semanticInterpreter(state.observation, state.goal, {
          searchQuery: /google\.com/i.test(state.observation.url) ? state.searchQuery : undefined,
        });
      }
      let choices = semantic.choices ?? [];
      if (
        state.searchQuery &&
        /google\.com/i.test(state.observation.url)
      ) {
        choices = choices.map((c) => {
          if (
            c.actionType === "type" &&
            c.actionValue &&
            (c.actionValue.includes("Inferred goal") ||
              c.actionValue.length > 100)
          ) {
            return { ...c, actionValue: state.searchQuery!.slice(0, 120) };
          }
          return c;
        });
      }
      state.availableActions = choices;
      state.currentStep = semantic.current_step ?? state.observation.title;
      state.summary = semantic;
      state.lastSemanticFingerprint = state.observationFingerprint;
      state.prefetchedSemanticPromise = null;
      state.prefetchedSemanticFingerprint = null;
      state.contextLedger.push(
        `semantic: step=${state.currentStep}, choices=${state.availableActions.length}`,
      );
    } else {
      state.contextLedger.push(
        `semantic: reused for ${state.observation.url} with ${state.availableActions.length} choices`,
      );
    }

    state = maybeCompactContext(state);

    let toolCall: LoopToolCall | null = null;

    if (state.noProgressCycles >= 2) {
      const fallbackAction = getNavigateFallbackAction(state);
      if (fallbackAction && !state.bannedActions.has(getActionSignature(fallbackAction))) {
        toolCall = {
          kind: "execute_action",
          action: fallbackAction,
          source: "no-progress navigate fallback",
        };
        state.noProgressFallbacks += 1;
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `No progress for ${state.noProgressCycles} cycles. Trying navigate fallback.`,
        );
      }
    }
    const decisionKey = getDecisionCacheKey(state);

    if (!toolCall) {
      const cachedCall = state.decisionCache.get(decisionKey);
      if (cachedCall) {
        const shouldSkip =
          cachedCall.kind === "execute_action" ||
          (cachedCall.kind === "execute_mcp" &&
            state.bannedActions.has(`mcp:${cachedCall.call.server}/${cachedCall.call.name}`));
        if (!shouldSkip) {
          toolCall = cachedCall;
          state.metrics.planCacheHits += 1;
          const cachedSource =
            cachedCall.kind === "ask_user" ? cachedCall.reason : cachedCall.source;
          state.timeline = pushTimeline(
            state.timeline,
            "plan",
            `Plan cache hit: ${cachedSource}`,
          );
        }
      }
    }

    if (!toolCall && deps.fastMode && state.stallCycles >= 3) {
      const deterministic = pickDeterministicAction(state);
      if (deterministic) {
        toolCall = {
          kind: "execute_action",
          action: deterministic.action,
          source: `stall breaker (${deterministic.source})`,
          label: deterministic.label,
          choiceIndex: deterministic.choiceIndex,
        };
        state.metrics.fastPathDecisions += 1;
        if (deterministic.choiceIndex != null) {
          state.lastOfferedChoiceIndex = deterministic.choiceIndex;
        }
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `Stall breaker selected ${deterministic.source}${deterministic.label ? ` (${deterministic.label})` : ""}.`,
        );
      }
    }

    if (!toolCall) {
      const assembledGoal = buildPromptGoal(state, input);
      state.timeline = pushTimeline(
        state.timeline,
        "plan",
        `Prompt assembled with ${
          state.availableActions.length + state.availableMcpTools.length
        } tool options.`,
      );
      state.contextLedger.push(
        `prompt: sidebarTools=${state.availableActions.length}, mcpTools=${state.availableMcpTools.length}, step=${state.currentStep}`,
      );

      const planInput: PlanActionInput = {
        goal: assembledGoal,
        observation: state.observation,
        timeline: state.timeline,
        availableActions: state.availableActions,
        availableMcpTools: state.availableMcpTools,
        currentStep: state.currentStep,
      };

      state.metrics.planCalls += 1;
      const plan = await deps.plan(planInput);
      if (plan.done) {
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `${plan.reasoning} (confidence ${plan.confidence.toFixed(2)})`,
        );
        state.contextLedger.push(
          `assistant: done (confidence=${plan.confidence.toFixed(2)})`,
        );
        state.completed = true;
        state.finalAnswer = plan.finalAnswer;
        break;
      }

      toolCall = resolveToolCallFromPlan(
        plan,
        state.availableActions,
        state.availableMcpTools,
      );
      if (toolCall.kind === "execute_mcp") {
        state.decisionCache.set(decisionKey, toolCall);
      }
      if (toolCall.kind === "execute_action" && toolCall.choiceIndex != null) {
        state.lastOfferedChoiceIndex = toolCall.choiceIndex;
      }

      if (toolCall.kind === "execute_action" || toolCall.kind === "execute_mcp") {
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `${plan.reasoning} -> ${toolCall.source}${
            toolCall.kind === "execute_action" && toolCall.label
              ? ` (${toolCall.label})`
              : ""
          } (confidence ${plan.confidence.toFixed(2)})`,
        );
      }
    }

    if (toolCall.kind === "ask_user") {
      if (toolCall.reason !== "planner_ask") {
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `${toolCall.question} Replanning automatically.`,
        );
        state.contextLedger.push(`planner_feedback: ${toolCall.reason}`);
        state.goal = `${state.goal}\nPlanner correction: ${toolCall.question}`;
        state.stallCycles += 1;
        continue;
      }

      const base = shortQuestion(toolCall.question);
      const expectsText = isConfirmationQuestion(toolCall.question);
      const question =
        expectsText
          ? `${base} (Enter=skip)`
          : state.availableActions.length > 0
            ? `${base} Option? 1-${state.availableActions.length} (Enter=skip)`
            : `${base} (Enter=skip)`;

      let interpretedChoice: number | null = null;
      let skipped = false;
      let clarificationText: string | null = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        state.timeline = pushTimeline(state.timeline, "question", question);
        const answer = await deps.askUser(question);
        const trimmed = (answer ?? "").trim();

        if (!trimmed) {
          skipped = true;
          state.timeline = pushTimeline(
            state.timeline,
            "user",
            "User skipped question. Re-evaluating best option.",
          );
          break;
        }

        state.timeline = pushTimeline(state.timeline, "user", `User clarification: ${trimmed}`);

        const choiceIndex = findChoiceIndexFromAnswer(
          trimmed,
          state.availableActions,
          state.lastOfferedChoiceIndex,
        );

        if (choiceIndex != null) {
          interpretedChoice = choiceIndex;
          break;
        }

        if (expectsText) {
          clarificationText = trimmed;
          break;
        }

        if (state.availableActions.length > 0) {
          const reprompt = `Number only: 1-${state.availableActions.length} (Enter=skip)`;
          state.timeline = pushTimeline(state.timeline, "question", reprompt);
          const answer2 = await deps.askUser(reprompt);
          const trimmed2 = (answer2 ?? "").trim();
          if (!trimmed2) {
            skipped = true;
            state.timeline = pushTimeline(
              state.timeline,
              "user",
              "User skipped question. Re-evaluating best option.",
            );
            break;
          }
          state.timeline = pushTimeline(state.timeline, "user", `User clarification: ${trimmed2}`);
          const choiceIndex2 = findChoiceIndexFromAnswer(
            trimmed2,
            state.availableActions,
            state.lastOfferedChoiceIndex,
          );
          if (choiceIndex2 != null) {
            interpretedChoice = choiceIndex2;
            break;
          }
          clarificationText = trimmed2;
          continue;
        }

        clarificationText = trimmed;
      }

      if (interpretedChoice != null) {
        const selected = state.availableActions[interpretedChoice - 1];
        const selectedAction = selected ? choiceToAction(selected) : null;
        if (selectedAction) {
          toolCall = {
            kind: "execute_action",
            action: selectedAction,
            source: `user selected option ${interpretedChoice}`,
            label: selected?.label,
            choiceIndex: interpretedChoice,
          };
          state.lastOfferedChoiceIndex = interpretedChoice;
          state.goal = `${state.goal}\nUser selected option ${interpretedChoice}.`;
          state.stallCycles = 0;
        } else {
          state.goal = `${state.goal}\nUser selected non-executable option ${interpretedChoice}.`;
          state.stallCycles += 1;
          continue;
        }
      } else if (skipped) {
        state.goal = `${state.goal}\nUser skipped clarification. Choose best next option.`;
        state.contextLedger.push("user: skipped clarification");
        state.stallCycles += 1;
        continue;
      } else {
        if (clarificationText) {
          state.goal = `${state.goal}\nUser clarification: ${clarificationText}`;
          state.contextLedger.push(`user: ${clarificationText}`);
          state.decisionCache.clear();
          state.stallCycles = 0;
        } else {
          state.stallCycles += 1;
        }
        continue;
      }
    }

    if (toolCall.kind === "execute_mcp") {
      const toolLabel = `${toolCall.call.server}/${toolCall.call.name}`;
      state.contextLedger.push(`tool_call: execute_mcp ${toolLabel}`);
      try {
        state.metrics.mcpCalls += 1;
        const result = await withTimeout(
          deps.callMcpTool(toolCall.call),
          deps.actionTimeoutMs,
          `MCP tool timed out after ${deps.actionTimeoutMs}ms`,
        );
        state.timeline = pushTimeline(
          state.timeline,
          "act",
          `MCP ${toolLabel}: ${result.ok ? "ok" : "failed"}`,
        );
        const snippet = result.content.slice(0, 1200);
        state.contextLedger.push(
          `tool_result: mcp ${result.ok ? "success" : "failure"} ${toolLabel} ${snippet}`,
        );
        if (!result.ok || result.isError) {
          state.goal = `${state.goal}\nMCP tool ${toolLabel} failed: ${snippet}`;
          continue;
        }
        state.steps += 1;
        state.stallCycles = 0;
        state.goal = `${state.goal}\nMCP result (${toolLabel}): ${snippet}`;
        continue;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `MCP tool ${toolLabel} failed`;
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `${message}. Replanning automatically.`,
        );
        state.contextLedger.push(`tool_result: mcp_error ${toolLabel} ${message}`);
        state.goal = `${state.goal}\nMCP error (${toolLabel}): ${message}`;
        state.stallCycles += 1;
        continue;
      }
    }

    const initialAction = toolCall.action;
    let action = initialAction;
    let signature = getActionSignature(action);

    if (state.bannedActions.has(signature)) {
      const alternative = pickAlternativeAction(state.availableActions, state.bannedActions);
      if (alternative) {
        action = alternative.action;
        signature = getActionSignature(action);
        toolCall = {
          kind: "execute_action",
          action,
          source: `banned-action bypass -> option ${alternative.index}`,
          label: alternative.label,
          choiceIndex: alternative.index,
        };
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `Selected action was banned. Switching to option ${alternative.index} (${alternative.label}).`,
        );
      } else {
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          "Selected action is banned and no alternative is available. Replanning.",
        );
        state.goal = `${state.goal}\nAvoid action ${describeAction(initialAction)}.`;
        continue;
      }
    }

    const actionDesc = describeAction(action);
    state.contextLedger.push(`tool_call: execute_action ${actionDesc}`);

    if (deps.enableSafetyGuardrails) {
      state.metrics.safetyCalls += 1;
      const validation = await deps.safetySupervisor(state.goal, action, {
        url: state.observation.url,
        currentStep: state.currentStep,
      });

      if (!validation.approved) {
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `Guardrails rejected action: ${validation.reason}. Replanning automatically.`,
        );
        state.decisionCache.clear();
        state.contextLedger.push(`tool_result: guardrails_reject ${validation.reason}`);
        state.goal = `${state.goal}\nSafety feedback: ${validation.reason}`;
        state.stallCycles += 1;
        continue;
      }

      if (
        deps.requireApprovalForRiskyActions &&
        (validation.requiresHITL || deps.isRiskyForHITL(action))
      ) {
        const confirmQuestion = `Confirm ${actionDesc}? yes/no (Enter=skip)`;
        state.timeline = pushTimeline(state.timeline, "question", confirmQuestion);
        const confirmAnswer = await deps.askUser(confirmQuestion);
        if (!confirmAnswer || !/^\s*yes\s*$/i.test(confirmAnswer)) {
          state.timeline = pushTimeline(
            state.timeline,
            "user",
            "User declined/skip. Re-evaluating best option.",
          );
          state.decisionCache.clear();
          state.contextLedger.push("tool_result: hitl_declined_or_skipped");
          state.stallCycles += 1;
          continue;
        }
        state.timeline = pushTimeline(state.timeline, "user", "User confirmed action.");
        state.contextLedger.push("tool_result: hitl_confirmed");
      }
    } else {
      state.contextLedger.push("tool_result: guardrails_disabled");
    }

    const exec = await executeActionWithRetries(deps, action, state.timeline);
    state.timeline = exec.timeline;

    if (!exec.ok) {
      const nextStreak = (state.actionFailureStreak[signature] ?? 0) + 1;
      state.actionFailureStreak[signature] = nextStreak;

      if (nextStreak >= 2) {
        state.bannedActions.add(signature);
        state.decisionCache.clear();
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `Loop breaker: banning action for this run (${actionDesc}).`,
        );
        state.goal = `${state.goal}\nDo not use action ${actionDesc}; it failed repeatedly.`;
      }

      if (exec.reason === "target_not_found") {
        state.decisionCache.clear();
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          "Target missing. Refreshing observation and semantic options immediately.",
        );
        state = await refreshObservationAndSemantic(deps, state, "after target not found");
        state.contextLedger.push(`tool_result: failed_target_not_found ${exec.lastMessage}`);
        state.stallCycles += 1;
        continue;
      }

      state.timeline = pushTimeline(
        state.timeline,
        "plan",
        `Action failed after ${deps.maxRetriesPerStep + 1} attempts. Replanning automatically.`,
      );
      state.decisionCache.clear();
      state.contextLedger.push(`tool_result: failed ${exec.lastMessage}`);
      state.goal = `${state.goal}\nTool error: ${exec.lastMessage}`;
      state.stallCycles += 1;
      continue;
    }

    state.actionFailureStreak[signature] = 0;
    state.decisionCache.clear();
    state.steps += 1;
    state.stallCycles = 0;
    state.executedActions = [...state.executedActions, action];
    state.contextLedger.push(`tool_result: success ${exec.lastMessage}`);

    try {
      const prevFingerprint = state.observationFingerprint;
      let observed = await withTimeout(
        deps.observe(),
        deps.verifyTimeoutMs,
        `Verification timed out after ${deps.verifyTimeoutMs}ms`,
      );
      let nextFingerprint = getObservationFingerprint(observed);
      if (nextFingerprint === prevFingerprint && (action.type === "type" || action.type === "navigate")) {
        await new Promise((r) => setTimeout(r, 2000));
        observed = await withTimeout(
          deps.observe(),
          deps.verifyTimeoutMs,
          `Verification timed out after ${deps.verifyTimeoutMs}ms`,
        );
        nextFingerprint = getObservationFingerprint(observed);
      }
      state.noProgressCycles = nextFingerprint === prevFingerprint ? state.noProgressCycles + 1 : 0;
      state.observation = observed;
      state.observationFingerprint = nextFingerprint;
      if (nextFingerprint !== prevFingerprint) {
        state.actionsOnCurrentPage = [signature];
      } else {
        state.actionsOnCurrentPage = [...state.actionsOnCurrentPage, signature];
      }
      if (
        nextFingerprint !== prevFingerprint &&
        state.planSteps.length > 0 &&
        state.planStepIndex < state.planSteps.length - 1
      ) {
        state.planStepIndex += 1;
        state.contextLedger.push(
          `plan_advance: step ${state.planStepIndex + 1}/${state.planSteps.length} (${state.planSteps[state.planStepIndex]?.slice(0, 60)}…)`,
        );
      }
      state.timeline = pushTimeline(
        state.timeline,
        "observe",
        `Observed ${observed.elements.length} actionable elements on ${observed.url} (post-action verification)`,
      );
      if (state.noProgressCycles >= 2) {
        state.timeline = pushTimeline(
          state.timeline,
          "plan",
          `No progress detected for ${state.noProgressCycles} cycles.`,
        );
      }
      state.contextLedger.push(
        `observe: ${observed.url} (${observed.elements.length} elements, noProgress=${state.noProgressCycles})`,
      );

      if (deps.fastMode && nextFingerprint !== state.lastSemanticFingerprint) {
        const goalSnapshot = state.goal;
        state.prefetchedSemanticFingerprint = nextFingerprint;
        state.metrics.semanticCalls += 1;
        state.prefetchedSemanticPromise = deps
          .semanticInterpreter(observed, goalSnapshot, {
            searchQuery: /google\.com/i.test(observed.url) ? state.searchQuery : undefined,
          })
          .catch((error) => {
            logRenderer("agentGraph", "prefetch semantic failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            return (
              state.summary ?? {
                summary: "No summary available.",
                purpose: "Unknown",
                choices: [],
              }
            );
          });
      } else {
        state.prefetchedSemanticFingerprint = null;
        state.prefetchedSemanticPromise = null;
      }
    } catch (error) {
      state.timeline = pushTimeline(
        state.timeline,
        "plan",
        error instanceof Error
          ? `${error.message}. Replanning automatically.`
          : "Verification failed or timed out. Replanning automatically.",
      );
      state.contextLedger.push(
        `verify_error: ${error instanceof Error ? error.message : "unknown"}`,
      );
      state.stallCycles += 1;
    }
    } finally {
      state.metrics.stepDurationsMs.push(Date.now() - loopStart);
    }
  }

  if (!state.completed && transitions >= recursionLimit) {
    state.completed = true;
    state.finalAnswer =
      "Recursion limit reached without hitting a stop condition. Increase max steps or refine the goal.";
    state.timeline = pushTimeline(
      state.timeline,
      "error",
      "Recursion limit reached before completion.",
    );
  }

  const totalDuration = state.metrics.stepDurationsMs.reduce((sum, value) => sum + value, 0);
  const avgStepMs =
    state.metrics.stepDurationsMs.length > 0
      ? Math.round(totalDuration / state.metrics.stepDurationsMs.length)
      : 0;
  const p50StepMs = Math.round(percentile(state.metrics.stepDurationsMs, 50));
  const p95StepMs = Math.round(percentile(state.metrics.stepDurationsMs, 95));
  const perfSummary = `Perf: avgStep=${avgStepMs}ms p50=${p50StepMs}ms p95=${p95StepMs}ms semantic=${state.metrics.semanticCalls} plan=${state.metrics.planCalls} safety=${state.metrics.safetyCalls} mcp=${state.metrics.mcpCalls} fastPath=${state.metrics.fastPathDecisions} planCacheHits=${state.metrics.planCacheHits}`;
  state.timeline = pushTimeline(state.timeline, "summary", perfSummary);

  logRenderer("agentGraph", "runAgentGraph done", {
    completed: state.completed,
    timelineLen: state.timeline.length,
    transitions,
    metrics: {
      avgStepMs,
      p50StepMs,
      p95StepMs,
      semanticCalls: state.metrics.semanticCalls,
      planCalls: state.metrics.planCalls,
      safetyCalls: state.metrics.safetyCalls,
      mcpCalls: state.metrics.mcpCalls,
      fastPathDecisions: state.metrics.fastPathDecisions,
      planCacheHits: state.metrics.planCacheHits,
    },
  });

  return {
    completed: state.completed,
    finalAnswer:
      state.finalAnswer || "Task ended. Review the simplified summary in the sidebar.",
    finalSummary:
      state.summary ?? {
        summary: "No summary available.",
        purpose: "Unknown",
        choices: [],
      },
    timeline: state.timeline,
    executedActions: state.executedActions,
  };
}
