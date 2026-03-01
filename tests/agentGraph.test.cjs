const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const modulePath = path.resolve(__dirname, "../.test-build/src/lib/agentGraph.js");
const { runAgentGraph } = require(modulePath);

function makeObservation(url = "https://example.com") {
  return {
    title: "Example",
    url,
    mainText: "Main content",
    elements: [
      {
        id: "sh-1",
        tag: "button",
        role: "button",
        text: "Continue",
        ariaLabel: "Continue",
        href: null,
        type: null,
        placeholder: null,
        x: 10,
        y: 10,
        width: 100,
        height: 30,
      },
    ],
    screenshotDataUrl: null,
    observedAt: new Date().toISOString(),
  };
}

function makeSummary(summaryText) {
  return {
    summary: summaryText,
    purpose: "Complete task",
    current_step: "Step 1",
    choices: [
      {
        label: "Continue",
        rationale: "Moves to next step",
        suggestedAction: "Click Continue",
        actionType: "click",
        elementId: "sh-1",
      },
    ],
  };
}

function makeSummaryWithChoices(summaryText, choices) {
  return {
    summary: summaryText,
    purpose: "Complete task",
    current_step: "Step 1",
    choices,
  };
}

function baseDeps(overrides = {}) {
  return {
    inferIntent: async (rawGoal) => ({
      prompt_type: "task",
      inferredGoal: rawGoal,
      plan: "1. Complete the task",
      planSteps: ["Complete the task"],
      searchQuery: undefined,
    }),
    observe: async () => makeObservation(),
    semanticInterpreter: async () => makeSummary("Goal summary"),
    plan: async () => ({
      done: true,
      reasoning: "already done",
      finalAnswer: "done",
      confidence: 0.99,
    }),
    safetySupervisor: async () => ({
      approved: true,
      reason: "ok",
      requiresHITL: false,
    }),
    act: async (action) => ({ ok: true, message: "Executed", action }),
    askUser: async () => null,
    resolveUserChoice: async (answer, choices) => {
      const t = answer.trim().toLowerCase();
      if (/^yes\b/.test(t) && choices.length === 1) return 1;
      if (/^no\b/.test(t)) return null;
      return null;
    },
    isRiskyForHITL: () => false,
    maxSteps: 6,
    actionTimeoutMs: 5000,
    verifyTimeoutMs: 5000,
    maxRetriesPerStep: 2,
    fastMode: true,
    enableSafetyGuardrails: true,
    requireApprovalForRiskyActions: false,
    ...overrides,
  };
}

function makeRunInput() {
  return {
    goal: "Complete the flow",
    mode: "auto",
    initialObservation: makeObservation("https://example.com/start"),
  };
}

test("planner executes valid selected semantic option and uses latest semantic summary", async () => {
  let planCalls = 0;
  let actCalls = 0;
  let semanticCalls = 0;
  const deps = baseDeps({
    semanticInterpreter: async () => {
      semanticCalls += 1;
      return makeSummary(`Goal summary ${semanticCalls}`);
    },
    plan: async () => {
      planCalls += 1;
      if (planCalls === 1) {
        return {
          done: false,
          reasoning: "Pick sidebar option",
          confidence: 0.91,
          selectedChoiceIndex: 1,
        };
      }
      return {
        done: true,
        reasoning: "Goal achieved",
        finalAnswer: "Task completed via option 1",
        confidence: 0.95,
      };
    },
    act: async (action) => {
      actCalls += 1;
      return { ok: true, message: "Clicked sh-1", action };
    },
  });

  const output = await runAgentGraph(deps, makeRunInput());

  assert.equal(planCalls, 2);
  assert.equal(actCalls, 1);
  assert.equal(output.completed, true);
  assert.equal(output.finalAnswer, "Task completed via option 1");
  assert.equal(output.finalSummary.summary, "Goal summary 2");
});

test("invalid selectedChoiceIndex auto-replans without interrupting user and does not execute action", async () => {
  let actCalls = 0;
  let asked = 0;
  const deps = baseDeps({
    fastMode: false,
    plan: async () => ({
      done: false,
      reasoning: "Choose option 9",
      confidence: 0.9,
      selectedChoiceIndex: 9,
    }),
    askUser: async () => {
      asked += 1;
      return null;
    },
    act: async (action) => {
      actCalls += 1;
      return { ok: true, message: "should not execute", action };
    },
  });

  const output = await runAgentGraph(deps, makeRunInput());

  assert.equal(asked, 0);
  assert.equal(actCalls, 0);
  assert.match(output.finalAnswer, /(Stopped after max steps|Recursion limit reached)/i);
  assert.ok(
    output.timeline.some((event) =>
      /Replanning automatically\./i.test(event.message),
    ),
  );
});

