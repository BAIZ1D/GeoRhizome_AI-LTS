const fake = require("../../__testhelpers__/fakeSparseServer");
const {
  ensureSparseServer,
  getLastStartReason,
} = require("../../../utils/sparse/autostart");
const {
  encodeSparse,
  _resetWarmState,
} = require("../../../utils/sparse/client");

const cfg = {
  enabled: true,
  port: 8004,
  max_input_chars: 1024,
  max_inputs_per_request: 16,
  idle_unload_minutes: 15,
  timeout_ms: 5000,
  cold_timeout_ms: 233000,
};
const OLD = {
  b: process.env.SPARSE_BASE_PATH,
  h: process.env.HARDWARE_SERVER_URL,
};
const refused = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
const okRes = (state = "ready") => ({
  ok: true,
  status: 200,
  json: async () => ({ state }),
});

beforeEach(() => {
  process.env.SPARSE_BASE_PATH = "http://sparse.test:8004/v1";
  process.env.HARDWARE_SERVER_URL = "http://hub.test:8002";
});
afterEach(() => {
  jest.restoreAllMocks();
  _resetWarmState();
  for (const [k, v] of [
    ["SPARSE_BASE_PATH", OLD.b],
    ["HARDWARE_SERVER_URL", OLD.h],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const sleep = async () => {};
const serveCalls = (spy) =>
  spy.mock.calls.filter(([u]) => String(u).endsWith("/hardware/serve"));

test("already alive (unloaded) -> true, no serve", async () => {
  const spy = jest.spyOn(global, "fetch").mockResolvedValue(okRes("unloaded"));
  expect(await ensureSparseServer(cfg, { sleep })).toBe(true);
  expect(serveCalls(spy)).toHaveLength(0);
});

test("refused -> one serve then polls until alive", async () => {
  let healthHits = 0;
  const spy = jest.spyOn(global, "fetch").mockImplementation(async (u, o) => {
    if (String(u).endsWith("/hardware/serve")) {
      expect(JSON.parse(o.body)).toEqual({ category: "sparse" });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    healthHits += 1;
    if (healthHits <= 3) throw refused();
    return okRes("loading");
  });
  expect(await ensureSparseServer(cfg, { sleep, pollMs: 1 })).toBe(true);
  expect(serveCalls(spy)).toHaveLength(1);
});

test("concurrent calls single-flight: one serve", async () => {
  let up = false;
  const spy = jest.spyOn(global, "fetch").mockImplementation(async (u) => {
    if (String(u).endsWith("/hardware/serve")) {
      await new Promise((r) => setTimeout(r, 20));
      up = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (!up) throw refused();
    return okRes();
  });
  const [a, b] = await Promise.all([
    ensureSparseServer(cfg, { sleep, pollMs: 1 }),
    ensureSparseServer(cfg, { sleep, pollMs: 1 }),
  ]);
  expect([a, b]).toEqual([true, true]);
  expect(serveCalls(spy)).toHaveLength(1);
});

test("hub unreachable / non-2xx / never answers -> false", async () => {
  jest.spyOn(global, "fetch").mockImplementation(async (u) => {
    throw refused();
  });
  expect(await ensureSparseServer(cfg, { sleep })).toBe(false);
  jest.restoreAllMocks();

  jest.spyOn(global, "fetch").mockImplementation(async (u) => {
    if (String(u).endsWith("/hardware/serve"))
      return { ok: false, status: 500 };
    throw refused();
  });
  expect(await ensureSparseServer(cfg, { sleep })).toBe(false);
  jest.restoreAllMocks();

  jest.spyOn(global, "fetch").mockImplementation(async (u) => {
    if (String(u).endsWith("/hardware/serve"))
      return { ok: true, status: 200, json: async () => ({}) };
    throw refused();
  });
  let t = 0;
  const now = () => t;
  const slp = async () => {
    t += 100000;
  };
  expect(await ensureSparseServer(cfg, { sleep: slp, now })).toBe(false);
});

test("degraded health -> false with reason", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(okRes("degraded"));
  expect(await ensureSparseServer(cfg, { sleep })).toBe(false);
  expect(getLastStartReason()).toBe("degraded");
});

test("client e2e: down then started by mocked hub", async () => {
  const srv = await fake.start();
  const port = srv.port;
  await srv.close();
  process.env.SPARSE_BASE_PATH = `http://127.0.0.1:${port}/v1`;
  let revived = null;
  const realFetch = global.fetch;
  jest.spyOn(global, "fetch").mockImplementation(async (u, o) => {
    if (String(u).endsWith("/hardware/serve")) {
      revived = await fake.start({ port });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return realFetch(u, o);
  });
  const out = await encodeSparse(["x"], { cfg });
  expect(out).toHaveLength(1);
  await revived.close();
});

test("client e2e: hub failing -> bilingual UNAVAILABLE", async () => {
  const srv = await fake.start();
  const port = srv.port;
  await srv.close();
  process.env.SPARSE_BASE_PATH = `http://127.0.0.1:${port}/v1`;
  const realFetch = global.fetch;
  jest.spyOn(global, "fetch").mockImplementation(async (u, o) => {
    if (String(u).endsWith("/hardware/serve"))
      return { ok: false, status: 500 };
    return realFetch(u, o);
  });
  const e = await encodeSparse(["x"], { cfg }).catch((x) => x);
  expect(e.code).toBe("SPARSE_E_UNAVAILABLE");
  expect(e.message).toContain("スパース検索用サーバー");
});
