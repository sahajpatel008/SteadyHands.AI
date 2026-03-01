import { useEffect, useRef } from "react";
import type { AgentTimelineEvent, PageSummary } from "../../shared/types";
import { choiceToAction } from "../lib/choiceAction";

type ChatMessage = {
  ts: string;
  role: "agent" | "user" | "system";
  text: string;
};

type IntentConfirmation = {
  inferredGoal: string;
  plan: string;
  clarifyingQuestion?: string;
  choices: Array<{ label: string; goal: string }>;
  rawGoal: string;
};

type Props = {
  summary: PageSummary | null;
  timeline: AgentTimelineEvent[];
  chatMessages: ChatMessage[];
  pendingQuestion: string | null;
  pendingQuestionInput: string;
  onPendingQuestionInputChange: (value: string) => void;
  onSubmitPendingQuestion: () => void;
  onSkipPendingQuestion: () => void;
  pendingIntentConfirmation: IntentConfirmation | null;
  pendingIntentRefine: boolean;
  onProceedIntent: () => void;
  onRefineIntent: () => void;
  onPickIntentChoice: (choice: { label: string; goal: string }) => void;
  onSubmitRefine: () => void;
  onCancelRefine: () => void;
  onDismissIntentConfirmation: () => void;
  intentInferring: boolean;
  goal: string;
  onGoalChange: (goal: string) => void;
  onRun: () => void;
  onInterrupt: () => void;
  onChoiceExecute: (index: number) => void;
  enableSafetyGuardrails: boolean;
  onToggleSafetyGuardrails: (enabled: boolean) => void;
  running: boolean;
  finalAnswer: string;
  confidenceThreshold: number;
  onThumbsUp?: () => void;
  showThumbsUp?: boolean;
};

