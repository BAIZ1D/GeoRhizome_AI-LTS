const fs = require("fs");
const path = require("path");

const RE = /\bllm\s*(\?\.|\.)\s*base_url|\bllm\s*\??\.?\s*\[\s*["']base_url["']\s*\]/;
const SKIP = new Set(["node_modules", "storage", "__tests__", "swagger"]);
const root = path.resolve(__dirname, "../..");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe("llm.base_url has no Node reader (SC8)", () => {
  test("regex self-test", () => {
    expect(RE.test("const u = cfg.llm.base_url;")).toBe(true);
    expect(RE.test('cfg.llm["base_url"]')).toBe(true);
    expect(RE.test("cfg.llm?.base_url")).toBe(true);
    expect(RE.test("embedding.base_url")).toBe(false);
    expect(isComment("  // cfg.llm.base_url")).toBe(true);
  });

  test("no server module reads llm.base_url", () => {
    const hits = [];
    for (const f of walk(root)) {
      fs.readFileSync(f, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (isComment(line)) return;
          if (RE.test(line.replace(/\/\/.*$/, "")))
            hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  test("both genericOpenAi modules use GENERIC_OPEN_AI_BASE_PATH", () => {
    for (const f of [
      "utils/AiProviders/genericOpenAi/index.js",
      "utils/agents/aibitat/providers/genericOpenAi.js",
    ])
      expect(fs.readFileSync(path.join(root, f), "utf-8")).toContain(
        "GENERIC_OPEN_AI_BASE_PATH"
      );
  });
});
