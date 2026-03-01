import { useCallback, useEffect, useRef, useState } from "react";
import { AssistantPanel } from "./components/AssistantPanel";
import { BrowserPane, type BrowserPaneHandle } from "./components/BrowserPane";
import { NavigationBar } from "./components/NavigationBar";
import { runAgentGraph } from "./lib/agentGraph";
import { choiceToAction } from "./lib/choiceAction";
import { logRenderer } from "../shared/logger";
import type {
  ActionExecutionResult,
  AgentMode,
  AgentTimelineEvent,
  BrowserAction,
  PageSummary,
  PlanActionResult,
  SafetyValidationResult,
  SidebarChoice,
} from "../shared/types";

const DEFAULT_URL = "https://www.google.com";

type SemanticSummary = PageSummary & { current_step?: string };
type ChatMessage = {
  ts: string;
  role: "agent" | "user" | "system";
  text: string;
};

type IntentConfirmation = {
  inferredGoal: string;
  plan: string;
  planSteps?: string[];
  completion_point?: string;
  searchQuery?: string;
  clarifyingQuestion?: string;
  choices: Array<{ label: string; goal: string }>;
  rawGoal: string;
};

function isRiskyAction(action: BrowserAction): boolean {
  const s = JSON.stringify(action).toLowerCase();
  return (
    /\$|pay|payment|confirm|transfer|withdraw|submit.*order|purchase|buy now/i.test(s) ||
    (action.type === "navigate" && /checkout|payment|pay\./i.test(action.url))
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
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

export default function App() {
  const browserRef = useRef<BrowserPaneHandle | null>(null);
  const [currentUrl, setCurrentUrl] = useState(DEFAULT_URL);
  const [summary, setSummary] = useState<PageSummary | null>(null);
  const [timeline, setTimeline] = useState<AgentTimelineEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [goal, setGoal] = useState("");
  const [running, setRunning] = useState(false);
  const [finalAnswer, setFinalAnswer] = useState("");
  const mode: AgentMode = "auto";
  const [observeTextLimit, setObserveTextLimit] = useState(8000);
  const [enableHighlight, setEnableHighlight] = useState(true);
  const [actionTimeoutMs, setActionTimeoutMs] = useState(7000);
  const [verifyTimeoutMs, setVerifyTimeoutMs] = useState(4000);
  const [maxRetriesPerStep, setMaxRetriesPerStep] = useState(1);
  const [fastMode, setFastMode] = useState(true);
  const [enableSafetyGuardrails, setEnableSafetyGuardrails] = useState(false);
  const [requireApprovalForRiskyActions, setRequireApprovalForRiskyActions] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.7);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [pendingQuestionInput, setPendingQuestionInput] = useState("");
  const [pendingIntentConfirmation, setPendingIntentConfirmation] =
    useState<IntentConfirmation | null>(null);
  const [pendingIntentRefine, setPendingIntentRefine] = useState(false);
  const askUserResolveRef = useRef<((answer: string | null) => void) | null>(null);
  const summaryRequestIdRef = useRef(0);
  const summarizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushTimeline = useCallback((kind: AgentTimelineEvent["kind"], message: string) => {
    setTimeline((prev) => [
      ...prev,
      {
        ts: new Date().toISOString(),
        kind,
        message,
      },
    ]);
  }, []);

  const pushChat = useCallback((role: ChatMessage["role"], text: string) => {
    setChatMessages((prev) => [
      ...prev,
      {
        ts: new Date().toISOString(),
        role,
        text,
      },
    ]);
  }, []);

  const askUserViaChat = useCallback(async (question: string): Promise<string | null> => {
    logRenderer("App", "askUser()", { question: question.slice(0, 80) });
    setPendingQuestionInput("");
    setPendingQuestion(question);
    pushChat("agent", question);
    return new Promise<string | null>((resolve) => {
      askUserResolveRef.current = (answer) => {
        askUserResolveRef.current = null;
        setPendingQuestion(null);
        logRenderer("App", "askUser() answer", { hasAnswer: !!answer?.trim() });
        resolve(answer ?? null);
      };
    });
  }, [pushChat]);

  const executeBrowserAction = useCallback(
    async (action: BrowserAction): Promise<ActionExecutionResult> => {
      if (!browserRef.current) {
        return { ok: false, message: "Browser webview is not mounted.", action };
      }
      try {
        const result = await withTimeout(
          browserRef.current.act(action),
          actionTimeoutMs,
          `Action timed out after ${actionTimeoutMs}ms`,
        );
        if (action.type === "navigate" && result.ok) {
          await new Promise((r) => setTimeout(r, 3000));
        }
        return result;
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Action failed",
          action,
        };
      }
    },
    [actionTimeoutMs],
  );

  const summarizeCurrentPage = useCallback(
    async (goalOverride?: string) => {
      if (!browserRef.current) return;
      const requestId = ++summaryRequestIdRef.current;
      try {
        logRenderer("App", "summarizeCurrentPage start", { requestId });
        const observation = await browserRef.current.observe();
        const nextSummary = (await window.steadyhands.semanticInterpreter(
          observation,
          goalOverride ?? goal,
        )) as SemanticSummary;
        if (requestId !== summaryRequestIdRef.current) {
          logRenderer("App", "summarizeCurrentPage stale response ignored", { requestId });
          return;
        }
        setSummary(nextSummary);
        logRenderer("App", "summarizeCurrentPage done", {
          requestId,
          url: observation.url,
          choices: nextSummary.choices?.length,
        });
      } catch (error) {
        if (requestId === summaryRequestIdRef.current) {
          logRenderer("App", "Failed to summarize page", { error: String(error), requestId });
        }
      }
    },
    [goal],
  );

  useEffect(() => {
    const loadConfig = async () => {
      try {
        logRenderer("App", "Loading config");
        const config = await window.steadyhands.getPublicConfig();
        setObserveTextLimit(config.observeTextLimit);
        setEnableHighlight(config.enableAutoHighlight);
        const turboEnabled = config.fastMode;
        setActionTimeoutMs(turboEnabled ? Math.min(config.actionTimeoutMs, 7000) : config.actionTimeoutMs);
        setVerifyTimeoutMs(turboEnabled ? Math.min(config.verifyTimeoutMs, 4000) : config.verifyTimeoutMs);
        setMaxRetriesPerStep(turboEnabled ? Math.min(config.maxRetriesPerStep, 1) : config.maxRetriesPerStep);
        setFastMode(config.fastMode);
        setEnableSafetyGuardrails(config.enableSafetyGuardrails);
        setRequireApprovalForRiskyActions(config.requireApprovalForRiskyActions);
        setConfidenceThreshold(config.confidenceThreshold);
        void window.steadyhands.listMcpTools().catch(() => undefined);
        logRenderer("App", "Config loaded", config);
      } catch (error) {
        logRenderer("App", "Failed to load config", { error: String(error) });
      }
    };
    loadConfig();
  }, []);

  useEffect(() => {
    return () => {
      if (summarizeDebounceRef.current) {
        clearTimeout(summarizeDebounceRef.current);
        summarizeDebounceRef.current = null;
      }
    };
  }, []);

  const executeChoice = useCallback(
    async (index: number) => {
      if (running || !summary || !browserRef.current) return;
      const choice: SidebarChoice | undefined = summary.choices[index];
      if (!choice) return;

      const action = choiceToAction(choice);
      const optionLabel = `option ${index + 1}${choice.label ? ` (${choice.label})` : ""}`;
      if (!action) {
        pushTimeline("question", `Cannot execute ${optionLabel}: incomplete action mapping.`);
        return;
      }

      setRunning(true);
      setFinalAnswer("");
      summaryRequestIdRef.current += 1;

      try {
        pushTimeline("plan", `User selected ${optionLabel}.`);

        if (enableSafetyGuardrails) {
          const validation = (await window.steadyhands.safetySupervisor({
            userGoal: goal,
            action,
            context: {
              url: currentUrl,
              currentStep: (summary as SemanticSummary).current_step,
            },
          })) as SafetyValidationResult;

          if (!validation.approved) {
            pushTimeline("question", `Guardrails blocked ${optionLabel}: ${validation.reason}`);
            return;
          }

          if (
            requireApprovalForRiskyActions &&
            (validation.requiresHITL || isRiskyAction(action))
          ) {
            const response = await askUserViaChat(
              `Confirm ${optionLabel}. Type "yes" to proceed.`,
            );
            if (!response || !/^\s*yes\s*$/i.test(response)) {
              pushTimeline("user", `User declined ${optionLabel}.`);
              return;
            }
            pushTimeline("user", `User confirmed ${optionLabel}.`);
          }
        } else {
          pushTimeline("plan", "Safety guardrails are off. Executing selected option directly.");
        }

        const totalAttempts = maxRetriesPerStep + 1;
        let finalResult: ActionExecutionResult | null = null;

        for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
          const result = await executeBrowserAction(action);
          finalResult = result;
          pushTimeline(
            "act",
            `Option ${index + 1} attempt ${attempt}/${totalAttempts}: ${result.message}`,
          );
          if (result.ok) break;
        }

        if (!finalResult?.ok) {
          pushTimeline(
            "plan",
            `Failed to execute ${optionLabel} after ${totalAttempts} attempts.`,
          );
          return;
        }

        await summarizeCurrentPage(goal);
      } catch (error) {
        pushTimeline(
          "error",
          error instanceof Error ? error.message : "Unknown error while executing option.",
        );
      } finally {
        summaryRequestIdRef.current += 1;
        setRunning(false);
      }
    },
    [
      askUserViaChat,
      currentUrl,
      executeBrowserAction,
      enableSafetyGuardrails,
      goal,
      maxRetriesPerStep,
      pushTimeline,
      requireApprovalForRiskyActions,
      running,
      summarizeCurrentPage,
      summary,
    ],
  );

  const abortControllerRef = useRef<AbortController | null>(null);
  const [intentInferring, setIntentInferring] = useState(false);

  const buildResolvedGoal = useCallback(
    (inferredGoal: string, plan: string, rawGoal: string) =>
      [
        `Inferred goal: ${inferredGoal}`,
        ``,
        `Plan:`,
        plan,
        ``,
        `Original user message: ${rawGoal}`,
      ].join("\n"),
    [],
  );

  const startAgentWithResolvedGoal = useCallback(
    async (
      resolvedGoal: string,
      opts?: { searchQuery?: string; planSteps?: string[]; completion_point?: string },
    ) => {
      if (!browserRef.current || running) return;
      setPendingIntentConfirmation(null);
      setPendingIntentRefine(false);
      abortControllerRef.current = new AbortController();
      setRunning(true);
      setFinalAnswer("");
      summaryRequestIdRef.current += 1;
      try {
        const [initialObservation, systemContext] = await Promise.all([
          browserRef.current.observe(),
          window.steadyhands.getSystemContext().catch(() => null),
        ]);
        const output = await runAgentGraph(
        {
          inferIntent: (rawGoal) =>
            window.steadyhands.inferIntent(rawGoal) as Promise<{
              inferredGoal: string;
              plan: string;
            }>,
          semanticInterpreter: async (obs, userGoal, opts) =>
            window.steadyhands.semanticInterpreter(obs, userGoal, opts) as Promise<
              PageSummary & { current_step?: string }
            >,
          safetySupervisor: async (userGoal, action, context) =>
            window.steadyhands.safetySupervisor({ userGoal, action, context }) as Promise<SafetyValidationResult>,
          isRiskyForHITL: isRiskyAction,
          observe: async () => browserRef.current!.observe(),
          plan: async (input) => {
            const result = (await window.steadyhands.planAction(input)) as PlanActionResult;
            logRenderer("App", "plan() done", {
              done: result.done,
              selectedChoiceIndex: !result.done ? result.selectedChoiceIndex : undefined,
              mcpToolCall:
                !result.done && result.mcpToolCall
                  ? `${result.mcpToolCall.server}/${result.mcpToolCall.name}`
                  : undefined,
              hasAction: !result.done && !!result.action,
            });
            return result;
          },
          listMcpTools: async () => window.steadyhands.listMcpTools(),
          callMcpTool: async (call) => window.steadyhands.callMcpTool(call),
          askUser: askUserViaChat,
          act: executeBrowserAction,
          goBack: () => browserRef.current?.goBack(),
          canGoBack: () => browserRef.current?.canGoBack?.() ?? false,
          isPageRelevantToGoal: (obs, g, opts) =>
            window.steadyhands.isPageRelevantToGoal({
              observation: obs,
              goal: g,
              planSteps: opts?.planSteps,
              planStepIndex: opts?.planStepIndex,
            }),
          isGoalAchieved: (obs, g) =>
            window.steadyhands.isGoalAchieved({ observation: obs, goal: g }),
          isAtCompletionPoint: (obs, cp) =>
            window.steadyhands.isAtCompletionPoint({ observation: obs, completionPoint: cp }),
          maxSteps: 0,
          actionTimeoutMs,
          verifyTimeoutMs,
          maxRetriesPerStep,
          fastMode,
          enableSafetyGuardrails,
          requireApprovalForRiskyActions,
        },
        {
          goal,
          mode,
          initialObservation,
          resolvedGoal,
          completion_point: opts?.completion_point,
          searchQuery: opts?.searchQuery,
          planSteps: opts?.planSteps,
          signal: abortControllerRef.current.signal,
          systemContext: systemContext ?? undefined,
        },
      );

        logRenderer("App", "onRunAgent done", {
          completed: output.completed,
          timelineLen: output.timeline?.length,
        });
        setTimeline(output.timeline);
        setSummary(output.finalSummary);
        setFinalAnswer(output.finalAnswer);
      } catch (error) {
        logRenderer("App", "Agent run failed", { error: String(error) });
        pushTimeline("error", error instanceof Error ? error.message : "Unknown error");
      } finally {
        summaryRequestIdRef.current += 1;
        setRunning(false);
      }
    },
    [
      goal,
      mode,
      running,
      actionTimeoutMs,
      verifyTimeoutMs,
      maxRetriesPerStep,
      fastMode,
      enableSafetyGuardrails,
      requireApprovalForRiskyActions,
      pushTimeline,
      askUserViaChat,
      executeBrowserAction,
    ],
  );

  const onRunAgent = async () => {
    if (!browserRef.current || running || intentInferring) return;
    if (!goal.trim()) return;
    logRenderer("App", "onRunAgent start", { goal: goal.slice(0, 60), mode });

    if (pendingIntentConfirmation) {
      return;
    }

    setIntentInferring(true);
    setGoal("");
    try {
      const result = (await window.steadyhands.inferIntent(goal)) as {
        inferredGoal: string;
        plan: string;
        planSteps?: string[];
        completion_point?: string;
        searchQuery?: string;
        clarifyingQuestion?: string;
        choices: Array<{ label: string; goal: string }>;
      };
      const msg = [
        `I inferred: ${result.inferredGoal}`,
        ``,
        `Plan: ${result.plan}`,
        result.clarifyingQuestion ? `\n${result.clarifyingQuestion}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      pushChat("agent", msg);
      setPendingIntentConfirmation({
        inferredGoal: result.inferredGoal,
        plan: result.plan,
        planSteps: result.planSteps,
        completion_point: result.completion_point,
        searchQuery: result.searchQuery,
        clarifyingQuestion: result.clarifyingQuestion,
        choices: result.choices ?? [],
        rawGoal: goal,
      });
    } catch (error) {
      logRenderer("App", "inferIntent failed", { error: String(error) });
      pushChat("system", `Intent inference failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIntentInferring(false);
    }
  };

  const onProceedIntent = useCallback(() => {
    if (!pendingIntentConfirmation) return;
    const resolved = buildResolvedGoal(
      pendingIntentConfirmation.inferredGoal,
      pendingIntentConfirmation.plan,
      pendingIntentConfirmation.rawGoal,
    );
    pushChat("user", "Proceed with this plan");
    void startAgentWithResolvedGoal(resolved, {
      searchQuery: pendingIntentConfirmation.searchQuery,
      planSteps: pendingIntentConfirmation.planSteps,
      completion_point: pendingIntentConfirmation.completion_point,
    });
  }, [pendingIntentConfirmation, buildResolvedGoal, pushChat, startAgentWithResolvedGoal]);

  const onRefineIntent = useCallback(() => {
    setPendingIntentRefine(true);
  }, []);

  const onDismissIntentConfirmation = useCallback(() => {
    setPendingIntentConfirmation(null);
    setPendingIntentRefine(false);
  }, []);

  const onPickIntentChoice = useCallback(
    (choice: { label: string; goal: string }) => {
      if (!pendingIntentConfirmation) return;
      pushChat("user", choice.label);
      const resolved = buildResolvedGoal(
        choice.goal,
        pendingIntentConfirmation.plan,
        pendingIntentConfirmation.rawGoal,
      );
      void startAgentWithResolvedGoal(resolved, {
        searchQuery: pendingIntentConfirmation.searchQuery,
        planSteps: pendingIntentConfirmation.planSteps,
        completion_point: pendingIntentConfirmation.completion_point,
      });
    },
    [pendingIntentConfirmation, buildResolvedGoal, pushChat, startAgentWithResolvedGoal],
  );

  const onSubmitRefine = useCallback(async () => {
    const refinement = pendingQuestionInput.trim();
    if (!refinement || !pendingIntentConfirmation) return;
    setPendingIntentRefine(false);
    setPendingQuestionInput("");
    pushChat("user", refinement);
    setIntentInferring(true);
    try {
      const result = (await window.steadyhands.inferIntent(refinement)) as {
        inferredGoal: string;
        plan: string;
        planSteps?: string[];
        searchQuery?: string;
        clarifyingQuestion?: string;
        choices: Array<{ label: string; goal: string }>;
      };
      const msg = [
        `I inferred: ${result.inferredGoal}`,
        ``,
        `Plan: ${result.plan}`,
        result.clarifyingQuestion ? `\n${result.clarifyingQuestion}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      pushChat("agent", msg);
      setPendingIntentConfirmation({
        inferredGoal: result.inferredGoal,
        plan: result.plan,
        planSteps: result.planSteps,
        completion_point: result.completion_point,
        searchQuery: result.searchQuery,
        clarifyingQuestion: result.clarifyingQuestion,
        choices: result.choices ?? [],
        rawGoal: refinement,
      });
    } catch (error) {
      logRenderer("App", "inferIntent (refine) failed", { error: String(error) });
      pushChat("system", `Intent inference failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIntentInferring(false);
    }
  }, [pendingIntentConfirmation, pendingQuestionInput, pushChat]);

  const onUrlChanged = (nextUrl: string) => {
    logRenderer("App", "onUrlChanged", { nextUrl });
    if (nextUrl === currentUrl) {
      return;
    }
    setCurrentUrl(nextUrl);
    if (running) {
      logRenderer("App", "onUrlChanged: skip summarize while agent is running", {
        nextUrl,
      });
      return;
    }
    if (summarizeDebounceRef.current) {
      clearTimeout(summarizeDebounceRef.current);
    }
    summarizeDebounceRef.current = setTimeout(() => {
      summarizeDebounceRef.current = null;
      if (goal.trim()) {
        void summarizeCurrentPage(goal);
      } else {
        setSummary(null);
      }
    }, 250);
  };

  const submitQuestionAnswer = useCallback(() => {
    const answer = pendingQuestionInput.trim() || null;
    if (answer) {
      pushChat("user", answer);
    }
    setPendingQuestionInput("");
    askUserResolveRef.current?.(answer);
  }, [pendingQuestionInput, pushChat]);

  const cancelQuestion = useCallback(() => {
    pushChat("user", "(skipped)");
    askUserResolveRef.current?.(null);
  }, [pushChat]);

  return (
    <div className="appRoot">
      <NavigationBar
        currentUrl={currentUrl}
        onNavigate={(url) => browserRef.current?.navigate(url)}
        onBack={() => browserRef.current?.goBack()}
        onForward={() => browserRef.current?.goForward()}
        onRefresh={() => browserRef.current?.refresh()}
      />
      <div className="contentSplit">
        <AssistantPanel
          summary={summary}
          timeline={timeline}
          chatMessages={chatMessages}
          pendingQuestion={pendingQuestion}
          pendingQuestionInput={pendingQuestionInput}
          onPendingQuestionInputChange={setPendingQuestionInput}
          onSubmitPendingQuestion={submitQuestionAnswer}
          onSkipPendingQuestion={cancelQuestion}
          pendingIntentConfirmation={pendingIntentConfirmation}
          pendingIntentRefine={pendingIntentRefine}
          onProceedIntent={onProceedIntent}
          onRefineIntent={onRefineIntent}
          onPickIntentChoice={onPickIntentChoice}
          onSubmitRefine={onSubmitRefine}
          onCancelRefine={() => setPendingIntentRefine(false)}
          onDismissIntentConfirmation={onDismissIntentConfirmation}
          intentInferring={intentInferring}
          goal={goal}
          onGoalChange={setGoal}
          onRun={onRunAgent}
          onInterrupt={() => {
            abortControllerRef.current?.abort();
            askUserResolveRef.current?.(null);
          }}
          onChoiceExecute={executeChoice}
          enableSafetyGuardrails={enableSafetyGuardrails}
          onToggleSafetyGuardrails={setEnableSafetyGuardrails}
          running={running}
          finalAnswer={finalAnswer}
          confidenceThreshold={confidenceThreshold}
        />
        <BrowserPane
          ref={browserRef}
          initialUrl={DEFAULT_URL}
          onUrlChange={onUrlChanged}
          textLimit={observeTextLimit}
          enableHighlight={enableHighlight}
        />
      </div>
    </div>
  );
}
