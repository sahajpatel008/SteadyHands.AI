/**
 * Runs the agent graph in the main process (Node.js) so LangGraph's
 * node:async_hooks dependency works. Requests observe, act, goBack,
 * canGoBack, askUser from the renderer via IPC.
 */
import { WebContents } from "electron";
import { ipcMain } from "electron";
import { runAgentGraph } from "../../src/lib/agentGraph";
import {
  inferIntent,
  isAtCompletionPoint,
  isGoalAchieved,
  isPageRelevantToGoal,
  planAction,
  refineGoalFromUserInput,
  resolveUserChoiceToIndex,
  safetySupervisor,
  semanticInterpreter,
} from "./llm";
import { getConfig } from "./config";
import { logMain } from "../../shared/logger";
import { isRiskyAction, isStopAction } from "../../shared/isRiskyAction";
import type {
  ActionExecutionResult,
  AgentRunInput,
  AgentRunOutput,
  BrowserAction,
  McpToolDescriptor,
  PageObservation,
  PlanActionInput,
  SafetyValidationResult,
} from "../../shared/types";
import type { GraphDeps } from "../../src/lib/agentGraph";
import type { McpClientManager } from "./mcp";

type AgentRunParams = {
  runId: string;
  goal: string;
  mode: "manual" | "assist" | "auto";
  resolvedGoal?: string;
  searchQuery?: string;
  planSteps?: string[];
  completion_point?: string;
  systemContext?: AgentRunInput["systemContext"];
  maxSteps: number;
  actionTimeoutMs: number;
  verifyTimeoutMs: number;
  maxRetriesPerStep: number;
  fastMode: boolean;
  enableSafetyGuardrails: boolean;
  requireApprovalForRiskyActions: boolean;
};

const pendingObserve = { resolve: null as ((v: PageObservation) => void) | null };
let pendingObserveReject: ((err: Error) => void) | null = null;
const pendingAct = { resolve: null as ((v: ActionExecutionResult) => void) | null };
const pendingGoBack = { resolve: null as (() => void) | null };
const pendingCanGoBack = { resolve: null as ((v: boolean) => void) | null };
const pendingAskUser = { resolve: null as ((v: string | null) => void) | null };

const runAbortControllers = new Map<string, AbortController>();

function requestObserveFromRenderer(webContents: WebContents): Promise<PageObservation> {
  return new Promise<PageObservation>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingObserve.resolve) {
        pendingObserve.resolve = null;
        pendingObserveReject = null;
        reject(new Error("Observe request timed out"));
      }
    }, 30000);
    pendingObserve.resolve = (result) => {
      clearTimeout(timeout);
      pendingObserve.resolve = null;
      pendingObserveReject = null;
      resolve(result);
    };
    pendingObserveReject = (err) => {
      clearTimeout(timeout);
      pendingObserve.resolve = null;
      pendingObserveReject = null;
      reject(err);
    };
    webContents.send("agent:requestObserve");
  });
}

function requestActFromRenderer(webContents: WebContents, action: BrowserAction): Promise<ActionExecutionResult> {
  return new Promise<ActionExecutionResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAct.resolve) {
        pendingAct.resolve = null;
        reject(new Error("Act request timed out"));
      }
    }, 15000);
    pendingAct.resolve = (result) => {
      clearTimeout(timeout);
      pendingAct.resolve = null;
      resolve(result);
    };
    webContents.send("agent:requestAct", action);
  });
}

function requestGoBackFromRenderer(webContents: WebContents): Promise<void> {
  return new Promise<void>((resolve) => {
    pendingGoBack.resolve = () => {
      pendingGoBack.resolve = null;
      resolve();
    };
    webContents.send("agent:requestGoBack");
  });
}

function requestCanGoBackFromRenderer(webContents: WebContents): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pendingCanGoBack.resolve = (result) => {
      pendingCanGoBack.resolve = null;
      resolve(result);
    };
    webContents.send("agent:requestCanGoBack");
  });
}

function requestAskUserFromRenderer(webContents: WebContents, question: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingAskUser.resolve) {
        pendingAskUser.resolve = null;
        resolve(null);
      }
    }, 300000); // 5 min for user to answer
    pendingAskUser.resolve = (result) => {
      clearTimeout(timeout);
      pendingAskUser.resolve = null;
      resolve(result);
    };
    webContents.send("agent:requestAskUser", question);
  });
}

