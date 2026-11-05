const fs = require("fs");
const path = require("path");

const FILES = [
  "utils/chats/stream.js",
  "utils/chats/apiChatHandler.js",
  "utils/chats/embed.js",
  "utils/chats/openaiCompatible.js",
  "utils/telegramBot/chat/stream.js",
  "endpoints/api/workspace/index.js",
  "utils/agents/aibitat/plugins/memory.js",
];

describe("hybrid toggle forwarded by all retrieval callers", () => {
  test.each(FILES)(
    "%s passes hybrid in every performSimilaritySearch call",
    (rel) => {
      const src = fs.readFileSync(
        path.resolve(__dirname, "../../../", rel),
        "utf8"
      );
      const calls = src.split("performSimilaritySearch(").slice(1);
      expect(calls.length).toBeGreaterThan(0);
      for (const chunk of calls) {
        const body = chunk.slice(0, chunk.indexOf("})"));
        expect(body).toMatch(/hybrid:\s*[\w.]+\?\.hybridSearch\s*\?\?\s*null/);
      }
    }
  );
});

describe("agent memory search", () => {
  afterEach(() => jest.resetModules());

  test.each([[false], [true], [null]])("forwards hybrid=%s", async (val) => {
    const perform = jest.fn().mockResolvedValue({ contextTexts: ["x"] });
    jest.doMock("../../../utils/helpers", () => ({
      getVectorDbClass: () => ({ performSimilaritySearch: perform }),
      getLLMProvider: () => ({}),
    }));
    const { memory } = require("../../../utils/agents/aibitat/plugins/memory");
    let def;
    memory.plugin().setup({ function: (d) => (def = d) });
    const ctx = Object.assign(def, {
      super: {
        handlerProps: {
          invocation: { workspace: { slug: "w", hybridSearch: val } },
          log: jest.fn(),
        },
        introspect: jest.fn(),
      },
      caller: "t",
    });
    await ctx.search("q");
    expect(perform.mock.calls[0][0].hybrid).toBe(val);
  });
});
