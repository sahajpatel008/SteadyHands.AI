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
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);

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
                  if (isRecording) {
                    toggleRecording();
                    return;
                  }
                  onSubmitRefine();
                }
              }}
              placeholder="Describe what you want instead..."
              rows={3}
            />
            <div className="modalActions">
              <button
                type="button"
                style={{ backgroundColor: isRecording ? "#f44336" : undefined }}
                onClick={toggleRecording}
                title="Toggle Voice STT"
              >
                {isRecording ? "Stop Mic" : isTranscribing ? "Typing..." : "🎤 Mic"}
              </button>
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
                  if (isRecording) {
                    toggleRecording();
                    return;
                  }
                  onSubmitPendingQuestion();
                }
              }}
              placeholder='Type "yes" or your instruction...'
              rows={3}
            />
            <div className="modalActions">
              <button
                type="button"
                style={{ backgroundColor: isRecording ? "#f44336" : undefined }}
                onClick={toggleRecording}
                title="Toggle Voice STT"
              >
                {isRecording ? "Stop Mic" : isTranscribing ? "Typing..." : "🎤 Mic"}
              </button>
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
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (isRecording) {
                toggleRecording();
                return;
              }
              if (!running && !intentInferring && goal.trim() && !pendingIntentConfirmation) {
                onRun();
              }
            }
          }}
          placeholder="Example: Book a flight from SFO to Mumbai for tomorrow"
          rows={4}
        />
        <div className="runBtnRow">
          {(running || intentInferring || isTranscribing) ? (
            <span className="runSpinner" aria-hidden="true" />
          ) : null}
          <button
            className="runBtn"
            type="button"
            style={{ backgroundColor: isRecording ? "#f44336" : undefined }}
            onClick={toggleRecording}
            title="Toggle Voice STT"
          >
            {isRecording ? "Stop Mic" : isTranscribing ? "Transcribing..." : "🎤 Mic"}
          </button>
          <button
            className="runBtn"
            type="button"
            disabled={running || intentInferring || isTranscribing || !goal.trim() || !!pendingIntentConfirmation}
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
          <h2>Result</h2>
          <p>{finalAnswer}</p>
        </section>
      ) : null}
    </aside>
  );
}
