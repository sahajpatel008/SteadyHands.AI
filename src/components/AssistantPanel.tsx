import { useEffect, useRef, useState } from "react";
import type { AgentTimelineEvent, PageSummary } from "../../shared/types";
import { choiceToAction } from "../lib/choiceAction";

type ChatMessage = {
  ts: string;
  role: "agent" | "user" | "system";
  text: string;
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
  ttsEnabled: boolean;
  onToggleTts: () => void;
  isSpeaking: boolean;
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
  ttsEnabled,
  onToggleTts,
  isSpeaking,
}: Props) {
  const feedRef = useRef<HTMLDivElement | null>(null);
  const thinkingStepsRef = useRef<HTMLDivElement | null>(null);
  const autoSubmitRef = useRef(false);

  const [thinkingOpen, setThinkingOpen] = useState(false);
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
                console.log("STT Result:", text);                autoSubmitRef.current = true;                if (pendingQuestion) {
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

  useEffect(() => {
    if (thinkingOpen && thinkingStepsRef.current) {
      thinkingStepsRef.current.scrollTop = thinkingStepsRef.current.scrollHeight;
    }
  }, [timeline, thinkingOpen]);

  // Auto-submit after STT fills the goal field
  useEffect(() => {
    if (autoSubmitRef.current && !pendingQuestion && goal.trim() && !running && !intentInferring) {
      autoSubmitRef.current = false;
      onRun();
    }
  }, [goal]);

  // Auto-submit after STT fills the pending-question field
  useEffect(() => {
    if (autoSubmitRef.current && pendingQuestion && pendingQuestionInput.trim()) {
      autoSubmitRef.current = false;
      onSubmitPendingQuestion();
    }
  }, [pendingQuestionInput]);

  // Determine what textarea and primary action to show
  const isBusy = running || intentInferring || isTranscribing;
  const isAgentBusy = running || intentInferring; // excludes transcription
  const latestActivity = timeline.length > 0 ? timeline[timeline.length - 1] : null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (isRecording) { toggleRecording(); return; }
      if (pendingQuestion) { onSubmitPendingQuestion(); return; }
      if (!running && !intentInferring && goal.trim()) {
        onRun();
      }
    }
  };

  const inputValue = pendingQuestion ? pendingQuestionInput : goal;
  const onInputChange = pendingQuestion ? onPendingQuestionInputChange : onGoalChange;

  const sendLabel = pendingQuestion
    ? "Reply"
    : intentInferring
    ? "Thinking…"
    : running
    ? "Running…"
    : "Go";

  const onSend = () => {
    if (isRecording) { toggleRecording(); return; }
    if (pendingQuestion) { onSubmitPendingQuestion(); return; }
    if (!running && !intentInferring && goal.trim()) {
      onRun();
    }
  };

  const inputPlaceholder = pendingQuestion
    ? pendingQuestion
    : "Find the Form 1040-SR (Tax Return for Seniors) and get the PDF download link. ";

  return (
    <aside className="assistantPanel">
      {/* ── Header ── */}
      <div className="panelHeader">
        <h1 className="panelTitle">SteadyHands</h1>
        <label className="ttsToggle" title={ttsEnabled ? "Voice responses on — tap to turn off" : "Voice responses off — tap to turn on"}>
          <span className="ttsToggleIcon">
            {ttsEnabled ? (
              /* Volume Up */
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
              </svg>
            ) : (
              /* Volume Off */
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
            )}
          </span>
          <span className="ttsToggleLabel">{ttsEnabled ? "Voice On" : "Voice Off"}</span>
          <span className={`ttsToggleTrack${ttsEnabled ? " ttsToggleTrack--on" : ""}`}>
            <span className="ttsToggleThumb" />
          </span>
          <input
            type="checkbox"
            checked={ttsEnabled}
            onChange={onToggleTts}
            className="ttsToggleInput"
            aria-label="Toggle voice responses"
          />
        </label>
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
            className={`bubble bubble--${msg.role === "agent" ? "agent" : msg.role === "user" ? "user" : "system"} bubble--in`}
          >
            <span className="bubbleLabel">
              {msg.role === "agent" ? "Assistant" : msg.role === "user" ? "You" : null}
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

        {/* Thinking collapsible — groups all reasoning steps */}
        {(isAgentBusy || timeline.length > 0) ? (
          <div className="thinkingCollapsible">
            <button
              className="thinkingHeader"
              type="button"
              onClick={() => setThinkingOpen(o => !o)}
              aria-expanded={thinkingOpen}
            >
              <span className="thinkingHeaderLeft">
                <span className={`thinkingSpinnerWrap${isAgentBusy ? " thinkingSpinnerWrap--active" : ""}`}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                    <path d="M12 2 C12 7 17 12 22 12 C17 12 12 17 12 22 C12 17 7 12 2 12 C7 12 12 7 12 2 Z" />
                  </svg>
                </span>
                <span className="thinkingLabel">
                  {thinkingOpen ? "Hide thinking" : "Show thinking"}
                </span>
                {!thinkingOpen && latestActivity && isAgentBusy ? (
                  <span className="thinkingCurrentStep">{latestActivity.message}</span>
                ) : null}
              </span>
              <span className={`thinkingChevron${thinkingOpen ? " thinkingChevron--open" : ""}`} aria-hidden="true">
                ▾
              </span>
            </button>
            {thinkingOpen ? (
              <div className="thinkingSteps" ref={thinkingStepsRef}>
                {timeline.map((event, i) => (
                  <div key={`${event.ts}-${i}`} className={`thinkingStep thinkingStep--${event.kind}`}>
                    <span className="thinkingStepKind">{event.kind}</span>
                    <span className="thinkingStepText">{event.message}</span>
                  </div>
                ))}
                {isAgentBusy ? (
                  <div className="thinkingStepLive">
                    <span className="typingDot" />
                    <span className="typingDot" />
                    <span className="typingDot" />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── Input area ── */}
      <div className="inputArea">
        {pendingQuestion ? (
          <p className="inputHint">{pendingQuestion}</p>
        ) : null}
        <textarea
          className="mainInput"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={inputPlaceholder}
          rows={3}
          disabled={false}
        />
        <div className="inputActions">
          <button
            className={`micBtn${isRecording ? " micBtn--active" : ""}${isTranscribing ? " micBtn--transcribing" : ""}`}
            type="button"
            onClick={isTranscribing ? undefined : toggleRecording}
            disabled={isTranscribing}
            title={isTranscribing ? "Transcribing…" : isRecording ? "Stop recording" : "Speak your request"}
            aria-label={isTranscribing ? "Transcribing audio" : isRecording ? "Stop recording" : "Start voice input"}
          >
            {isTranscribing ? (
              <span className="micTranscribeSpinner" aria-hidden="true" />
            ) : isRecording ? (
              /* Stop square */
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              /* Microphone */
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
                <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1.5 18.93A8.001 8.001 0 0 1 4 12H2a10 10 0 0 0 9 9.95V24h2v-2.05A10 10 0 0 0 22 12h-2a8.001 8.001 0 0 1-6.5 7.93V19.5h-3v.43z"/>
              </svg>
            )}
          </button>
          {pendingQuestion ? (
            <button className="cancelBtn" type="button" onClick={onSkipPendingQuestion}>
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
              disabled={isBusy && !pendingQuestion ? true : !pendingQuestion && !goal.trim()}
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
