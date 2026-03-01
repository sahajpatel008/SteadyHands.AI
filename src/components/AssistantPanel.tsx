import { useEffect, useRef, useState } from "react";
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
};

/** Returns true when a page choice has a runnable action */
function choiceRunnable(choice: PageSummary["choices"][number]): boolean {
  return !!choiceToAction(choice);
}

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
}: Props) {
  const feedRef = useRef<HTMLDivElement | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const goalRef = useRef(goal);
  const pendingQuestionInputRef = useRef(pendingQuestionInput);

  useEffect(() => {
    goalRef.current = goal;
  }, [goal]);

  useEffect(() => {
    pendingQuestionInputRef.current = pendingQuestionInput;
  }, [pendingQuestionInput]);

  const toggleRecording = async () => {
    console.log("toggleRecording clicked, current state isRecording:", isRecording);
    if (isRecording) {
      if (mediaRecorderRef.current) {
        console.log("Stopping media recorder...");
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
    } else {
      try {
        console.log("Requesting microphone permissions...");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Microphone access granted.");
        
        let mimeType = '';
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/webm')) {
          mimeType = 'audio/webm';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        }

        const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          console.log("MediaRecorder stopped. Preparing to send to STT...");
          setIsTranscribing(true);
          const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
          const audioBlob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' });
          stream.getTracks().forEach((track) => track.stop());

          console.log(`Audio blob created: size=${audioBlob.size} bytes, type=${audioBlob.type}`);
          if (audioBlob.size === 0) {
             console.error("Audio blob is empty!");
             alert("Error: No audio recorded.");
             setIsTranscribing(false);
             return;
          }

          const formData = new FormData();
          formData.append("file", audioBlob, `recording.${ext}`);

          try {
            console.log("Sending POST request to Whisper endpoint...");
            const response = await fetch("http://165.245.140.116:8001/v1/audio/transcriptions", {
              method: "POST",
              body: formData,
            });
            console.log("Response status:", response.status);
            if (response.ok) {
              const data = await response.json();
              console.log("STT full response:", data);
              const text = data.text;
              if (text) {
                console.log("STT Result:", text);
                if (pendingIntentRefine || pendingQuestion) {
                  const currentText = pendingQuestionInputRef.current ? pendingQuestionInputRef.current + " " : "";
                  onPendingQuestionInputChange(currentText + text);
                } else {
                  const currentText = goalRef.current ? goalRef.current + " " : "";
                  onGoalChange(currentText + text);
                }
              } else {
                console.warn("STT returned ok, but text was empty!");
              }
            } else {
              const errText = await response.text();
              console.error("STT Failed:", response.status, errText);
              alert(`STT Failed: ${response.status} - ${errText}`);
            }
          } catch (e) {
            console.error("Error calling STT:", e);
            alert(`Error calling STT: ${(e as Error).message}`);
          } finally {
            console.log("Transcription process finished.");
            setIsTranscribing(false);
          }
        };

        mediaRecorder.start(250); // Record in 250ms chunks to ensure data is captured properly
        console.log("MediaRecorder started in 250ms chunks.");
        setIsRecording(true);
      } catch (err) {
        console.error("Error accessing microphone:", err);
        alert(`Microphone access denied or error occurred: ${(err as Error).message}`);
      }
    }
  };

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [chatMessages, timeline, pendingQuestion, summary, finalAnswer]);

  // Determine what textarea and primary action to show
  const isBusy = running || intentInferring || isTranscribing;
  const latestActivity = timeline.length > 0 ? timeline[timeline.length - 1] : null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (isRecording) { toggleRecording(); return; }
      if (pendingIntentRefine) { onSubmitRefine(); return; }
      if (pendingQuestion) { onSubmitPendingQuestion(); return; }
      if (!running && !intentInferring && goal.trim() && !pendingIntentConfirmation) {
        onRun();
      }
    }
  };

  const inputValue = pendingIntentRefine || pendingQuestion ? pendingQuestionInput : goal;
  const onInputChange = pendingIntentRefine || pendingQuestion ? onPendingQuestionInputChange : onGoalChange;

  const sendLabel = pendingIntentRefine
    ? "Update"
    : pendingQuestion
    ? "Reply"
    : intentInferring
    ? "Thinking…"
    : running
    ? "Running…"
    : "Go";

  const onSend = () => {
    if (isRecording) { toggleRecording(); return; }
    if (pendingIntentRefine) { onSubmitRefine(); return; }
    if (pendingQuestion) { onSubmitPendingQuestion(); return; }
    if (!running && !intentInferring && goal.trim() && !pendingIntentConfirmation) {
      onRun();
    }
  };

  const inputPlaceholder = pendingIntentRefine
    ? "What would you like to change?"
    : pendingQuestion
    ? pendingQuestion
    : "Find the Form 1040-SR (Tax Return for Seniors) and get the PDF download link. ";

  return (
    <aside className="assistantPanel">
      {/* ── Header ── */}
      <div className="panelHeader">
        <h1 className="panelTitle">SteadyHands</h1>
        <span className={`statusBadge ${isBusy ? "statusBadge--busy" : "statusBadge--ready"}`}>
          {isBusy ? "Working…" : "Ready"}
        </span>
      </div>

      {/* ── Unified message / action feed ── */}
      <div className="messageFeed" ref={feedRef}>

        {/* Empty state */}
        {chatMessages.length === 0 && !summary && !finalAnswer && (
          <p className="feedHint">Describe what you need help with below, or use the mic.</p>
        )}

        {/* Chat messages */}
        {chatMessages.map((msg, i) => (
          <div
            key={`${msg.ts}-${i}`}
            className={`bubble bubble--${msg.role === "agent" ? "agent" : msg.role === "user" ? "user" : "system"}`}
          >
            <span className="bubbleLabel">
              {msg.role === "agent" ? "Assistant" : msg.role === "user" ? "You" : "Info"}
            </span>
            <p className="bubbleText">{msg.text}</p>
          </div>
        ))}

        {/* Final answer highlight */}
        {finalAnswer ? (
          <div className="answerCard">
            <span className="answerLabel">Answer</span>
            <p className="answerText">{finalAnswer}</p>
          </div>
        ) : null}

        {/* Page summary */}
        {summary?.summary && !finalAnswer ? (
          <div className="pageSummaryCard">
            <p className="pageSummaryText">{summary.summary}</p>
            {summary.purpose ? <p className="pagePurpose">{summary.purpose}</p> : null}
          </div>
        ) : null}

        {/* Page action choices */}
        {summary?.choices?.length && !finalAnswer ? (
          <div className="choiceGroup">
            {summary.choices.map((choice, idx) => (
              <button
                key={`${choice.label}-${idx}`}
                className="choiceBtn"
                type="button"
                disabled={running || !choiceRunnable(choice)}
                onClick={() => onChoiceExecute(idx)}
              >
                <span className="choiceBtnNum">{idx + 1}</span>
                <span className="choiceBtnBody">
                  <strong>{choice.label}</strong>
                  {choice.rationale ? <span className="choiceBtnRationale">{choice.rationale}</span> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {/* Intent confirmation */}
        {pendingIntentConfirmation && !pendingIntentRefine ? (
          <div className="confirmCard">
            <p className="confirmQuestion">Does this look right?</p>
            <p className="confirmPlan">{pendingIntentConfirmation.inferredGoal}</p>
            <div className="confirmActions">
              <button className="confirmBtn confirmBtn--yes" type="button" onClick={onProceedIntent}>
                Yes, go ahead
              </button>
              <button className="confirmBtn" type="button" onClick={onRefineIntent}>
                Change it
              </button>
              {pendingIntentConfirmation.choices.map((c, i) => (
                <button
                  key={`${c.label}-${i}`}
                  className="confirmBtn"
                  type="button"
                  onClick={() => onPickIntentChoice(c)}
                >
                  {c.label}
                </button>
              ))}
              <button className="confirmBtn confirmBtn--cancel" type="button" onClick={onDismissIntentConfirmation}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {/* Live activity status */}
        {isBusy && latestActivity ? (
          <div className="activityStatus">
            <span className="activitySpinner" aria-hidden="true" />
            <span className="activityText">{latestActivity.message}</span>
          </div>
        ) : null}
      </div>

      {/* ── Input area ── */}
      <div className="inputArea">
        {pendingIntentRefine || pendingQuestion ? (
          <p className="inputHint">
            {pendingIntentRefine ? "What would you like to change?" : pendingQuestion}
          </p>
        ) : null}
        <textarea
          className="mainInput"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={inputPlaceholder}
          rows={3}
          disabled={!!pendingIntentConfirmation && !pendingIntentRefine}
        />
        <div className="inputActions">
          <button
            className={`micBtn${isRecording ? " micBtn--active" : ""}`}
            type="button"
            onClick={toggleRecording}
            title={isRecording ? "Stop recording" : "Speak your request"}
            aria-label={isRecording ? "Stop recording" : "Start voice input"}
          >
            {isRecording ? "⏹" : "🎤"}
          </button>
          {pendingIntentRefine || pendingQuestion ? (
            <button className="cancelBtn" type="button" onClick={pendingIntentRefine ? onCancelRefine : onSkipPendingQuestion}>
              Cancel
            </button>
          ) : null}
          {running ? (
            <button className="stopBtn" type="button" onClick={onInterrupt}>
              Stop
            </button>
          ) : (
            <button
              className="sendBtn"
              type="button"
              disabled={
                isBusy && !pendingIntentRefine && !pendingQuestion
                  ? true
                  : !pendingIntentRefine && !pendingQuestion && (!goal.trim() || !!pendingIntentConfirmation)
              }
              onClick={onSend}
            >
              {sendLabel}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
