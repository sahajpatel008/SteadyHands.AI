/**
 * LangGraph-based agent execution. State schema and node functions for the
 * agent loop. Used by runAgentGraph in agentGraph.ts.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type {
  AgentTimelineEvent,
  BrowserAction,
  McpToolCall,
  McpToolDescriptor,
  PageObservation,
  PageSummary,
  SidebarChoice,
} from "../../shared/types";
import { choiceToAction } from "./choiceAction";
import {
  type GraphDeps,
  type LoopToolCall,
  type LoopState,
  pushTimeline,
  getObservationFingerprint,
  getDecisionCacheKey,
  detectStuckLoop,
  getNavigateFallbackAction,
  getFirstOrganicLinkFromPage,
  pickDeterministicAction,
  buildPromptGoal,
  resolveToolCallFromPlan,
  maybeCompactContext,
  executeActionWithRetries,
  refreshObservationAndSemantic,
  withTimeout,
  LOOP_STUCK_MS,
  LOOP_GOBACK_WAIT_MS,
  normalizeUrlForTried,
  shortQuestion,
  getActionSignature,
  describeAction,
} from "./agentGraph";
import { logMain } from "../../shared/logger";
import type { AgentRunInput } from "../../shared/types";

const MAX_TIMELINE = 2000;
const MAX_EXECUTED_ACTIONS = 500;

const appendReducer = <T>(left: T[], right: T | T[], maxLen = 10000) => {
  const toAdd = Array.isArray(right) ? right : [right];
  const next = left.concat(toAdd);
  return next.length > maxLen ? next.slice(-maxLen) : next;
};

export const AgentStateAnnotation = Annotation.Root({
  goal: Annotation<string>(),
  searchQuery: Annotation<string | undefined>(),
  completion_point: Annotation<string | undefined>(),
  planSteps: Annotation<string[]>(),
  planStepIndex: Annotation<number>(),
  mode: Annotation<"manual" | "assist" | "auto">(),
  observation: Annotation<PageObservation>(),
  observationFingerprint: Annotation<string>(),
  lastSemanticFingerprint: Annotation<string>(),
  availableActions: Annotation<SidebarChoice[]>(),
  availableMcpTools: Annotation<McpToolDescriptor[]>(),
  currentStep: Annotation<string>(),
  summary: Annotation<PageSummary | null>(),
  timeline: Annotation<AgentTimelineEvent[]>({
    reducer: (left, right) => appendReducer(left, right, MAX_TIMELINE),
    default: () => [],
  }),
  steps: Annotation<number>(),
  completed: Annotation<boolean>(),
  finalAnswer: Annotation<string>(),
  compactedContext: Annotation<string>(),
  contextLedger: Annotation<string[]>(),
  actionFailureStreak: Annotation<Record<string, number>>(),
  noProgressCycles: Annotation<number>(),
  noProgressFallbacks: Annotation<number>(),
  stallCycles: Annotation<number>(),
  lastOfferedChoiceIndex: Annotation<number | null>(),
  decisionCache: Annotation<Record<string, LoopToolCall>>(),
  pageStuckFingerprint: Annotation<string | null>(),
  pageStuckSince: Annotation<number | null>(),
  stepsWhenPageStuck: Annotation<number>(),
  executedActions: Annotation<BrowserAction[]>({
    reducer: (left, right) => appendReducer(left, right, MAX_EXECUTED_ACTIONS),
    default: () => [],
  }),
  triedDestinationUrls: Annotation<string[]>(),
  metrics: Annotation<{
    semanticCalls: number;
    planCalls: number;
    safetyCalls: number;
    mcpCalls: number;
    fastPathDecisions: number;
    planCacheHits: number;
    stepDurationsMs: number[];
  }>(),
  toolCall: Annotation<LoopToolCall | null>(),
  nextRoute: Annotation<string | undefined>(),
});

export type AgentGraphState = typeof AgentStateAnnotation.State;

function toGraphState(s: LoopState): AgentGraphState {
  return {
    ...s,
    decisionCache: Object.fromEntries(s.decisionCache),
    triedDestinationUrls: Array.from(s.triedDestinationUrls),
    prefetchedSemanticPromise: undefined,
    prefetchedSemanticFingerprint: undefined,
  } as unknown as AgentGraphState;
}

function fromGraphState(s: AgentGraphState): LoopState {
  return {
    ...s,
    decisionCache: new Map(Object.entries(s.decisionCache ?? {})),
    triedDestinationUrls: new Set(s.triedDestinationUrls ?? []),
    prefetchedSemanticPromise: null,
    prefetchedSemanticFingerprint: null,
  } as LoopState;
}

type GraphConfig = { configurable?: { deps?: GraphDeps; input?: AgentRunInput } };

function getDeps(config: unknown): GraphDeps {
  return (config as GraphConfig)?.configurable?.deps!;
}

function getInput(config: unknown): AgentRunInput {
  return (config as GraphConfig)?.configurable?.input!;
}

export function buildAgentGraph() {
  const graph = new StateGraph(AgentStateAnnotation);

  const checkControls = async (
    state: AgentGraphState,
    config: unknown,
  ): Promise<Partial<AgentGraphState>> => {
    const deps = getDeps(config);
    const input = getInput(config);
    const loopState = fromGraphState(state);

    const updates: Partial<AgentGraphState> = {
      pageStuckFingerprint: state.observationFingerprint,
      pageStuckSince:
        state.observationFingerprint !== state.pageStuckFingerprint
          ? Date.now()
          : state.pageStuckSince,
      stepsWhenPageStuck:
        state.observationFingerprint !== state.pageStuckFingerprint
          ? state.steps
          : state.stepsWhenPageStuck,
    };

    if (state.observationFingerprint === state.pageStuckFingerprint && state.pageStuckSince == null) {
      updates.pageStuckSince = Date.now();
      updates.stepsWhenPageStuck = state.steps;
    }

    if (detectStuckLoop(loopState) && deps.canGoBack?.() && deps.goBack) {
      const fromUrl = state.observation.url;
      deps.goBack();
      await new Promise((r) => setTimeout(r, LOOP_GOBACK_WAIT_MS));
      const observed = await deps.observe();
      const fingerprint = getObservationFingerprint(observed);
      return {
        ...updates,
        observation: observed,
        observationFingerprint: fingerprint,
        pageStuckFingerprint: fingerprint,
        pageStuckSince: Date.now(),
        stepsWhenPageStuck: state.steps,
        lastSemanticFingerprint: "",
        decisionCache: {},
        contextLedger: [...(state.contextLedger ?? []), `loop_recovery: went back from ${fromUrl} to ${observed.url}`],
        timeline: pushTimeline(
          state.timeline,
          "plan",
          `Stuck on same page for ${LOOP_STUCK_MS / 1000}s. Going back.`,
        ),
        nextRoute: "observe",
      };
    }

    const hasStepLimit =
      Number.isFinite(deps.maxSteps) && deps.maxSteps > 0;
    if (hasStepLimit && state.steps >= deps.maxSteps) {
      return {
        ...updates,
        completed: true,
        finalAnswer: "Stopped after max steps. Review the summary and continue if needed.",
        timeline: pushTimeline(state.timeline, "plan", "Reached max steps."),
      };
    }

    if (state.stallCycles >= 3) {
      return {
        ...updates,
        completed: true,
        finalAnswer:
          "Recursion limit reached without hitting a stop condition. Increase max steps or refine the goal.",
        timeline: pushTimeline(
          state.timeline,
          "error",
          "Recursion limit reached before completion.",
        ),
      };
    }

    if (state.completion_point && deps.isAtCompletionPoint) {
      const atPoint = await deps.isAtCompletionPoint(
        state.observation,
        state.completion_point,
      );
      if (atPoint) {
        return {
          ...updates,
          completed: true,
          finalAnswer: `Reached the target: ${state.observation.url}. The page is ready for you to view or download.`,
          timeline: pushTimeline(
            state.timeline,
            "plan",
            `Reached completion point on ${state.observation.url}. Stopping.`,
          ),
        };
      }
    } else if (deps.isGoalAchieved) {
      const achieved = await deps.isGoalAchieved(state.observation, state.goal);
      if (achieved) {
        return {
          ...updates,
          completed: true,
          finalAnswer: `Found the target on ${state.observation.url}. The page is ready for you to view or download.`,
          timeline: pushTimeline(
            state.timeline,
            "plan",
            `Goal achieved on ${state.observation.url}. Stopping.`,
          ),
        };
      }
    }

    return { ...updates, nextRoute: "semantic" };
  };

  const observeNode = async (
    state: AgentGraphState,
    config: unknown,
  ): Promise<Partial<AgentGraphState>> => {
    const deps = getDeps(config);
    try {
      const observed = await withTimeout(
        deps.observe(),
        deps.verifyTimeoutMs,
        `Refresh timed out after ${deps.verifyTimeoutMs}ms`,
      );
      const fingerprint = getObservationFingerprint(observed);
      const noProgressCycles =
        fingerprint === state.observationFingerprint
          ? state.noProgressCycles + 1
          : 0;

      return {
        observation: observed,
        observationFingerprint: fingerprint,
        noProgressCycles,
        timeline: pushTimeline(
          state.timeline,
          "observe",
          `Observed ${observed.elements.length} actionable elements on ${observed.url}`,
        ),
        contextLedger: [
          ...(state.contextLedger ?? []),
          `observe: ${observed.url} (${observed.elements.length} elements)`,
        ],
        nextRoute: "checkControls",
      };
    } catch (error) {
      return {
        timeline: pushTimeline(
          state.timeline,
          "plan",
          error instanceof Error
            ? `${error.message}. Replanning automatically.`
            : "Refresh failed. Replanning automatically.",
        ),
        contextLedger: [
          ...(state.contextLedger ?? []),
          `refresh_error: ${error instanceof Error ? error.message : "unknown"}`,
        ],
        stallCycles: state.stallCycles + 1,
        nextRoute: "checkControls",
      };
    }
  };

  const semanticNode = async (
    state: AgentGraphState,
    config: unknown,
  ): Promise<Partial<AgentGraphState>> => {
    const deps = getDeps(config);
    const canReuseSemantic =
      deps.fastMode &&
      !!state.observationFingerprint &&
      state.observationFingerprint === state.lastSemanticFingerprint &&
      state.availableActions.length > 0;

    if (canReuseSemantic) {
      return {
        contextLedger: [
          ...(state.contextLedger ?? []),
          `semantic: reused for ${state.observation.url} with ${state.availableActions.length} choices`,
        ],
        nextRoute: "plan",
      };
    }

    try {
      const semantic = await deps.semanticInterpreter(state.observation, state.goal, {
        searchQuery: /google\.com/i.test(state.observation.url) ? state.searchQuery : undefined,
      });
      let choices = semantic.choices ?? [];
      if (
        state.searchQuery &&
        /google\.com/i.test(state.observation.url)
      ) {
        choices = choices.map((c) => {
          if (
            c.actionType === "type" &&
            c.actionValue &&
            (c.actionValue.includes("Inferred goal") || c.actionValue.length > 100)
          ) {
            return { ...c, actionValue: state.searchQuery!.slice(0, 120) };
          }
          return c;
        });
      }

      return {
        summary: semantic,
        availableActions: choices,
        currentStep: semantic.current_step ?? state.observation.title,
        lastSemanticFingerprint: state.observationFingerprint,
        contextLedger: [
          ...(state.contextLedger ?? []),
          `semantic: step=${semantic.current_step ?? state.observation.title}, choices=${choices.length}`,
        ],
        metrics: {
          ...state.metrics,
          semanticCalls: state.metrics.semanticCalls + 1,
        },
        nextRoute: "plan",
      };
    } catch (error) {
      return {
        timeline: pushTimeline(
          state.timeline,
          "plan",
          error instanceof Error
            ? `${error.message}. Replanning automatically.`
            : "Semantic failed. Replanning automatically.",
        ),
        contextLedger: [
          ...(state.contextLedger ?? []),
          `semantic_error: ${error instanceof Error ? error.message : "unknown"}`,
        ],
        stallCycles: state.stallCycles + 1,
        nextRoute: "checkControls",
      };
    }
  };

  const planNode = async (
    state: AgentGraphState,
    config: unknown,
  ): Promise<Partial<AgentGraphState>> => {
    const deps = getDeps(config);
    const input = getInput(config);
    const loopState = fromGraphState(state);
    const compacted = maybeCompactContext(loopState);

    let toolCall: LoopToolCall | null = null;
    const updates: Partial<AgentGraphState> = {
      compactedContext: compacted.compactedContext,
      contextLedger: compacted.contextLedger,
    };

    if (state.noProgressCycles >= 2) {
      const fallbackAction = getNavigateFallbackAction(compacted);
      if (fallbackAction) {
        toolCall = {
          kind: "execute_action",
          action: fallbackAction,
          source: "no-progress navigate fallback",
        };
        updates.noProgressFallbacks = state.noProgressFallbacks + 1;
        updates.timeline = pushTimeline(
          state.timeline,
          "plan",
          `No progress for ${state.noProgressCycles} cycles. Trying navigate fallback.`,
        );
      }
    }

    const decisionKey = getDecisionCacheKey(compacted);

    if (!toolCall) {
      const cachedCall = state.decisionCache?.[decisionKey];
      if (cachedCall) {
        const shouldSkip = cachedCall.kind === "execute_action";
        if (!shouldSkip) {
          toolCall = cachedCall;
          updates.metrics = {
            ...state.metrics,
            planCacheHits: state.metrics.planCacheHits + 1,
          };
          updates.timeline = pushTimeline(
            state.timeline,
            "plan",
            `Plan cache hit: ${cachedCall.kind === "ask_user" ? cachedCall.reason : cachedCall.source}`,
          );
        }
      }
    }

    if (!toolCall && deps.fastMode && state.stallCycles >= 3) {
      const deterministic = pickDeterministicAction(compacted);
      if (deterministic) {
        toolCall = {
          kind: "execute_action",
          action: deterministic.action,
          source: `stall breaker (${deterministic.source})`,
          label: deterministic.label,
          choiceIndex: deterministic.choiceIndex,
        };
        updates.metrics = {
          ...state.metrics,
          fastPathDecisions: state.metrics.fastPathDecisions + 1,
        };
        if (deterministic.choiceIndex != null) {
          updates.lastOfferedChoiceIndex = deterministic.choiceIndex;
        }
        updates.timeline = pushTimeline(
          state.timeline,
          "plan",
          `Stall breaker selected ${deterministic.source}${deterministic.label ? ` (${deterministic.label})` : ""}.`,
        );
      }
    }

    if (!toolCall && /\/search/i.test(state.observation.url)) {
      const firstLink = getFirstOrganicLinkFromPage(compacted);
      const deterministic = firstLink
        ? {
            action: firstLink.action,
            label: firstLink.label,
            choiceIndex: undefined as number | undefined,
            source: "deterministic first search result",
          }
        : pickDeterministicAction(compacted);
      if (deterministic) {
        toolCall = {
          kind: "execute_action",
          action: deterministic.action,
          source: deterministic.source,
          label: deterministic.label,
          choiceIndex: deterministic.choiceIndex,
        };
        updates.metrics = {
          ...state.metrics,
          fastPathDecisions: state.metrics.fastPathDecisions + 1,
        };
        if (deterministic.choiceIndex != null) {
          updates.lastOfferedChoiceIndex = deterministic.choiceIndex;
        }
        updates.timeline = pushTimeline(
          state.timeline,
          "plan",
          `First search result: ${deterministic.label ?? deterministic.source}`,
        );
      } else if (deps.canGoBack?.() && deps.goBack) {
        deps.goBack();
        await new Promise((r) => setTimeout(r, LOOP_GOBACK_WAIT_MS));
        const reobserved = await deps.observe();
        return {
          observation: reobserved,
          observationFingerprint: getObservationFingerprint(reobserved),
          lastSemanticFingerprint: "",
          decisionCache: {},
          contextLedger: [...(state.contextLedger ?? []), `search_exhausted: went back from ${state.observation.url}`],
          timeline: pushTimeline(state.timeline, "observe", `Back at ${reobserved.url}.`),
          nextRoute: "checkControls",
        };
      }
    }

    if (!toolCall) {
      const assembledGoal = buildPromptGoal(compacted, input);
      updates.timeline = pushTimeline(
        state.timeline,
        "plan",
        `Prompt assembled with ${state.availableActions.length + state.availableMcpTools.length} tool options.`,
      );
      updates.contextLedger = [
        ...(state.contextLedger ?? []),
        `prompt: sidebarTools=${state.availableActions.length}, mcpTools=${state.availableMcpTools.length}, step=${state.currentStep}`,
      ];

      const plan = await deps.plan({
        goal: assembledGoal,
        observation: state.observation,
        timeline: state.timeline,
        availableActions: state.availableActions,
        availableMcpTools: state.availableMcpTools,
        currentStep: state.currentStep,
        planSteps: state.planSteps,
        planStepIndex: state.planStepIndex,
      });

      updates.metrics = {
        ...(updates.metrics ?? state.metrics),
        planCalls: state.metrics.planCalls + 1,
      };

      if (plan.done) {
        return {
          ...updates,
          completed: true,
          finalAnswer: plan.finalAnswer,
          timeline: pushTimeline(
            state.timeline,
            "plan",
            `${plan.reasoning} (confidence ${plan.confidence.toFixed(2)})`,
          ),
          contextLedger: [
            ...(state.contextLedger ?? []),
            ...(updates.contextLedger ?? []),
            `assistant: done (confidence=${plan.confidence.toFixed(2)})`,
          ],
        };
      }

      toolCall = resolveToolCallFromPlan(
        plan,
        state.availableActions,
        state.availableMcpTools,
      );
      if (toolCall.kind === "execute_mcp") {
        updates.decisionCache = {
          ...state.decisionCache,
          [decisionKey]: toolCall,
        };
      }
      if (toolCall.kind === "execute_action" && toolCall.choiceIndex != null) {
        updates.lastOfferedChoiceIndex = toolCall.choiceIndex;
      }
      if (toolCall.kind === "execute_action" || toolCall.kind === "execute_mcp") {
        updates.timeline = pushTimeline(
          state.timeline,
          "plan",
          `${plan.reasoning} -> ${toolCall.source}${toolCall.kind === "execute_action" && toolCall.label ? ` (${toolCall.label})` : ""} (confidence ${plan.confidence.toFixed(2)})`,
        );
      }
    }

    if (toolCall) {
      updates.toolCall = toolCall;
      if (toolCall.kind === "ask_user") {
        updates.nextRoute = "askUser";
      } else {
        updates.nextRoute = "execute";
      }
    } else {
      updates.nextRoute = "checkControls";
    }

    return updates;
  };

  const askUserNode = async (
    state: AgentGraphState,
    config: unknown,
  ): Promise<Partial<AgentGraphState>> => {
    const deps = getDeps(config);
    const toolCall = state.toolCall;
    if (!toolCall || toolCall.kind !== "ask_user") {
      return { nextRoute: "checkControls" };
    }

    if (toolCall.reason !== "planner_ask") {
      return {
        goal: `${state.goal}\nPlanner correction: ${toolCall.question}`,
        stallCycles: state.stallCycles + 1,
        contextLedger: [...(state.contextLedger ?? []), `planner_feedback: ${toolCall.reason}`],
        timeline: pushTimeline(state.timeline, "plan", `${toolCall.question} Replanning automatically.`),
        toolCall: null,
        nextRoute: "checkControls",
      };
    }

    const base = shortQuestion(toolCall.question);
    const question = `${base} (Enter=skip)`;

    const answer = await deps.askUser(question);
    const trimmed = (answer ?? "").trim();

    if (!trimmed) {
      return {
        goal: `${state.goal}\nUser skipped clarification. Choose best next option.`,
        stallCycles: state.stallCycles + 1,
        contextLedger: [...(state.contextLedger ?? []), "user: skipped clarification"],
        timeline: pushTimeline(state.timeline, "user", "User skipped question. Re-evaluating best option."),
        toolCall: null,
        nextRoute: "checkControls",
      };
    }

    let choiceIndex: number | null = null;
    if (deps.resolveUserChoice && state.availableActions.length > 0) {
      choiceIndex = await deps.resolveUserChoice(trimmed, state.availableActions, toolCall.question);
    }

    if (choiceIndex != null) {
      const selected = state.availableActions[choiceIndex - 1];
      const selectedAction = selected ? choiceToAction(selected) : null;
      if (selectedAction) {
        return {
          toolCall: {
            kind: "execute_action",
            action: selectedAction,
            source: `user selected option ${choiceIndex}`,
            label: selected?.label,
            choiceIndex,
          },
          lastOfferedChoiceIndex: choiceIndex,
          goal: `${state.goal}\nUser selected option ${choiceIndex}.`,
          stallCycles: 0,
          timeline: pushTimeline(state.timeline, "user", `User clarification: ${trimmed}`),
          nextRoute: "execute",
        };
      }
      return {
        goal: `${state.goal}\nUser selected non-executable option ${choiceIndex}.`,
        stallCycles: state.stallCycles + 1,
        toolCall: null,
        nextRoute: "checkControls",
      };
    }

    if (deps.refineGoalFromUserInput) {
      try {
        const refined = await deps.refineGoalFromUserInput(
          state.goal,
          trimmed,
          toolCall.question,
        );
        return {
          goal: refined.refinedGoal,
          completion_point: refined.completion_point ?? state.completion_point,
          planSteps: refined.planSteps ?? state.planSteps,
          searchQuery: refined.searchQuery ?? state.searchQuery,
          planStepIndex: 0,
          contextLedger: [...(state.contextLedger ?? []), `user: ${trimmed}`],
          decisionCache: {},
          stallCycles: 0,
          timeline: pushTimeline(
            state.timeline,
            "user",
            `User clarification: ${trimmed}. Goal updated.`,
          ),
          toolCall: null,
          nextRoute: "checkControls",
        };
      } catch (err) {
        logMain("agent", "refineGoalFromUserInput failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      goal: `${state.goal}\nUser clarification: ${trimmed}`,
      contextLedger: [...(state.contextLedger ?? []), `user: ${trimmed}`],
      decisionCache: {},
      stallCycles: 0,
      timeline: pushTimeline(state.timeline, "user", `User clarification: ${trimmed}`),
      toolCall: null,
      nextRoute: "checkControls",
    };
  };

  const executeNode = async (
    state: AgentGraphState,
    config: unknown,
  ): Promise<Partial<AgentGraphState>> => {
    const deps = getDeps(config);
    const toolCall = state.toolCall;
    if (!toolCall || (toolCall.kind !== "execute_action" && toolCall.kind !== "execute_mcp")) {
      return { nextRoute: "checkControls" };
    }

    if (toolCall.kind === "execute_mcp") {
      const toolLabel = `${toolCall.call.server}/${toolCall.call.name}`;
      try {
        const result = await withTimeout(
          deps.callMcpTool(toolCall.call),
          deps.actionTimeoutMs,
          `MCP tool timed out after ${deps.actionTimeoutMs}ms`,
        );
        const snippet = result.content.slice(0, 1200);
        return {
          timeline: pushTimeline(state.timeline, "act", `MCP ${toolLabel}: ${result.ok ? "ok" : "failed"}`),
          contextLedger: [
            ...(state.contextLedger ?? []),
            `tool_call: execute_mcp ${toolLabel}`,
            `tool_result: mcp ${result.ok ? "success" : "failure"} ${toolLabel} ${snippet}`,
          ],
          goal: result.ok
            ? `${state.goal}\nMCP result (${toolLabel}): ${snippet}`
            : `${state.goal}\nMCP tool ${toolLabel} failed: ${snippet}`,
          steps: result.ok ? state.steps + 1 : state.steps,
          stallCycles: result.ok ? 0 : state.stallCycles + 1,
          metrics: {
            ...state.metrics,
            mcpCalls: state.metrics.mcpCalls + 1,
          },
          toolCall: null,
          nextRoute: "checkControls",
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `MCP tool ${toolLabel} failed`;
        return {
          timeline: pushTimeline(state.timeline, "plan", `${message}. Replanning automatically.`),
          contextLedger: [...(state.contextLedger ?? []), `tool_result: mcp_error ${toolLabel} ${message}`],
          goal: `${state.goal}\nMCP error (${toolLabel}): ${message}`,
          stallCycles: state.stallCycles + 1,
          toolCall: null,
          nextRoute: "checkControls",
        };
      }
    }

    const action = toolCall.action;
    const signature = getActionSignature(action);
    const actionDesc = describeAction(action);

    const choiceContext =
      toolCall.kind === "execute_action" ? toolCall.label : undefined;
    if (deps.isStopAction?.(action, choiceContext)) {
      return {
        timeline: pushTimeline(
          state.timeline,
          "plan",
          `Stopped before auth/login/payment or user info. ${actionDesc} requires strict user intervention. Replanning.`,
        ),
        decisionCache: {},
        contextLedger: [...(state.contextLedger ?? []), `tool_result: stop_before_auth_payment ${actionDesc}`],
        goal: `${state.goal}\nStopped: this action requires user auth, login, payment, or personal info. Try a different approach.`,
        stallCycles: state.stallCycles + 1,
        toolCall: null,
        nextRoute: "checkControls",
      };
    }

    if (deps.enableSafetyGuardrails) {
      const validation = await deps.safetySupervisor(state.goal, action, {
        url: state.observation.url,
        currentStep: state.currentStep,
      });

      if (!validation.approved) {
        return {
          timeline: pushTimeline(
            state.timeline,
            "plan",
            `Guardrails rejected action: ${validation.reason}. Replanning automatically.`,
          ),
          decisionCache: {},
          contextLedger: [...(state.contextLedger ?? []), `tool_result: guardrails_reject ${validation.reason}`],
          goal: `${state.goal}\nSafety feedback: ${validation.reason}`,
          stallCycles: state.stallCycles + 1,
          metrics: {
            ...state.metrics,
            safetyCalls: state.metrics.safetyCalls + 1,
          },
          toolCall: null,
          nextRoute: "checkControls",
        };
      }

      if (
        deps.requireApprovalForRiskyActions &&
        (validation.requiresHITL || deps.isRiskyForHITL(action))
      ) {
        const confirmQuestion = `Confirm ${actionDesc}? yes/no (Enter=skip)`;
        const confirmAnswer = await deps.askUser(confirmQuestion);
        if (!confirmAnswer || !/^\s*yes\s*$/i.test(confirmAnswer)) {
          return {
            timeline: pushTimeline(state.timeline, "user", "User declined/skip. Re-evaluating best option."),
            decisionCache: {},
            contextLedger: [...(state.contextLedger ?? []), "tool_result: hitl_declined_or_skipped"],
            stallCycles: state.stallCycles + 1,
            toolCall: null,
            nextRoute: "checkControls",
          };
        }
      }
    }

    const loopState = fromGraphState(state);
    const exec = await executeActionWithRetries(deps, action, state.timeline);

    if (!exec.ok) {
      const nextStreak = (state.actionFailureStreak[signature] ?? 0) + 1;
      if (exec.reason === "target_not_found") {
        const timelineWithMessage = pushTimeline(
          exec.timeline,
          "plan",
          "Target missing. Refreshing observation and semantic options immediately.",
        );
        const refreshed = await refreshObservationAndSemantic(
          deps,
          { ...loopState, timeline: timelineWithMessage },
          "after target not found",
        );
        return {
          ...toGraphState(refreshed),
          actionFailureStreak: { ...state.actionFailureStreak, [signature]: nextStreak },
          decisionCache: {},
          contextLedger: [
            ...refreshed.contextLedger,
            `tool_result: failed_target_not_found ${exec.lastMessage}`,
          ],
          stallCycles: state.stallCycles + 1,
          toolCall: null,
          nextRoute: "checkControls",
        };
      }
      return {
        timeline: pushTimeline(
          exec.timeline,
          "plan",
          `Action failed after ${deps.maxRetriesPerStep + 1} attempts. Replanning automatically.`,
        ),
        actionFailureStreak: { ...state.actionFailureStreak, [signature]: nextStreak },
        decisionCache: {},
        contextLedger: [...(state.contextLedger ?? []), `tool_result: failed ${exec.lastMessage}`],
        goal: `${state.goal}\nTool error: ${exec.lastMessage}`,
        stallCycles: state.stallCycles + 1,
        toolCall: null,
        nextRoute: "checkControls",
      };
    }

    const prevFingerprint = state.observationFingerprint;
    let observed = await withTimeout(
      deps.observe(),
      deps.verifyTimeoutMs,
      `Verification timed out after ${deps.verifyTimeoutMs}ms`,
    );
    let nextFingerprint = getObservationFingerprint(observed);
    if (
      nextFingerprint === prevFingerprint &&
      (action.type === "type" || action.type === "navigate")
    ) {
      await new Promise((r) => setTimeout(r, 2000));
      observed = await withTimeout(
        deps.observe(),
        deps.verifyTimeoutMs,
        `Verification timed out after ${deps.verifyTimeoutMs}ms`,
      );
      nextFingerprint = getObservationFingerprint(observed);
    }
    // After landing on a new page (navigate/click), wait at least 5 seconds for the page to load before deciding.
    if (
      nextFingerprint !== prevFingerprint &&
      (action.type === "navigate" || action.type === "click")
    ) {
      await new Promise((r) => setTimeout(r, 5000));
      observed = await withTimeout(
        deps.observe(),
        deps.verifyTimeoutMs,
        `Post-landing observe timed out after ${deps.verifyTimeoutMs}ms`,
      );
      nextFingerprint = getObservationFingerprint(observed);
    }
    const noProgressCycles =
      nextFingerprint === prevFingerprint ? state.noProgressCycles + 1 : 0;

    let planStepIndex = state.planStepIndex;
    if (
      nextFingerprint !== prevFingerprint &&
      state.planSteps.length > 0 &&
      state.planStepIndex < state.planSteps.length - 1
    ) {
      planStepIndex += 1;
    }

    let triedUrls = state.triedDestinationUrls ?? [];
    let finalObserved = observed;
    let finalFingerprint = nextFingerprint;

    if (
      nextFingerprint !== prevFingerprint &&
      (action.type === "navigate" || action.type === "click") &&
      deps.isPageRelevantToGoal &&
      deps.canGoBack?.() &&
      deps.goBack
    ) {
      // Use post-landing observation (already waited 5s above).
      const recheckObserved = observed;
      // Analyze page before go-back: only go back if no forward route is possible.
      const semantic = await deps.semanticInterpreter(recheckObserved, state.goal, {
        searchQuery: /google\.com/i.test(recheckObserved.url) ? state.searchQuery : undefined,
      });
      const hasForwardRoute = (semantic.choices ?? []).some((c) => choiceToAction(c) != null);
      if (hasForwardRoute) {
        // Page has actionable elements (search box, buttons, etc.) — do not go back.
        return {
          observation: recheckObserved,
          observationFingerprint: getObservationFingerprint(recheckObserved),
          lastSemanticFingerprint: getObservationFingerprint(recheckObserved),
          availableActions: semantic.choices ?? [],
          currentStep: semantic.current_step ?? recheckObserved.title,
          summary: semantic,
          metrics: {
            ...state.metrics,
            semanticCalls: state.metrics.semanticCalls + 1,
          },
          noProgressCycles,
          planStepIndex,
          steps: state.steps + 1,
          stallCycles: 0,
          executedActions: [action],
          actionFailureStreak: { ...state.actionFailureStreak, [signature]: 0 },
          contextLedger: [
            ...(state.contextLedger ?? []),
            `tool_call: execute_action ${actionDesc}`,
            `tool_result: success ${exec.lastMessage}`,
            `observe: ${recheckObserved.url} (${recheckObserved.elements.length} elements, has forward route)`,
          ],
          timeline: pushTimeline(
            exec.timeline,
            "observe",
            `Observed ${recheckObserved.elements.length} actionable elements on ${recheckObserved.url} (post-action verification)`,
          ),
          toolCall: null,
          nextRoute: "checkControls",
        };
      }
      const relevant = await deps.isPageRelevantToGoal(recheckObserved, state.goal, {
        planSteps: state.planSteps,
        planStepIndex,
      });
      if (!relevant) {
        triedUrls = [...triedUrls, normalizeUrlForTried(recheckObserved.url)];
        deps.goBack();
        await new Promise((r) => setTimeout(r, LOOP_GOBACK_WAIT_MS));
        const reobserved = await deps.observe();
        finalObserved = reobserved;
        finalFingerprint = getObservationFingerprint(reobserved);
        return {
          observation: finalObserved,
          observationFingerprint: finalFingerprint,
          lastSemanticFingerprint: "",
          decisionCache: {},
          triedDestinationUrls: triedUrls,
          steps: state.steps + 1,
          stallCycles: 0,
          executedActions: [action],
          actionFailureStreak: { ...state.actionFailureStreak, [signature]: 0 },
          contextLedger: [
            ...(state.contextLedger ?? []),
            `tool_call: execute_action ${actionDesc}`,
            `tool_result: success ${exec.lastMessage}`,
            `page_relevance: went back from irrelevant ${recheckObserved.url}`,
          ],
          timeline: pushTimeline(
            exec.timeline,
            "observe",
            `Back at ${finalObserved.url}. Trying a different option.`,
          ),
          toolCall: null,
          nextRoute: "checkControls",
        };
      }
    }

    return {
      observation: finalObserved,
      observationFingerprint: finalFingerprint,
      noProgressCycles,
      planStepIndex,
      steps: state.steps + 1,
      stallCycles: 0,
      executedActions: [action],
      actionFailureStreak: { ...state.actionFailureStreak, [signature]: 0 },
      contextLedger: [
        ...(state.contextLedger ?? []),
        `tool_call: execute_action ${actionDesc}`,
        `tool_result: success ${exec.lastMessage}`,
        `observe: ${finalObserved.url} (${finalObserved.elements.length} elements, noProgress=${noProgressCycles})`,
      ],
      timeline: pushTimeline(
        exec.timeline,
        "observe",
        `Observed ${finalObserved.elements.length} actionable elements on ${finalObserved.url} (post-action verification)`,
      ),
      toolCall: null,
      nextRoute: "checkControls",
    };
  };

  graph.addNode("checkControls", checkControls as any);
  graph.addNode("observe", observeNode as any);
  graph.addNode("semantic", semanticNode as any);
  graph.addNode("plan", planNode as any);
  graph.addNode("askUser", askUserNode as any);
  graph.addNode("execute", executeNode as any);

  graph.addEdge(START, "checkControls" as any);

  const routeFromCheck = (s: AgentGraphState) => {
    if (s.completed) return "end";
    if (s.nextRoute === "observe") return "observe";
    return "semantic";
  };
  graph.addConditionalEdges("checkControls" as any, routeFromCheck as any, {
    end: END,
    observe: "observe",
    semantic: "semantic",
  } as any);

  graph.addEdge("observe" as any, "checkControls" as any);

  const routeFromPlan = (s: AgentGraphState) => {
    if (s.completed) return "end";
    if (s.nextRoute === "askUser") return "askUser";
    if (s.nextRoute === "execute") return "execute";
    return "checkControls";
  };
  graph.addConditionalEdges("semantic" as any, ((s: AgentGraphState) => s.nextRoute ?? "plan") as any, {
    plan: "plan",
    checkControls: "checkControls",
  } as any);
  graph.addConditionalEdges("plan" as any, routeFromPlan as any, {
    end: END,
    askUser: "askUser",
    execute: "execute",
    checkControls: "checkControls",
  } as any);

  graph.addConditionalEdges("askUser" as any, ((s: AgentGraphState) => s.nextRoute ?? "checkControls") as any, {
    execute: "execute",
    checkControls: "checkControls",
  } as any);
  graph.addEdge("execute" as any, "checkControls" as any);

  return graph.compile();
}