export function AssistantPanel({
  summary,
  timeline,
  chatMessages,
  pendingQuestion,
  pendingQuestionInput,
  onPendingQuestionInputChange,
  onSubmitPendingQuestion,
  onSkipPendingQuestion,
  pendingIntentConfirmation,
  pendingIntentRefine,
  onProceedIntent,
  onRefineIntent,
  onPickIntentChoice,
  onSubmitRefine,
  onCancelRefine,
  onDismissIntentConfirmation,
  intentInferring,
  goal,
  onGoalChange,
  onRun,
  onInterrupt,
  onChoiceExecute,
  enableSafetyGuardrails,
  onToggleSafetyGuardrails,
  running,
  finalAnswer,
  confidenceThreshold,
  onThumbsUp,
  showThumbsUp,
}: Props) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [timeline]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chatMessages, pendingQuestion]);

  const phaseLabel = (kind: AgentTimelineEvent["kind"]): string => {
    if (kind === "observe") return "SEE";
    if (kind === "act") return "ACT";
    return "THINK";
  };

  return (
    <aside className="assistantPanel">
      <div className="panelHeader">
        <h1>SteadyHands</h1>
        <span className={`statusChip ${running ? "statusChip--busy" : "statusChip--ready"}`}>
          {running ? "Running" : "Ready"}
        </span>
      </div>
      <div className="panelMeta">
        <span>Assist: {confidenceThreshold.toFixed(2)}</span>
        <label htmlFor="safetyGuardrailsToggle">
          <input
            id="safetyGuardrailsToggle"
            type="checkbox"
            checked={enableSafetyGuardrails}
            onChange={(event) => onToggleSafetyGuardrails(event.target.checked)}
          />{" "}
          Safety checks
        </label>
      </div>

      <section className="section">
        <h2>Chat</h2>
        <div className="chatMessages" ref={chatRef}>
          {chatMessages.length === 0 ? (
            <p className="subtle">No chat messages yet.</p>
          ) : (
            chatMessages.map((message, index) => (
              <div
                key={`${message.ts}-${index}`}
                className={`chatMessage chatMessage--${message.role}`}
              >
                <span>{message.role === "agent" ? "AGENT" : message.role === "user" ? "YOU" : "SYSTEM"}</span>
                <p>{message.text}</p>
              </div>
            ))
          )}
        </div>
        {pendingIntentConfirmation && !pendingIntentRefine ? (
          <div className="intentConfirmation">
            <p className="subtle">Proceed or refine?</p>
            <div className="intentConfirmationActions">
              <button
                className="navBtn primary"
                type="button"
                onClick={onProceedIntent}
              >
                Proceed with this plan
              </button>
              <button className="navBtn" type="button" onClick={onRefineIntent}>
                Refine
              </button>
              {pendingIntentConfirmation.choices.map((choice, index) => (
                <button
                  key={`${choice.label}-${index}`}
                  className="navBtn"
                  type="button"
                  onClick={() => onPickIntentChoice(choice)}
                >
                  {choice.label}
                </button>
              ))}
              <button
                className="navBtn"
                type="button"
                onClick={onDismissIntentConfirmation}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {pendingIntentRefine ? (
          <div className="chatComposer">
            <p className="subtle">What would you like to change?</p>
            <textarea
              className="goalInput"
              value={pendingQuestionInput}
              onChange={(event) => onPendingQuestionInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmitRefine();
                }
              }}
              placeholder="Describe what you want instead..."
              rows={3}
            />
            <div className="modalActions">
              <button type="button" onClick={onSubmitRefine}>
                Re-infer
              </button>
              <button type="button" onClick={onCancelRefine}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {pendingQuestion && !pendingIntentRefine ? (
          <div className="chatComposer">
            <p className="subtle">Reply (Enter to send)</p>
            <textarea
              className="goalInput"
              value={pendingQuestionInput}
              onChange={(event) => onPendingQuestionInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmitPendingQuestion();
                }
              }}
              placeholder='Type "yes" or your instruction...'
              rows={3}
            />
            <div className="modalActions">
              <button type="button" onClick={onSubmitPendingQuestion}>
                Send
              </button>
              <button type="button" onClick={onSkipPendingQuestion}>
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="section">
        <label className="label" htmlFor="goalInput">
          Task
        </label>
        <textarea
          id="goalInput"
          className="goalInput"
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
          placeholder="Example: Book a flight from SFO to Mumbai for tomorrow"
          rows={4}
        />
        <div className="runBtnRow">
          {(running || intentInferring) ? (
            <span className="runSpinner" aria-hidden="true" />
          ) : null}
          <button
            className="runBtn"
            type="button"
            disabled={running || intentInferring || !goal.trim() || !!pendingIntentConfirmation}
            onClick={onRun}
          >
            {intentInferring ? "Thinking..." : running ? "Running..." : "Run Agent"}
          </button>
          {running ? (
            <button className="interruptBtn" type="button" onClick={onInterrupt}>
              Interrupt
            </button>
          ) : null}
        </div>
      </section>

      <section className="section">
        <h2>Page</h2>
        <p className="summaryLead">{summary?.summary ?? "Open a page to see actions."}</p>
        <p className="purpose">{summary?.purpose ?? ""}</p>
        {summary?.choices?.length ? (
          <ul className="choicesList">
            {summary.choices.map((choice, index) => (
              <li key={`${choice.label}-${index}`}>
                <div className="choiceHead">
                  <span className="choiceIndex">{index + 1}</span>
                  <strong>{choice.label}</strong>
                </div>
                <p className="choiceRationale">{choice.rationale}</p>
                <button
                  className="navBtn primary"
                  type="button"
                  onClick={() => onChoiceExecute(index)}
                  disabled={running || !choiceToAction(choice)}
                >
                  Run
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="section">
        <h2>Activity</h2>
        <div className="timeline" ref={timelineRef}>
          {timeline.length === 0 ? (
            <p className="subtle">No actions yet.</p>
          ) : (
            timeline.map((event, index) => (
              <div key={`${event.ts}-${index}`} className="timelineItem">
                <span>{phaseLabel(event.kind)}</span>
                <p>{event.message}</p>
              </div>
            ))
          )}
        </div>
      </section>

      {finalAnswer ? (
        <section className="section">
          <div className="resultHeader">
            <h2>Result</h2>
            {showThumbsUp && onThumbsUp ? (
              <button
                type="button"
                className="thumbsUpBtn"
                onClick={onThumbsUp}
                title="Save this path as valid"
                aria-label="Save path"
              >
                👍
              </button>
            ) : null}
          </div>
          <p>{finalAnswer}</p>
        </section>
      ) : null}
    </aside>
  );
}
