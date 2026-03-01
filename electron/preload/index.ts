import { contextBridge, ipcRenderer } from "electron";
import type {
  McpToolCall,
  PageObservation,
  PlanActionInput,
} from "../../shared/types";
import type { ActionExecutionResult, BrowserAction } from "../../shared/types";

type AgentHandlers = {
  observe: () => Promise<PageObservation>;
  act: (action: BrowserAction) => Promise<ActionExecutionResult>;
  goBack: () => void;
  canGoBack: () => boolean;
  askUser: (question: string) => Promise<string | null>;
  onEvent?: (kind: string, message: string) => void;
};

let agentHandlers: AgentHandlers | null = null;

function setupAgentIpcListeners() {
  ipcRenderer.on("agent:requestObserve", async () => {
    try {
      const result = agentHandlers ? await agentHandlers.observe() : null;
      if (result) {
        await ipcRenderer.invoke("agent:observeResult", { ok: true, result });
      } else {
        await ipcRenderer.invoke("agent:observeResult", { ok: false, error: "No handlers" });
      }
    } catch (error) {
      await ipcRenderer.invoke("agent:observeResult", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ipcRenderer.on("agent:requestAct", async (_event: Electron.IpcRendererEvent, action: BrowserAction) => {
    try {
      const result = agentHandlers
        ? await agentHandlers.act(action)
        : { ok: false, message: "No handlers registered", action };
      await ipcRenderer.invoke("agent:actResult", result);
    } catch (error) {
      await ipcRenderer.invoke("agent:actResult", {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        action,
      });
    }
  });

  ipcRenderer.on("agent:requestGoBack", () => {
    agentHandlers?.goBack();
    void ipcRenderer.invoke("agent:goBackResult");
  });

  ipcRenderer.on("agent:requestCanGoBack", () => {
    const result = agentHandlers?.canGoBack?.() ?? false;
    void ipcRenderer.invoke("agent:canGoBackResult", result);
  });

  ipcRenderer.on("agent:requestAskUser", async (_event: Electron.IpcRendererEvent, question: string) => {
    try {
      const result = agentHandlers ? await agentHandlers.askUser(question) : null;
      await ipcRenderer.invoke("agent:askUserResult", result);
    } catch {
      await ipcRenderer.invoke("agent:askUserResult", null);
    }
  });

  ipcRenderer.on("agent:event", (_event: Electron.IpcRendererEvent, payload: { kind: string; message: string }) => {
    agentHandlers?.onEvent?.(payload.kind, payload.message);
  });
}

setupAgentIpcListeners();

const api = {
  getPublicConfig: () => ipcRenderer.invoke("config:getPublic"),
  getSystemContext: () => ipcRenderer.invoke("agent:getSystemContext"),
  summarizePage: (observation: PageObservation) =>
    ipcRenderer.invoke("llm:summarizePage", observation),
  inferIntent: (rawGoal: string) => ipcRenderer.invoke("llm:inferIntent", rawGoal),
  respondConversationally: (userMessage: string) =>
    ipcRenderer.invoke("llm:respondConversationally", userMessage),
  semanticInterpreter: (
    observation: PageObservation,
    userGoal: string,
    opts?: { searchQuery?: string },
  ) =>
    ipcRenderer.invoke("llm:semanticInterpreter", {
      observation,
      userGoal,
      searchQuery: opts?.searchQuery,
    }),
  safetySupervisor: (payload: {
    userGoal: string;
    action: import("../../shared/types").BrowserAction;
    context: { url: string; currentStep?: string };
  }) => ipcRenderer.invoke("llm:safetySupervisor", payload),
  planAction: (payload: PlanActionInput) => ipcRenderer.invoke("llm:planAction", payload),
  listMcpTools: () => ipcRenderer.invoke("mcp:listTools"),
  callMcpTool: (payload: McpToolCall) => ipcRenderer.invoke("mcp:callTool", payload),
  isPageRelevantToGoal: (payload: {
    observation: PageObservation;
    goal: string;
    planSteps?: string[];
    planStepIndex?: number;
  }) => ipcRenderer.invoke("llm:isPageRelevantToGoal", payload),
  isGoalAchieved: (payload: { observation: PageObservation; goal: string }) =>
    ipcRenderer.invoke("llm:isGoalAchieved", payload),
  isAtCompletionPoint: (payload: {
    observation: PageObservation;
    completionPoint: string;
  }) => ipcRenderer.invoke("llm:isAtCompletionPoint", payload),
  speak: (text: string): Promise<string> => ipcRenderer.invoke("tts:speak", text),
  registerAgentHandlers: (handlers: AgentHandlers | null) => {
    agentHandlers = handlers;
  },
  runAgent: (params: {
    runId: string;
    goal: string;
    mode: "manual" | "assist" | "auto";
    resolvedGoal?: string;
    searchQuery?: string;
    planSteps?: string[];
    completion_point?: string;
    systemContext?: { cwd?: string; agentsInstructions?: string; platform?: string; nodeVersion?: string };
    maxSteps: number;
    actionTimeoutMs: number;
    verifyTimeoutMs: number;
    maxRetriesPerStep: number;
    fastMode: boolean;
    enableSafetyGuardrails: boolean;
    requireApprovalForRiskyActions: boolean;
  }) => ipcRenderer.invoke("agent:run", params),
  abortAgent: (runId: string) => ipcRenderer.invoke("agent:abort", runId),
};

contextBridge.exposeInMainWorld("steadyhands", api);
