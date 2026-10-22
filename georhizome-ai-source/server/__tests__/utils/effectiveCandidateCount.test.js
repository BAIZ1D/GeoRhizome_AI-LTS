const fs = require("fs");
const os = require("os");
const path = require("path");

function loadWithConfig(reranker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-cfg-"));
  const file = path.join(dir, "app_config.json");
  fs.writeFileSync(file, JSON.stringify({ reranker }));
  jest.resetModules();
  const client = require("../../utils/rerankerClient");
  client.CONFIG_PATHS.splice(0, client.CONFIG_PATHS.length, file);
  return client;
}

describe("effective_candidate_count", () => {
  test("effective key lowers candidate fetch; wide key unchanged", () => {
    const c = loadWithConfig({
      wide_candidate_count: 30,
      effective_candidate_count: 15,
      final_top_k: 5,
    });
    const cfg = c.loadRerankerConfig();
    expect(cfg.wide_candidate_count).toBe(30);
    expect(cfg.effective_candidate_count).toBe(15);
    expect(c.resolveWideCount(cfg, 5)).toBe(15);
  });

  test("falls back to wide_candidate_count without the effective key", () => {
    const c = loadWithConfig({ wide_candidate_count: 30, final_top_k: 5 });
    const cfg = c.loadRerankerConfig();
    expect(cfg.effective_candidate_count).toBeUndefined();
    expect(c.resolveWideCount(cfg, 5)).toBe(30);
  });

  test("never below final limit; non-positive effective ignored", () => {
    const c = loadWithConfig({
      wide_candidate_count: 30,
      effective_candidate_count: 0,
    });
    const cfg = c.loadRerankerConfig();
    expect(c.resolveWideCount(cfg, 40)).toBe(40);
    expect(c.resolveWideCount(cfg, 5)).toBe(30);
  });
});