export function setupAgentIpcHandlers(
  getWebContents: () => WebContents | null,
  getMcpManager: () => McpClientManager | null,
) {
  ipcMain.handle(
    "agent:observeResult",
    (_, payload: { ok: true; result: PageObservation } | { ok: false; error: string }) => {
      if (payload.ok) {
        pendingObserve.resolve?.(payload.result);
      } else {
        pendingObserve.resolve = null;
        // Resolve will reject - we need to reject the promise. Store a reject fn too.
        pendingObserveReject?.(new Error(payload.error));
      }
      return undefined;
    },
  );

  ipcMain.handle("agent:actResult", (_, result: ActionExecutionResult) => {
    pendingAct.resolve?.(result);
    return undefined;
  });

  ipcMain.handle("agent:goBackResult", () => {
    pendingGoBack.resolve?.();
    return undefined;
  });

  ipcMain.handle("agent:canGoBackResult", (_, result: boolean) => {
    pendingCanGoBack.resolve?.(result);
    return undefined;
  });

  ipcMain.handle("agent:askUserResult", (_, result: string | null) => {
    pendingAskUser.resolve?.(result);
    return undefined;
  });

  ipcMain.handle("agent:abort", (_, runId: string) => {
    const controller = runAbortControllers.get(runId);
    if (controller) {
      controller.abort();
      runAbortControllers.delete(runId);
    }
    return undefined;
  });

  ipcMain.handle(
    "agent:run",
    async (
      _,
      params: AgentRunParams,
    ): Promise<AgentRunOutput> => {
      const webContents = getWebContents();
      if (!webContents) {
        throw new Error("No renderer window available");
      }

      const controller = new AbortController();
      runAbortControllers.set(params.runId, controller);

      try {
        const initialObservation = await requestObserveFromRenderer(webContents);
        const config = getConfig();
        const mcpManager = getMcpManager();

        let availableMcpTools: McpToolDescriptor[] = [];
        if (mcpManager) {
          try {
            availableMcpTools = await mcpManager.listTools();
          } catch {
            // continue without MCP
          }
        }

        const deps: GraphDeps = {
          inferIntent: (rawGoal) => inferIntent(rawGoal),
          observe: () => requestObserveFromRenderer(webContents),
          semanticInterpreter: (obs, userGoal, opts) =>
            semanticInterpreter(obs, userGoal, { searchQuery: opts?.searchQuery }),
          plan: (input: PlanActionInput) => planAction(input),
          safetySupervisor: (userGoal, action, context) =>
            safetySupervisor(userGoal, action, context),
          act: (action) => requestActFromRenderer(webContents, action),
          goBack: () => requestGoBackFromRenderer(webContents),
          canGoBack: () => requestCanGoBackFromRenderer(webContents),
          isPageRelevantToGoal: (obs, g, opts) =>
            isPageRelevantToGoal(obs, g, {
              planSteps: opts?.planSteps,
              planStepIndex: opts?.planStepIndex,
            }),
          isGoalAchieved: (obs, g) => isGoalAchieved(obs, g),
          isAtCompletionPoint: (obs, cp) => isAtCompletionPoint(obs, cp),
          listMcpTools: async () => mcpManager?.listTools() ?? [],
          callMcpTool: async (call) => {
            if (!mcpManager) throw new Error("MCP manager unavailable");
            return mcpManager.callTool(call);
          },
          askUser: (q) => requestAskUserFromRenderer(webContents, q),
          resolveUserChoice: (answer, choices, question) =>
            resolveUserChoiceToIndex(answer, choices, question),
          refineGoalFromUserInput: (goal, answer, question) =>
            refineGoalFromUserInput(goal, answer, question),
          isRiskyForHITL: isRiskyAction,
          isStopAction,
          maxSteps: params.maxSteps,
          actionTimeoutMs: params.actionTimeoutMs,
          verifyTimeoutMs: params.verifyTimeoutMs,
          maxRetriesPerStep: params.maxRetriesPerStep,
          fastMode: params.fastMode,
          enableSafetyGuardrails: params.enableSafetyGuardrails,
          requireApprovalForRiskyActions: params.requireApprovalForRiskyActions,
          onEvent: (kind, message) => {
            webContents.send("agent:event", { kind, message });
          },
        };

        const input: AgentRunInput = {
          goal: params.goal,
          mode: params.mode,
          initialObservation,
          resolvedGoal: params.resolvedGoal,
          searchQuery: params.searchQuery,
          planSteps: params.planSteps,
          completion_point: params.completion_point,
          signal: controller.signal,
          systemContext: params.systemContext,
        };

        logMain("agent", "runAgentGraph start", { goal: params.goal?.slice(0, 60), runId: params.runId });
        const output = await runAgentGraph(deps, input);
        logMain("agent", "runAgentGraph done", { completed: output.completed, runId: params.runId });
        return output;
      } finally {
        runAbortControllers.delete(params.runId);
      }
    },
  );
}
