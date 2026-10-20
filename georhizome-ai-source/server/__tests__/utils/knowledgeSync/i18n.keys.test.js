const fs = require("fs");
const path = require("path");
const { KS_CODES } = require("../../../utils/knowledgeSync/errors");

const loc = (l) =>
  fs.readFileSync(
    path.resolve(
      __dirname,
      `../../../../frontend/src/locales/${l}/common.js`
    ),
    "utf8"
  );

// Extract the knowledgeSync block and flatten keys by indentation.
function keysOf(src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l === "  knowledgeSync: {");
  const keys = new Set();
  const stack = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === "  },") break;
    const m = l.match(/^( +)([A-Za-z0-9_]+):\s*(\{)?/);
    if (!m) continue;
    const depth = (m[1].length - 4) / 2;
    stack.length = depth;
    stack[depth] = m[2];
    if (!m[3]) keys.add(stack.join("."));
  }
  return keys;
}

const en = keysOf(loc("en"));
const ja = keysOf(loc("ja"));

test("en and ja knowledgeSync key sets match", () => {
  expect([...en].filter((k) => !ja.has(k))).toEqual([]);
  expect([...ja].filter((k) => !en.has(k))).toEqual([]);
  expect(en.size).toBeGreaterThan(100);
});

test.each(Object.keys(KS_CODES))("errors.%s exists in en and ja", (code) => {
  expect(en.has(`errors.${code}`)).toBe(true);
  expect(ja.has(`errors.${code}`)).toBe(true);
});
