import { contextBridge, ipcRenderer } from "electron";
import type {
  McpToolCall,
  PageObservation,
  PlanActionInput,
} from "../../shared/types";

const api = {
  getPublicConfig: () => ipcRenderer.invoke("config:getPublic"),
  getSystemContext: () => ipcRenderer.invoke("agent:getSystemContext"),
  summarizePage: (observation: PageObservation) =>
    ipcRenderer.invoke("llm:summarizePage", observation),
  inferIntent: (rawGoal: string) => ipcRenderer.invoke("llm:inferIntent", rawGoal),
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
};

contextBridge.exposeInMainWorld("steadyhands", api);