test("failed actions retry up to maxRetriesPerStep then auto-replan", async () => {
  let actCalls = 0;
  const deps = baseDeps({
    maxSteps: 2,
    maxRetriesPerStep: 2,
    plan: async () => ({
      done: false,
      reasoning: "Try option 1",
      confidence: 0.88,
      selectedChoiceIndex: 1,
    }),
    act: async (action) => {
      actCalls += 1;
      return { ok: false, message: "Element disappeared", action };
    },
    askUser: async () => null,
  });

  const output = await runAgentGraph(deps, makeRunInput());

  assert.ok(actCalls >= 3, "Should retry failed action at least once (3 attempts)");
  assert.match(output.finalAnswer, /(Stopped after max steps|Recursion limit reached)/i);
  assert.ok(
    output.timeline.some((event) =>
      /Action failed after 3 attempts. Replanning automatically./.test(event.message),
    ),
  );
});

test("HITL confirmation yes executes action, no skips and replans", async () => {
  {
    let planCalls = 0;
    let actCalls = 0;
    const deps = baseDeps({
      requireApprovalForRiskyActions: true,
      isRiskyForHITL: () => true,
      plan: async () => {
        planCalls += 1;
        if (planCalls === 1) {
          return {
            done: false,
            reasoning: "Risky option",
            confidence: 0.9,
            selectedChoiceIndex: 1,
          };
        }
        return {
          done: true,
          reasoning: "Done",
          finalAnswer: "Confirmed and executed",
          confidence: 0.95,
        };
      },
      askUser: async () => "yes",
      act: async (action) => {
        actCalls += 1;
        return { ok: true, message: "Executed after confirm", action };
      },
    });

    const output = await runAgentGraph(deps, makeRunInput());
    assert.equal(actCalls, 1);
    assert.equal(output.finalAnswer, "Confirmed and executed");
  }

  {
    let planCalls = 0;
    let actCalls = 0;
    const answers = ["no"];
    const deps = baseDeps({
      requireApprovalForRiskyActions: true,
      isRiskyForHITL: () => true,
      plan: async () => {
        planCalls += 1;
        if (planCalls === 1) {
          return {
            done: false,
            reasoning: "Risky option",
            confidence: 0.9,
            selectedChoiceIndex: 1,
          };
        }
        return {
          done: true,
          reasoning: "Stopped",
          finalAnswer: "User declined risky action",
          confidence: 0.92,
        };
      },
      askUser: async () => answers.shift() ?? null,
      act: async (action) => {
        actCalls += 1;
        return { ok: true, message: "Should not execute", action };
      },
    });

    const output = await runAgentGraph(deps, makeRunInput());
    assert.equal(planCalls, 2);
    assert.equal(actCalls, 0);
    assert.equal(output.finalAnswer, "User declined risky action");
  }
});

test("guardrails disabled bypasses safety rejection", async () => {
  let planCalls = 0;
  let actCalls = 0;
  const deps = baseDeps({
    enableSafetyGuardrails: false,
    plan: async () => {
      planCalls += 1;
      if (planCalls === 1) {
        return {
          done: false,
          reasoning: "Use option",
          confidence: 0.9,
          selectedChoiceIndex: 1,
        };
      }
      return {
        done: true,
        reasoning: "Done",
        finalAnswer: "Completed with guardrails off",
        confidence: 0.95,
      };
    },
    safetySupervisor: async () => ({
      approved: false,
      reason: "blocked",
      requiresHITL: false,
    }),
    askUser: async () => null,
    act: async (action) => {
      actCalls += 1;
      return { ok: true, message: "Executed with guardrails off", action };
    },
  });

  const output = await runAgentGraph(deps, makeRunInput());
  assert.equal(actCalls, 1);
  assert.equal(output.finalAnswer, "Completed with guardrails off");
  assert.ok(output.timeline.some((event) => event.kind === "act"));
});

test("failed attempts consume a step and run can still recover", async () => {
  let planCalls = 0;
  let actCalls = 0;

  const deps = baseDeps({
    maxSteps: 3,
    maxRetriesPerStep: 2,
    plan: async () => {
      planCalls += 1;
      if (planCalls <= 2) {
        return {
          done: false,
          reasoning: "Use option 1",
          confidence: 0.9,
          selectedChoiceIndex: 1,
        };
      }
      return {
        done: true,
        reasoning: "Recovered and done",
        finalAnswer: "done after recovery",
        confidence: 0.95,
      };
    },
    askUser: async () => null,
    act: async (action) => {
      actCalls += 1;
      if (actCalls <= 3) {
        return { ok: false, message: "Transient failure", action };
      }
      return { ok: true, message: "Success after retry cycle", action };
    },
  });

  const output = await runAgentGraph(deps, makeRunInput());

  assert.equal(actCalls, 4);
  assert.equal(planCalls, 3);
  assert.equal(output.finalAnswer, "done after recovery");
  assert.ok(
    !output.timeline.some((event) => /Reached max steps/.test(event.message)),
  );
});

