/* eslint-env jest */
const http = require("http");
const fake = require("../../__testhelpers__/fakeSparseServer");

jest.mock("../../../utils/sparse/autostart", () => ({
  ensureSparseServer: jest.fn(),
  getLastStartReason: jest.fn(),
}));
const autostart = require("../../../utils/sparse/autostart");
const { encodeQuery } = require("../../../utils/hybrid/queryEncoder");

const cfg = { port: 8004, max_input_chars: 8, timeout_ms: 5000 };
const OLD = process.env.SPARSE_BASE_PATH;
let srv;
const servers = [];

afterEach(async () => {
  if (srv) await srv.close();
  srv = null;
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  if (OLD === undefined) delete process.env.SPARSE_BASE_PATH;
  else process.env.SPARSE_BASE_PATH = OLD;
  jest.clearAllMocks();
});

async function up(opts) {
  srv = await fake.start(opts);
  process.env.SPARSE_BASE_PATH = `${srv.url}/v1`;
}

function rawServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, "127.0.0.1", () => {
      process.env.SPARSE_BASE_PATH = `http://127.0.0.1:${s.address().port}/v1`;
      resolve(s);
    });
  });
}

test("valid response returns vec and posts {input:[text]}", async () => {
  await up();
  const r = await encodeQuery("abc", { cfg, timeoutMs: 2000 });
  expect(r).toEqual({
    vec: { indices: [1, 100], values: [1.5, 0.5] },
    reason: null,
  });
  expect(srv.calls[0]).toMatchObject({ path: "/v1/sparse/encode", inputs: 1 });
});

test("long text truncated by code points before sending", async () => {
  await up({ maxChars: 8 });
  const r = await encodeQuery("😀".repeat(20), { cfg, timeoutMs: 2000 });
  expect(r.reason).toBeNull(); // would be 413 if not truncated
});

test("non-2xx -> sparse_http_<status>", async () => {
  await up({ mode: "503-busy" });
  expect(await encodeQuery("a", { cfg, timeoutMs: 2000 })).toEqual({
    vec: null,
    reason: "sparse_http_503",
  });
});

test("slow server -> sparse_timeout", async () => {
  await rawServer(() => {});
  const r = await encodeQuery("a", { cfg, timeoutMs: 50 });
  expect(r).toEqual({ vec: null, reason: "sparse_timeout" });
});

test("connection refused -> sparse_unavailable, autostart not awaited", async () => {
  autostart.ensureSparseServer.mockReturnValue(new Promise(() => {}));
  process.env.SPARSE_BASE_PATH = "http://127.0.0.1:1/v1";
  const r = await encodeQuery("a", { cfg, timeoutMs: 2000 });
  expect(r).toEqual({ vec: null, reason: "sparse_unavailable" });
  await new Promise((r2) => setImmediate(r2));
  expect(autostart.ensureSparseServer).toHaveBeenCalledTimes(1);
});

test("autostart rejection is swallowed", async () => {
  autostart.ensureSparseServer.mockRejectedValue(new Error("boom"));
  jest.spyOn(console, "warn").mockImplementation(() => {});
  process.env.SPARSE_BASE_PATH = "http://127.0.0.1:1/v1";
  const r = await encodeQuery("a", { cfg, timeoutMs: 2000 });
  expect(r.reason).toBe("sparse_unavailable");
  await new Promise((r2) => setTimeout(r2, 20));
});

test.each([
  [{ indices: [70000], values: [1] }],
  [{ indices: [1.5], values: [1] }],
  [{ indices: [1], values: [null] }],
  [{ indices: [1, 2], values: [1] }],
])("invalid payload %j -> sparse_invalid", async (row) => {
  await rawServer((req, res) => {
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [row] }));
  });
  expect(await encodeQuery("a", { cfg, timeoutMs: 2000 })).toEqual({
    vec: null,
    reason: "sparse_invalid",
  });
});

test("independent of write-path chain", async () => {
  await up();
  const { encodeSparse } = require("../../../utils/sparse/client");
  const pending = encodeSparse(["x"], {
    cfg: { ...cfg, max_inputs_per_request: 16, max_input_chars: 1024 },
  });
  const r = await encodeQuery("a", { cfg, timeoutMs: 2000 });
  expect(r.vec).not.toBeNull();
  await pending;
});
