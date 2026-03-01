import type {
  AgentTimelineEvent,
  BrowserAction,
  McpToolCall,
  McpToolCallResult,
  McpToolDescriptor,
  PageObservation,
} from "../../shared/types";

declare global {
  interface Window {
    steadyhands: {
      getPublicConfig: () => Promise<{
        plannerModel: string;
        summarizerModel: string;
        maxSteps: number;
        defaultAgentMode: "manual" | "assist" | "auto";
        observeTextLimit: number;
        actionTimeoutMs: number;
        verifyTimeoutMs: number;
        maxRetriesPerStep: number;
        fastMode: boolean;
        enableSafetyGuardrails: boolean;
        requireApprovalForRiskyActions: boolean;
        enableAutoHighlight: boolean;
        logLevel: "debug" | "info" | "warn" | "error";
        confidenceThreshold: number;
      }>;
      getSystemContext: () => Promise<{
        cwd?: string;
        agentsInstructions?: string;
        platform?: string;
        nodeVersion?: string;
      }>;
      summarizePage: (observation: PageObservation) => Promise<unknown>;
      inferIntent: (rawGoal: string) => Promise<{
        prompt_type?: "conversational" | "task";
        inferredGoal: string;
        plan: string;
        clarifyingQuestion?: string;
        choices: Array<{ label: string; goal: string }>;
      }>;
      respondConversationally: (userMessage: string) => Promise<string>;
      semanticInterpreter: (
        observation: PageObservation,
        userGoal: string,
        opts?: { searchQuery?: string },
      ) => Promise<unknown>;
      safetySupervisor: (payload: {
        userGoal: string;
        action: BrowserAction;
        context: { url: string; currentStep?: string };
      }) => Promise<unknown>;
      listMcpTools: () => Promise<McpToolDescriptor[]>;
      callMcpTool: (payload: McpToolCall) => Promise<McpToolCallResult>;
      planAction: (payload: {
        goal: string;
        observation: PageObservation;
        timeline: AgentTimelineEvent[];
        availableActions: import("../../shared/types").SidebarChoice[];
        availableMcpTools?: McpToolDescriptor[];
        currentStep?: string;
      }) => Promise<unknown>;
      isPageRelevantToGoal: (payload: {
        observation: PageObservation;
        goal: string;
        planSteps?: string[];
        planStepIndex?: number;
      }) => Promise<boolean>;
      isGoalAchieved: (payload: { observation: PageObservation; goal: string }) => Promise<boolean>;
      isAtCompletionPoint: (payload: {
        observation: PageObservation;
        completionPoint: string;
      }) => Promise<boolean>;
      speak: (text: string) => Promise<string>;
    };
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: string;
          webpreferences?: string;
        },
        HTMLElement
      >;
    }
  }
}

export {};
