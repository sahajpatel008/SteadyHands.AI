const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const modulePath = path.resolve(__dirname, "../.test-build/src/lib/contentExtractor.js");
const { getExtractionScript } = require(modulePath);

test("getExtractionScript injects the requested text limit", () => {
  const script = getExtractionScript(2500);

  assert.match(script, /slice\(0, 2500\)/);
  assert.match(script, /title: document\.title \|\| "Untitled"/);
  assert.match(script, /data-sh-id/);
});                                                                     
                                              
test("getExtractionScript includes all expected interactive selectors", () => {
  const script = getExtractionScript(1000);

  assert.match(script, /a\[href\]/);
  assert.match(script, /button/);
  assert.match(script, /input/);
  assert.match(script, /select/);
  assert.match(script, /textarea/);
  assert.match(script, /\[role='button'\]/);
  assert.match(script, /\[role='link'\]/);
  assert.match(script, /\[tabindex\]:not\(\[tabindex='-1'\]\)/);
});

test("getExtractionScript preserves zero limit behavior", () => {
  const script = getExtractionScript(0);
  assert.match(script, /slice\(0, 0\)/);
});
