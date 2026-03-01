const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const modulePath = path.resolve(__dirname, "../.test-build/src/lib/actionExecutor.js");
const { getActionScript } = require(modulePath);

test("getActionScript embeds click action payload and highlight enabled flag", () => {
  const script = getActionScript({ type: "click", elementId: "sh-9" }, true);

  assert.match(script, /"type":"click","elementId":"sh-9"/);
  assert.match(script, /if \(!el \|\| !true\) return;/);
  assert.match(script, /target\.click\(\);/);
});

test("getActionScript serializes typed text safely and disables highlight when requested", () => {
  const script = getActionScript(
    { type: "type", elementId: "email", text: "hello \"world\"\nnext" },
    false,
  );

  assert.match(script, /"type":"type","elementId":"email"/);
  assert.match(script, /hello \\"world\\"/);
  assert.match(script, /\\nnext/);
  assert.match(script, /if \(!el \|\| !false\) return;/);
  assert.match(script, /Target is not a text input/);
});

test("getActionScript supports navigate action branch", () => {
  const script = getActionScript({ type: "navigate", url: "https://example.com" }, true);

  assert.match(script, /action\.type === "navigate"/);
  assert.match(script, /window\.location\.href = action\.url;/);
  assert.match(script, /message: "Navigating"/);
});
