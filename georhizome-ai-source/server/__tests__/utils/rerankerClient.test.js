/* eslint-env jest */
const fs = require("fs");

const client = require("../../utils/rerankerClient");

function mockAppConfig(reranker) {
  jest
    .spyOn(fs, "existsSync")
    .mockImplementation((p) => String(p).endsWith("app_config.json"));
  jest
    .spyOn(fs, "readFileSync")
    .mockImplementation(() => JSON.stringify({ reranker }));
}

function okResponse(results) {
  return { ok: true, status: 200, json: async () => ({ results }) };
}

describe("rerankerClient", () => {
  let warn;
  beforeEach(() => {
    client._resetWarmState();
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = jest.fn();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  describe("loadRerankerConfig", () => {
    it("reads params from app_config.json reranker", () => {
      mockAppConfig({
        enabled: true,
        base_url: "http://host.docker.internal:8001/rerank",
        wide_candidate_count: 40,
        final_top_k: 7,
        min_reranker_score: -1.6,
        timeout_ms: 12000,
        cold_timeout_ms: 20000,
        idle_unload_minutes: 15,
      });
      const cfg = client.loadRerankerConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.wide_candidate_count).toBe(40);
      expect(cfg.final_top_k).toBe(7);
      expect(cfg.min_reranker_score).toBe(-1.6);
      expect(cfg.timeout_ms).toBe(12000);
      expect(cfg.cold_timeout_ms).toBe(20000);
    });

    it("checks the container path first, then the host path", () => {
      const seen = [];
      jest.spyOn(fs, "existsSync").mockImplementation((p) => {
        seen.push(String(p));
        return false;
      });
      client.loadRerankerConfig();
      expect(seen[0]).toBe("/config/app_config.json");
      expect(seen[1]).toMatch(/config[\\/]app_config\.json$/);
      expect(seen[1]).not.toBe("/config/app_config.json");
    });

    it("falls back to documented defaults without 127.0.0.1", () => {
      jest.spyOn(fs, "existsSync").mockReturnValue(false);
      const cfg = client.loadRerankerConfig();
      expect(cfg).toEqual(client.DEFAULTS);
      expect(cfg.base_url).toBe("http://host.docker.internal:8001/rerank");
      expect(JSON.stringify(client.DEFAULTS)).not.toContain("127.0.0.1");
      // must match the shipped app_config.json (8 GB re-measure)
      expect(client.DEFAULTS.timeout_ms).toBe(23000);
      expect(client.DEFAULTS.cold_timeout_ms).toBe(38000);
    });

    it("treats only enabled === false as disabled", () => {
      mockAppConfig({ enabled: false });
      expect(client.loadRerankerConfig().enabled).toBe(false);
      jest.restoreAllMocks();
      mockAppConfig({});
      expect(client.loadRerankerConfig().enabled).toBe(true);
    });
  });

  describe("rerank", () => {
    const cfg = {
      ...client.DEFAULTS,
      base_url: "http://reranker.test/rerank",
      timeout_ms: 50,
      cold_timeout_ms: 200,
    };

    it("sends a slim candidates payload and returns results", async () => {
      fetch.mockResolvedValue(okResponse([{ id: "1", score: 2 }]));
      const out = await client.rerank({
        query: "q",
        candidates: [
          { id: "0", text: "a", vector: [1, 2] },
          { id: "1", text: "b", extra: { big: true } },
        ],
        cfg,
      });
      expect(out.results).toEqual([{ id: "1", score: 2 }]);
      const [url, opts] = fetch.mock.calls[0];
      expect(url).toBe("http://reranker.test/rerank");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        query: "q",
        candidates: [
          { id: "0", text: "a" },
          { id: "1", text: "b" },
        ],
      });
      expect(body.documents).toBeUndefined();
      expect(opts.signal).toBeDefined();
    });

    it("falls back and logs on HTTP error status", async () => {
      fetch.mockResolvedValue({ ok: false, status: 422, json: async () => ({}) });
      const out = await client.rerank({ query: "q", candidates: [{ id: "0", text: "a" }], cfg });
      expect(out.results).toBeNull();
      expect(out.reason).toBe("HTTP 422");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/HTTP 422/);
    });

    it("falls back and logs on refused connection", async () => {
      const err = new TypeError("fetch failed");
      err.cause = { code: "ECONNREFUSED" };
      fetch.mockRejectedValue(err);
      const out = await client.rerank({ query: "q", candidates: [{ id: "0", text: "a" }], cfg });
      expect(out.results).toBeNull();
      expect(out.reason).toMatch(/refused/);
      expect(warn.mock.calls[0][0]).toMatch(/refused/);
    });

    it("falls back and logs on timeout", async () => {
      fetch.mockImplementation(
        (_url, opts) =>
          new Promise((_res, rej) => {
            opts.signal.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              rej(e);
            });
          })
      );
      const out = await client.rerank({ query: "q", candidates: [{ id: "0", text: "a" }], cfg });
      expect(out.results).toBeNull();
      expect(out.reason).toMatch(/timeout after 200ms/);
      expect(warn.mock.calls[0][0]).toMatch(/timeout/);
    });

    it("uses cold_timeout_ms first, then timeout_ms once warm, cold again after idle", async () => {
      expect(client.currentTimeoutMs(cfg)).toBe(200);
      fetch.mockResolvedValue(okResponse([]));
      await client.rerank({ query: "q", candidates: [{ id: "0", text: "a" }], cfg });
      expect(client.currentTimeoutMs(cfg)).toBe(50);
      const later = Date.now() + (cfg.idle_unload_minutes * 60 + 1) * 1000;
      expect(client.currentTimeoutMs(cfg, later)).toBe(200);
    });

    it("does not call fetch when disabled or empty", async () => {
      expect((await client.rerank({ query: "q", candidates: [], cfg })).results).toBeNull();
      expect(
        (await client.rerank({ query: "q", candidates: [{ id: "0", text: "a" }], cfg: { ...cfg, enabled: false } }))
          .results
      ).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
