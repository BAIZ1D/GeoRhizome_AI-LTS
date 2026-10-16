/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const client = require("../../utils/rerankerClient");

const SERVER = path.resolve(__dirname, "../..");
const CALLERS = [
  "utils/chats/index.js",
  "utils/chats/embed.js",
  "utils/agents/index.js",
  "utils/chats/agents.js",
];

const HISTORY = [0, 1, 2, 3].map((i) => ({
  prompt: `q${i}`,
  response: JSON.stringify({ text: `a${i}` }),
}));
const toText = (r) => `User: ${r.prompt}\nAgent: ${JSON.parse(r.response).text}`;
const CFG = {
  ...client.DEFAULTS,
  base_url: "http://reranker.test/rerank",
  final_top_k: 2,
};

describe("RET-05: history and agent rerank callers", () => {
  beforeEach(() => {
    client._resetWarmState();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = jest.fn();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  it.each(CALLERS)("%s delegates to rerankHistory (no inline fetch/documents)", (file) => {
    const src = fs.readFileSync(path.join(SERVER, file), "utf8");
    expect(src).toMatch(/rerankHistory\(/);
    expect(src).not.toMatch(/documents:\s*rawHistory/);
    expect(src).not.toMatch(/reranker_server_url/);
    expect(src).not.toContain("127.0.0.1");
  });

  it("sends candidates, keeps top final_top_k in chronological order", async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { id: "3", score: 4 },
          { id: "0", score: 3 },
          { id: "2", score: 1 },
        ],
      }),
    });
    const out = await client.rerankHistory({ query: "now", history: HISTORY, toText, cfg: CFG });
    expect(out).toEqual([HISTORY[0], HISTORY[3]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.candidates).toHaveLength(4);
    expect(body.candidates[1]).toEqual({ id: "1", text: "User: q1\nAgent: a1" });
    expect(body.documents).toBeUndefined();
    expect(fetch.mock.calls[0][1].signal).toBeDefined();
  });

  it("checks res.ok and returns the history unchanged on a 422", async () => {
    fetch.mockResolvedValue({ ok: false, status: 422, json: async () => ({ detail: "x" }) });
    const out = await client.rerankHistory({ query: "now", history: HISTORY, toText, cfg: CFG });
    expect(out).toBe(HISTORY);
    expect(console.warn.mock.calls[0][0]).toMatch(/HTTP 422/);
  });

  it("degrades gracefully when the reranker is unreachable", async () => {
    fetch.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    const out = await client.rerankHistory({ query: "now", history: HISTORY, toText, cfg: CFG });
    expect(out).toBe(HISTORY);
  });

  it("does nothing without a prompt or when disabled", async () => {
    expect(await client.rerankHistory({ query: "", history: HISTORY, toText, cfg: CFG })).toBe(HISTORY);
    expect(
      await client.rerankHistory({ query: "q", history: HISTORY, toText, cfg: { ...CFG, enabled: false } })
    ).toBe(HISTORY);
    expect(fetch).not.toHaveBeenCalled();
  });
});
