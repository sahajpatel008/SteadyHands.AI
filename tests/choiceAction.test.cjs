const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const modulePath = path.resolve(__dirname, "../.test-build/src/lib/choiceAction.js");
const { choiceToAction } = require(modulePath);

test("choiceToAction maps click action", () => {
  const action = choiceToAction({
    label: "Continue",
    rationale: "Continue flow",
    suggestedAction: "Click Continue",
    actionType: "click",
    elementId: "sh-12",
  });

  assert.deepEqual(action, { type: "click", elementId: "sh-12" });
});

test("choiceToAction maps type/select/scroll/navigate actions", () => {
  assert.deepEqual(
    choiceToAction({
      label: "Type email",
      rationale: "Fill form",
      suggestedAction: "Type value",
      actionType: "type",
      elementId: "sh-2",
      actionValue: "a@b.com",
    }),
    { type: "type", elementId: "sh-2", text: "a@b.com" },
  );

  assert.deepEqual(
    choiceToAction({
      label: "Select country",
      rationale: "Set country",
      suggestedAction: "Select US",
      actionType: "select",
      elementId: "sh-4",
      actionValue: "US",
    }),
    { type: "select", elementId: "sh-4", value: "US" },
  );

  assert.deepEqual(
    choiceToAction({
      label: "Scroll into view",
      rationale: "See target",
      suggestedAction: "Scroll",
      actionType: "scroll",
      elementId: "sh-8",
    }),
    { type: "scroll", elementId: "sh-8" },
  );

  assert.deepEqual(
    choiceToAction({
      label: "Open page",
      rationale: "Go to destination",
      suggestedAction: "Navigate",
      actionType: "navigate",
      actionValue: "https://example.com",
    }),
    { type: "navigate", url: "https://example.com" },
  );
});

test("choiceToAction returns null for incomplete mappings", () => {
  assert.equal(
    choiceToAction({
      label: "Broken click",
      rationale: "Missing id",
      suggestedAction: "Click",
      actionType: "click",
    }),
    null,
  );

  assert.equal(
    choiceToAction({
      label: "Broken select",
      rationale: "Missing value",
      suggestedAction: "Select option",
      actionType: "select",
      elementId: "sh-9",
    }),
    null,
  );

  assert.equal(
    choiceToAction({
      label: "No action type",
      rationale: "No mapping",
      suggestedAction: "Unknown",
    }),
    null,
  );
});
