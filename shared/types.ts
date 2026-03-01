export type AgentMode = "manual" | "assist" | "auto";

export type SidebarActionType =
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "navigate";

export type ElementSnapshot = {
  id: string;
  tag: string;
  role: string | null;
  text: string;
  ariaLabel: string | null;
  href: string | null;
  type: string | null;
  placeholder: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PageObservation = {
  title: string;
  url: string;
  mainText: string;
  elements: ElementSnapshot[];
  screenshotDataUrl: string | null;
  observedAt: string;
};

export type SidebarChoice = {
  label: string;
  rationale: string;
  suggestedAction: string;
  /** Element ID for execution (sh-0, sh-1, etc.) */
  elementId?: string;
  /** Action type: click, type, select, scroll, navigate */
  actionType?: SidebarActionType;
  /** For type action: text to type. For navigate: URL. For select: value. */
  actionValue?: string;
};

/** Hub-and-Spoke state: Digital Advocate */
export type DigitalAdvocateState = {
  user_goal: string;
  page_content: string;
  available_actions: SidebarChoice[];
  current_step: string;
  execution_log: string[];
};

/** Safety Supervisor result */
export type SafetyValidationResult = {
  approved: boolean;
  reason: string;
  requiresHITL: boolean;
};

export type PageSummary = {
  summary: string;
  purpose: string;
  choices: SidebarChoice[];
};

export type BrowserAction =
  | { type: "click"; elementId: string }
  | { type: "type"; elementId: string; text: string }
  | { type: "select"; elementId: string; value: string }
  | { type: "scroll"; elementId: string }
  | { type: "navigate"; url: string };

export type McpToolDescriptor = {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolCall = {
  server: string;
  name: string;
  arguments?: Record<string, unknown>;
};

export type McpToolCallResult = {
  ok: boolean;
  server: string;
  name: string;
  content: string;
  isError?: boolean;
};

export type PlanActionResult =
  | {
      done: true;
      reasoning: string;
      finalAnswer: string;
      confidence: number;
      askQuestion?: never;
      selectedChoiceIndex?: never;
    }
  | {
      done: false;
      reasoning: string;
      confidence: number;
      expectedOutcome?: string;
      selectedChoiceIndex?: number;
      action?: BrowserAction;
      mcpToolCall?: McpToolCall;
      askQuestion?: string;
    };

export type PlanActionInput = {
  goal: string;
  observation: PageObservation;
  timeline: AgentTimelineEvent[];
  availableActions: SidebarChoice[];
  availableMcpTools?: McpToolDescriptor[];
  currentStep?: string;
};

export type ActionExecutionResult = {
  ok: boolean;
  message: string;
  action: BrowserAction;
};

export type AgentTimelineEvent = {
  ts: string;
  kind:
    | "observe"
    | "plan"
    | "question"
    | "user"
    | "act"
    | "verify"
    | "summary"
    | "error";
  message: string;
};

export type AgentRunInput = {
  goal: string;
  mode: AgentMode;
  initialObservation: PageObservation;
  /** When set, skips inferIntent and uses this as the resolved goal. */
  resolvedGoal?: string;
  /** Short search query for web search (e.g. "Form 1040-SR"). Used for type actions on Google. */
  searchQuery?: string;
  /** Queued plan steps from inferIntent. Each step is a single actionable task. */
  planSteps?: string[];
  signal?: AbortSignal;
  systemContext?: {
    cwd?: string;
    agentsInstructions?: string;
    platform?: string;
    nodeVersion?: string;
  };
};

export type AgentRunOutput = {
  completed: boolean;
  finalAnswer: string;
  finalSummary: PageSummary;
  timeline: AgentTimelineEvent[];
  /** Sequence of browser actions executed during this run. */
  executedActions?: BrowserAction[];
};
