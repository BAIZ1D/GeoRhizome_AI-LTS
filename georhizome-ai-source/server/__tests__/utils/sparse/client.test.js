const fake = require("../../__testhelpers__/fakeSparseServer");
const client = require("../../../utils/sparse/client");

const { encodeSparse, currentTimeoutMs, _resetWarmState } = client;
const baseCfg = {
  enabled: true,
  port: 8004,
  max_input_chars: 1024,
  max_inputs_per_request: 16,
  idle_unload_minutes: 15,
  timeout_ms: 5000,
  cold_timeout_ms: 233000,
};
const OLD = process.env.SPARSE_BASE_PATH;
let srv;

afterEach(async () => {
  if (srv) await srv.close();
  srv = null;
  _resetWarmState();
  if (OLD === undefined) delete process.env.SPARSE_BASE_PATH;
  else process.env.SPARSE_BASE_PATH = OLD;
  jest.restoreAllMocks();
});

async function up(opts) {
  srv = await fake.start(opts);
  process.env.SPARSE_BASE_PATH = `${srv.url}/v1`;
  return srv;
}
const posts = (s) => s.calls.filter((c) => c.method === "POST");

test("empty input returns [] without HTTP", async () => {
  await up();
  expect(await encodeSparse([], { cfg: baseCfg })).toEqual([]);
  expect(srv.calls.length).toBe(0);
});

test("40 texts -> 3 POSTs 16/16/8, aligned", async () => {
  await up();
  const texts = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const out = await encodeSparse(texts, { cfg: baseCfg });
  expect(posts(srv).map((c) => c.inputs)).toEqual([16, 16, 8]);
  expect(out).toHaveLength(40);
  expect(out[0].indices[0]).toBe(1);
  expect(out[7].indices[0]).toBe(8);
  expect(out[39].indices[0]).toBe(8); // third batch, local index 7
});

test("1025 code points rejected before HTTP; astral counts as 1", async () => {
  await up();
  const ok = "😀".repeat(1024);
  await expect(encodeSparse([ok], { cfg: baseCfg })).resolves.toHaveLength(1);
  const before = srv.calls.length;
  await expect(
    encodeSparse(["a".repeat(1025)], { cfg: baseCfg })
  ).rejects.toMatchObject({ code: "SPARSE_E_TOO_LARGE" });
  expect(srv.calls.length).toBe(before);
});

describe("response validation", () => {
  const mockFetch = (body) =>
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });
  const row = (o) => ({ index: 0, indices: [1], values: [1], ...o });
  test.each([
    ["length mismatch", { vocab_size: 100, data: [row({ values: [1, 2] })] }],
    ["non-integer", { vocab_size: 100, data: [row({ indices: [1.5] })] }],
    ["index > 65535", { vocab_size: 100, data: [row({ indices: [65536] })] }],
    ["vocab > 65536", { vocab_size: 65537, data: [row()] }],
    ["wrong row count", { vocab_size: 100, data: [] }],
  ])("%s -> BAD_RESPONSE", async (_n, body) => {
    mockFetch(body);
    await expect(encodeSparse(["x"], { cfg: baseCfg })).rejects.toMatchObject({
      code: "SPARSE_E_BAD_RESPONSE",
    });
  });
});

test("413 -> TOO_LARGE not retried", async () => {
  await up({ mode: "413" });
  await expect(encodeSparse(["x"], { cfg: baseCfg })).rejects.toMatchObject({
    code: "SPARSE_E_TOO_LARGE",
  });
  expect(posts(srv)).toHaveLength(1);
});

test("503 degraded -> DEGRADED not retried", async () => {
  await up({ mode: "503-degraded" });
  await expect(encodeSparse(["x"], { cfg: baseCfg })).rejects.toMatchObject({
    code: "SPARSE_E_DEGRADED",
  });
  expect(posts(srv)).toHaveLength(1);
});

test("503 busy -> one retry then BUSY, no hub", async () => {
  await up({ mode: "503-busy" });
  const ensure = jest.fn();
  await expect(
    encodeSparse(["x"], { cfg: baseCfg, ensure })
  ).rejects.toMatchObject({ code: "SPARSE_E_BUSY" });
  expect(posts(srv)).toHaveLength(2);
  expect(ensure).not.toHaveBeenCalled();
});

