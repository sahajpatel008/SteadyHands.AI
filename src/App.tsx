/// <reference path="./types/global.d.ts" />
import { useCallback, useEffect, useRef, useState } from "react";
import { AssistantPanel } from "./components/AssistantPanel";
import { BrowserPane, type BrowserPaneHandle } from "./components/BrowserPane";
import { NavigationBar } from "./components/NavigationBar";
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

import { isRiskyAction } from "../shared/isRiskyAction";

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
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [pendingQuestionInput, setPendingQuestionInput] = useState("");
  const askUserResolveRef = useRef<((answer: string | null) => void) | null>(null);
  const summaryRequestIdRef = useRef(0);
  const summarizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushTimeline = useCallback((kind: AgentTimelineEvent["kind"], message: string) => {
    const ts = new Date().toISOString();
    setTimeline((prev) => [...prev, { ts, kind, message }]);

    // Only surface hard errors into the main chat feed; all other steps live
    // exclusively inside the "Show thinking" collapsible.
    if (kind === "error") {
      setChatMessages((prev) => [
        ...prev,
        { ts, role: "system" as const, text: `⚠️ Error: ${message}` },
      ]);
    }
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

  const runIdRef = useRef<string | null>(null);
  const [intentInferring, setIntentInferring] = useState(false);

  const speakText = useCallback(async (text: string) => {
    // Stop any currently playing audio
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    setIsSpeaking(true);
    try {
      const base64Audio = await window.steadyhands.speak(text);
      const binaryStr = atob(base64Audio);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        currentAudioRef.current = null;
        setIsSpeaking(false);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        currentAudioRef.current = null;
        setIsSpeaking(false);
      };
      await audio.play();
    } catch (e) {
      logRenderer("App", "TTS error", { error: String(e) });
      setIsSpeaking(false);
    }
  }, []);

  // Auto-speak the final answer when the agent is done — only if TTS toggle is on
  useEffect(() => {
    if (finalAnswer && ttsEnabled) {
      void speakText(finalAnswer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalAnswer, ttsEnabled]);

  const buildResolvedGoal = useCallback(
    (
      inferredGoal: string,
      plan: string,
      rawGoal: string,
      clarifyingQuestion?: string,
      requireUserInput?: boolean,
    ) => {
      const parts = [
        `Inferred goal: ${inferredGoal}`,
        ``,
        `Plan:`,
        plan,
        ``,
        `Original user message: ${rawGoal}`,
      ];
      if (requireUserInput || clarifyingQuestion?.trim()) {
        parts.push(
          ``,
          `USER INPUT REQUIRED: The LLM determined we must ask the user for more info before selecting among options. ${clarifyingQuestion?.trim() ? `Suggested question: ${clarifyingQuestion}` : "Ask before auto-selecting."}`,
        );
      }
      return parts.join("\n");
    },
    [],
  );

  const startAgentWithResolvedGoal = useCallback(
    async (
      resolvedGoal: string,
      opts?: {
        searchQuery?: string;
        planSteps?: string[];
        completion_point?: string;
        clarifyingQuestion?: string;
      },
    ) => {
      if (!browserRef.current || running) return;
      const runId = crypto.randomUUID();
      runIdRef.current = runId;
      setRunning(true);
      setFinalAnswer("");
      setTimeline([]);
      setSummary(null);
      summaryRequestIdRef.current += 1;

      // Continue from current page. Do not navigate to Google.

      const config = await window.steadyhands.getPublicConfig();
      const systemContext = await window.steadyhands.getSystemContext().catch(() => null);
      const maxSteps = config.maxSteps ?? 0;

      window.steadyhands.registerAgentHandlers({
        observe: () => browserRef.current!.observe(),
        act: executeBrowserAction,
        goBack: () => browserRef.current?.goBack(),
        canGoBack: () => browserRef.current?.canGoBack?.() ?? false,
        askUser: askUserViaChat,
        onEvent: (kind, message) =>
          pushTimeline(kind as AgentTimelineEvent["kind"], message),
      });

      try {
        const output = await window.steadyhands.runAgent({
          runId,
          goal,
          mode,
          resolvedGoal,
          completion_point: opts?.completion_point,
          searchQuery: opts?.searchQuery,
          planSteps: opts?.planSteps,
          systemContext: systemContext ?? undefined,
          maxSteps,
          actionTimeoutMs,
          verifyTimeoutMs,
          maxRetriesPerStep,
          fastMode,
          enableSafetyGuardrails,
          requireApprovalForRiskyActions,
        });

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
        window.steadyhands.registerAgentHandlers(null);
        runIdRef.current = null;
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

    setIntentInferring(true);
    const userMessage = goal;
    setGoal("");
    pushChat("user", userMessage);
    try {
      const result = (await window.steadyhands.inferIntent(userMessage)) as {
        prompt_type?: "conversational" | "task";
        inferredGoal: string;
        plan: string;
        planSteps?: string[];
        completion_point?: string;
        searchQuery?: string;
        clarifyingQuestion?: string;
        requireUserInput?: boolean;
        choices: Array<{ label: string; goal: string }>;
      };

      if (result.prompt_type === "conversational") {
        const reply = await window.steadyhands.respondConversationally(userMessage);
        pushChat("agent", reply);
        setIntentInferring(false);
        return;
      }

      const resolved = buildResolvedGoal(
        result.inferredGoal,
        result.plan,
        userMessage,
        result.clarifyingQuestion,
        result.requireUserInput,
      );
      pushChat("agent", `I inferred: ${result.inferredGoal}\n\nPlan: ${result.plan}`);
      void startAgentWithResolvedGoal(resolved, {
        searchQuery: result.searchQuery,
        planSteps: result.planSteps,
        completion_point: result.completion_point,
        clarifyingQuestion: result.clarifyingQuestion,
      });
    } catch (error) {
      logRenderer("App", "inferIntent failed", { error: String(error) });
      pushChat("system", `Intent inference failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIntentInferring(false);
    }
  };

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

  const clearSession = useCallback(() => {
    // 1. Abort any in-flight agent run
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    // 2. Resolve any pending user-question promise so the agent loop exits cleanly
    if (askUserResolveRef.current) {
      askUserResolveRef.current(null);
      askUserResolveRef.current = null;
    }

    // 3. Stop any TTS audio
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    setIsSpeaking(false);

    // 4. Cancel any pending summarize debounce
    if (summarizeDebounceRef.current) {
      clearTimeout(summarizeDebounceRef.current);
      summarizeDebounceRef.current = null;
    }

    // 5. Reset all session state
    setChatMessages([]);
    setTimeline([]);
    setSummary(null);
    setFinalAnswer("");
    setGoal("");
    setRunning(false);
    setIntentInferring(false);
    setPendingQuestion(null);
    setPendingQuestionInput("");
    setPendingIntentConfirmation(null);
    setPendingIntentRefine(false);
    summaryRequestIdRef.current += 1;

    // 6. Navigate browser back to the home page
    browserRef.current?.navigate(DEFAULT_URL);
    setCurrentUrl(DEFAULT_URL);

    logRenderer("App", "clearSession: session cleared");
  }, []);

  return (
    <div className="appRoot">
      <NavigationBar
        currentUrl={currentUrl}
        onNavigate={(url) => browserRef.current?.navigate(url)}
        onBack={() => browserRef.current?.goBack()}
        onForward={() => browserRef.current?.goForward()}
        onClearSession={clearSession}
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
          intentInferring={intentInferring}
          goal={goal}
          onGoalChange={setGoal}
          onRun={onRunAgent}
          onInterrupt={() => {
            if (runIdRef.current) {
              window.steadyhands.abortAgent(runIdRef.current);
            }
            askUserResolveRef.current?.(null);
          }}
          onChoiceExecute={executeChoice}
          enableSafetyGuardrails={enableSafetyGuardrails}
          onToggleSafetyGuardrails={setEnableSafetyGuardrails}
          running={running}
          finalAnswer={finalAnswer}
          confidenceThreshold={confidenceThreshold}
          ttsEnabled={ttsEnabled}
          onToggleTts={() => setTtsEnabled((v) => !v)}
          isSpeaking={isSpeaking}
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