test("fast mode reuses semantic snapshot when observation fingerprint is unchanged", async () => {
  let semanticCalls = 0;
  let planCalls = 0;
  const deps = baseDeps({
    observe: async () => makeObservation("https://example.com/start"),
    semanticInterpreter: async () => {
      semanticCalls += 1;
      return makeSummary("Stable page summary");
    },
    plan: async () => {
      planCalls += 1;
      if (planCalls === 1) {
        return {
          done: false,
          reasoning: "Continue flow",
          confidence: 0.9,
          selectedChoiceIndex: 1,
        };
      }
      return {
        done: true,
        reasoning: "done",
        finalAnswer: "Completed quickly",
        confidence: 0.95,
      };
    },
  });

  const output = await runAgentGraph(deps, makeRunInput());
  assert.equal(output.finalAnswer, "Completed quickly");
  assert.equal(semanticCalls, 1);
});

test("target element not found triggers immediate refresh without same-action triple retry", async () => {
  let actCalls = 0;
  let observeCalls = 0;
  const deps = baseDeps({
    maxSteps: 2,
    maxRetriesPerStep: 2,
    observe: async () => {
      observeCalls += 1;
      return makeObservation(`https://example.com/reload-${observeCalls}`);
    },
    plan: async () => ({
      done: false,
      reasoning: "Use option 1",
      confidence: 0.9,
      selectedChoiceIndex: 1,
    }),
    askUser: async () => null,
    act: async (action) => {
      actCalls += 1;
      return { ok: false, message: "Target element not found: sh-1", action };
    },
  });

  const output = await runAgentGraph(deps, makeRunInput());
  assert.ok(actCalls >= 1, "Should attempt action at least once");
  assert.ok(observeCalls >= 2);
  assert.ok(
    output.timeline.some((event) =>
      /Refreshing observation and semantic options immediately/i.test(event.message),
    ),
  );
});

test("no-progress detection forces navigate fallback strategy", async () => {
  let actCalls = 0;
  let navigateCalls = 0;
  let done = false;
  const deps = baseDeps({
    maxSteps: 4,
    observe: async () => makeObservation("https://www.google.com/"),
    semanticInterpreter: async () =>
      makeSummaryWithChoices("Stuck page", [
        {
          label: "Try search box",
          rationale: "Type in search",
          suggestedAction: "Type query",
          actionType: "type",
          elementId: "sh-1",
          actionValue: "flight from sfo to mum",
        },
      ]),
    plan: async () => {
      if (done) {
        return {
          done: true,
          reasoning: "Reached destination",
          finalAnswer: "Fallback navigation used",
          confidence: 0.95,
        };
      }
      return {
        done: false,
        reasoning: "Use option 1",
        confidence: 0.9,
        selectedChoiceIndex: 1,
      };
    },
    act: async (action) => {
      actCalls += 1;
      if (action.type === "navigate") {
        navigateCalls += 1;
        done = true;
        return { ok: true, message: "Navigating", action };
      }
      return { ok: true, message: "Typed into sh-1", action };
    },
  });

  const output = await runAgentGraph(deps, {
    ...makeRunInput(),
    goal: "Book a flight from SFO to MUM tomorrow",
  });

  assert.ok(actCalls >= 3);
  assert.ok(navigateCalls >= 1);
  assert.match(
    output.finalAnswer,
    /(Fallback navigation used|Stopped after max steps|Recursion limit reached)/i,
  );
  assert.ok(
    output.timeline.some((event) => /No progress for 2 cycles/i.test(event.message)),
  );
});

test("yes clarification maps to a concrete option when only one executable option exists", async () => {
  let actCalls = 0;
  let planCalls = 0;
  const deps = baseDeps({
    plan: async () => {
      planCalls += 1;
      if (planCalls === 1) {
        return {
          done: false,
          reasoning: "Need confirmation",
          confidence: 0.4,
          askQuestion: "Should I proceed?",
        };
      }
      return {
        done: true,
        reasoning: "Done after confirmation",
        finalAnswer: "Confirmed action executed",
        confidence: 0.95,
      };
    },
    askUser: async () => "yes",
    act: async (action) => {
      actCalls += 1;
      return { ok: true, message: "Clicked sh-1", action };
    },
  });

  const output = await runAgentGraph(deps, makeRunInput());
  assert.equal(actCalls, 1);
  assert.equal(output.finalAnswer, "Confirmed action executed");
});
