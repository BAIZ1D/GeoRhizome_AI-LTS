const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadLlmSampling } = require("../../utils/helpers/llmSampling");

const REAL_CFG = path.resolve(__dirname, "../../../../config/app_config.json");
const tmpCfg = (sampling) => {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "llmsamp-")),
    "app_config.json"
  );
  fs.writeFileSync(p, JSON.stringify({ llm: { sampling } }));
  return p;
};

describe("loadLlmSampling", () => {
  test("reads configured values", () => {
    const p = tmpCfg({
      temperature: 0.55,
      top_p: 0.9,
      top_k: 30,
      min_p: 0.02,
    });
    expect(loadLlmSampling(p)).toEqual({
      temperature: 0.55,
      top_p: 0.9,
      top_k: 30,
      min_p: 0.02,
    });
  });
  test("real config yields 0.6/0.95/20/0", () => {
    expect(loadLlmSampling(REAL_CFG)).toEqual({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
    });
  });
  test("missing file falls back", () => {
    expect(loadLlmSampling("/nonexistent/x.json")).toEqual({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
    });
  });
  test("temperature <= 0 replaced (never greedy)", () => {
    expect(loadLlmSampling(tmpCfg({ temperature: 0 })).temperature).toBe(0.6);
    expect(loadLlmSampling(tmpCfg({ temperature: -1 })).temperature).toBe(0.6);
  });
  test("send_llamacpp_fields false omits top_k/min_p", () => {
    const s = loadLlmSampling(tmpCfg({ send_llamacpp_fields: false }));
    expect(s).not.toHaveProperty("top_k");
    expect(s).not.toHaveProperty("min_p");
    expect(s.top_p).toBe(0.95);
  });
});

describe("GenericOpenAiLLM body capture", () => {
  const { GenericOpenAiLLM } = require("../../utils/AiProviders/genericOpenAi");
  const mk = () => {
    process.env.GENERIC_OPEN_AI_BASE_PATH = "http://127.0.0.1:1/v1";
    const llm = new GenericOpenAiLLM(
      { embedTextInput: async () => [], embedChunks: async () => [] },
      "m"
    );
    const captured = [];
    llm.openai = {
      chat: {
        completions: {
          create: async (body) => {
            captured.push(body);
            return body.stream
              ? (async function* () {})()
              : { choices: [{ message: { content: "x" } }], usage: {} };
          },
        },
      },
    };
    return { llm, captured };
  };
  const pinned = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 };
  const msgs = [{ role: "user", content: "hi" }];

  test("body non-stream pins sampling over temperature 0", async () => {
    const { llm, captured } = mk();
    await llm.getChatCompletion(msgs, { temperature: 0 });
    expect(captured[0]).toMatchObject(pinned);
  });
  test("body stream pins sampling over temperature 0", async () => {
    const { llm, captured } = mk();
    await llm.streamGetChatCompletion(msgs, { temperature: 0 });
    expect(captured[0].stream).toBe(true);
    expect(captured[0]).toMatchObject(pinned);
  });
  test("body workspace temperature 0.9 ignored", async () => {
    const { llm, captured } = mk();
    await llm.getChatCompletion(msgs, { temperature: 0.9 });
    await llm.streamGetChatCompletion(msgs, { temperature: 0.9 });
    expect(captured[0].temperature).toBe(0.6);
    expect(captured[1].temperature).toBe(0.6);
  });
});

describe("anti-greedy source scan", () => {
  const RE = /temperature:\s*(0(\.0*)?|0?\.10*)(?![\d.])/;
  const root = path.resolve(__dirname, "../../utils");
  const files = [
    "agents/aibitat/providers/genericOpenAi.js",
    "agents/aibitat/providers/helpers/tooled.js",
    "agents/aibitat/utils/summarize.js",
    "chats/agents.js",
    "AiProviders/genericOpenAi/index.js",
  ];
  test("regex self-test", () => {
    for (const s of [
      "temperature: 0",
      "temperature: 0.0",
      "temperature: 0.1",
      "temperature: .1",
    ])
      expect(RE.test(s)).toBe(true);
    for (const s of [
      "temperature: 0.6",
      "temperature: 0.95",
      "temperature: 0.7",
    ])
      expect(RE.test(s)).toBe(false);
  });
  test("no greedy temperature in chat paths", () => {
    const hits = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), "utf-8").split("\n");
      src.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        if (/^\s*(\*|\/\*)/.test(line)) return;
        if (RE.test(code)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