test("concurrent calls never overlap on the wire", async () => {
  await up();
  await Promise.all([
    encodeSparse(["a"], { cfg: baseCfg }),
    encodeSparse(["b"], { cfg: baseCfg }),
    encodeSparse(["c"], { cfg: baseCfg }),
  ]);
  expect(srv.state.maxInflight).toBe(1);
  expect(posts(srv)).toHaveLength(3);
});

describe("connection failure", () => {
  async function down() {
    await up();
    await srv.close(); // port now refuses
  }
  test("autostart once, retry once; failure is bilingual and cooled down", async () => {
    await down();
    const ensure = jest.fn().mockResolvedValue(false);
    let t = 1000;
    const now = () => t;
    const e = await encodeSparse(["secret-body"], {
      cfg: baseCfg,
      ensure,
      now,
    }).catch((x) => x);
    expect(e.code).toBe("SPARSE_E_UNAVAILABLE");
    expect(e.message).toContain("ポート8004");
    expect(e.message).toContain("port 8004");
    expect(e.message).not.toContain("secret-body");
    expect(ensure).toHaveBeenCalledTimes(1);

    const fetchSpy = jest.spyOn(global, "fetch");
    t += 1000;
    await expect(
      encodeSparse(["x"], { cfg: baseCfg, ensure, now })
    ).rejects.toMatchObject({ code: "SPARSE_E_UNAVAILABLE" });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    t += baseCfg.cold_timeout_ms + 1;
    await encodeSparse(["x"], { cfg: baseCfg, ensure, now }).catch(() => {});
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  test("start ok but still refused -> UNAVAILABLE after one retry", async () => {
    await down();
    const ensure = jest.fn().mockResolvedValue(true);
    await expect(
      encodeSparse(["x"], { cfg: baseCfg, ensure })
    ).rejects.toMatchObject({ code: "SPARSE_E_UNAVAILABLE" });
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  test("successful start clears and encodes", async () => {
    await up();
    const port = srv.port;
    await srv.close();
    const ensure = jest.fn(async () => {
      srv = await fake.start({ port });
      return true;
    });
    const out = await encodeSparse(["x"], { cfg: baseCfg, ensure });
    expect(out).toHaveLength(1);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  test("retry after a restart uses the cold timeout even when warm", async () => {
    await up();
    await encodeSparse(["x"], { cfg: baseCfg });
    expect(currentTimeoutMs(baseCfg)).toBe(5000);
    const port = srv.port;
    await srv.close();
    const ensure = jest.fn(async () => {
      srv = await fake.start({ port });
      return true;
    });
    const timers = jest.spyOn(global, "setTimeout");
    await encodeSparse(["x"], { cfg: baseCfg, ensure });
    const delays = timers.mock.calls
      .map((c) => c[1])
      .filter((d) => d === 5000 || d === 233000);
    expect(delays[delays.length - 1]).toBe(233000);
  });

  test("timeout never triggers autostart", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    jest.spyOn(global, "fetch").mockRejectedValue(err);
    const ensure = jest.fn();
    await expect(
      encodeSparse(["x"], { cfg: baseCfg, ensure })
    ).rejects.toMatchObject({ code: "SPARSE_E_UNAVAILABLE" });
    expect(ensure).not.toHaveBeenCalled();
  });
});

test("cold vs warm timeout and redirect:error", async () => {
  expect(currentTimeoutMs(baseCfg, 0)).toBe(233000);
  const spy = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      vocab_size: 10,
      data: [{ index: 0, indices: [1], values: [1] }],
    }),
  });
  await encodeSparse(["x"], { cfg: baseCfg });
  expect(spy.mock.calls[0][1].redirect).toBe("error");
  expect(currentTimeoutMs(baseCfg)).toBe(5000);
  expect(currentTimeoutMs(baseCfg, Date.now() + 16 * 60 * 1000)).toBe(233000);
});

test("no input text in console output", async () => {
  const err = Object.assign(new Error("boom"), { name: "AbortError" });
  jest.spyOn(global, "fetch").mockRejectedValue(err);
  const w = jest.spyOn(console, "warn").mockImplementation(() => {});
  const l = jest.spyOn(console, "log").mockImplementation(() => {});
  await encodeSparse(["TOPSECRET"], { cfg: baseCfg }).catch(() => {});
  const all = JSON.stringify([...w.mock.calls, ...l.mock.calls]);
  expect(all).not.toContain("TOPSECRET");
});
