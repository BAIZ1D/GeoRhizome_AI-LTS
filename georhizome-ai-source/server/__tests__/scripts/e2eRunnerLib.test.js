const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = path.resolve(__dirname, "../../../scripts/e2e/lib");
const { planCleanup } = require(`${lib}/cleanup`);
const { scanText, scanFiles } = require(`${lib}/scan`);
const { mask } = require(`${lib}/http`);
const faults = require(`${lib}/faults`);

const fakeTok = () => "gh" + "p_" + "A".repeat(24);

describe("planCleanup", () => {
  test("only new tags, never protected", () => {
    const plan = planCleanup(["a"], ["a", "b", "ks-catalog-0001"], ["ks-catalog-0001"]);
    expect(plan.map((p) => p.tag)).toEqual(["b"]);
    expect(plan[0].steps).toEqual(["release", "tag"]);
  });
  test("handles empty", () => {
    expect(planCleanup([], [], [])).toEqual([]);
    expect(planCleanup(undefined, undefined, undefined)).toEqual([]);
  });
});

describe("scan", () => {
  test("detects tokens and exact pat", () => {
    expect(scanText(`x ${fakeTok()}`, null)).toBe(true);
    expect(scanText("hello secretvalue1", "secretvalue1")).toBe(true);
    expect(scanText("clean", "secretvalue1")).toBe(false);
  });
  test("scanFiles returns names only", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-scan-"));
    const f = path.join(d, "a.log");
    fs.writeFileSync(f, fakeTok());
    const hits = scanFiles([f, path.join(d, "missing")], null);
    expect(hits).toEqual([f]);
    expect(JSON.stringify(hits)).not.toContain("AAAA");
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("mask", () => {
  afterEach(() => {
    delete process.env.KS_E2E_PASSPHRASE;
    delete process.env.KS_E2E_WRONG_PASSPHRASE;
    delete process.env.KS_E2E_PAT;
  });
  test("masks token shape and exact env values", () => {
    process.env.KS_E2E_PASSPHRASE = "pass-" + "phrase-xyz";
    process.env.KS_E2E_WRONG_PASSPHRASE = "wrong-" + "one-abc";
    process.env.KS_E2E_PAT = "plainpat" + "value1";
    const out = mask(`${fakeTok()} pass-phrase-xyz wrong-one-abc plainpatvalue1`);
    expect(out).not.toMatch(/AAAA|phrase-xyz|one-abc|patvalue1/);
  });
});

describe("faults", () => {
  const orig = faults.deps.execFile;
  afterEach(() => {
    faults.deps.execFile = orig;
  });
  function stub(map, calls) {
    faults.deps.execFile = (cmd, args, _o, cb) => {
      calls.push([cmd, ...args]);
      const r = map(cmd, args);
      if (r instanceof Error) return cb(r);
      cb(null, r);
    };
  }
  test("zero pids throws", async () => {
    stub(() => "", []);
    await expect(faults.killServer({ mode: "host", port: 1 })).rejects.toThrow(/exactly one/);
  });
  test("two pids throws", async () => {
    stub(() => "1\n2\n", []);
    await expect(faults.killServer({ mode: "host", port: 1 })).rejects.toThrow(/exactly one/);
  });
  test("non-node comm hints container mode", async () => {
    stub((c) => (c === "lsof" ? "99999\n" : "com.docker.backend\n"), []);
    await expect(faults.killServer({ mode: "host", port: 1 })).rejects.toThrow(/container mode/);
  });
  test("lsof args use LISTEN filter", async () => {
    const calls = [];
    stub(() => "", calls);
    await faults.listenPids(3001);
    expect(calls[0]).toEqual(["lsof", "-nP", "-iTCP:3001", "-sTCP:LISTEN", "-t"]);
  });
  test("container mode kills exact name after inspect", async () => {
    const calls = [];
    stub((c, a) => (a[0] === "inspect" ? "true\n" : ""), calls);
    await faults.killServer({ mode: "container", name: "georhizome-core" });
    expect(calls[1]).toEqual(["docker", "kill", "--signal=KILL", "georhizome-core"]);
  });
  test("container mode refuses when not running or glob", async () => {
    const calls = [];
    stub(() => "false\n", calls);
    await expect(faults.killServer({ mode: "container", name: "x" })).rejects.toThrow(/not running/);
    expect(calls.length).toBe(1);
    await expect(faults.killServer({ mode: "container", name: "geo*" })).rejects.toThrow(/invalid/);
  });
  test("waitForPhase observes phase", async () => {
    const seq = [{ phase: "a" }, { phase: "upload" }];
    let i = 0;
    const r = await faults.waitForPhase(async () => seq[Math.min(i++, 1)], "upload", 1, 1000);
    expect(r.seen).toEqual(["a", "upload"]);
  });
  test("waitForPhase stops on server terminal state succeeded", async () => {
    await expect(
      faults.waitForPhase(async () => ({ phase: "publish", state: "succeeded" }), "upload", 1, 1000)
    ).rejects.toThrow(/job ended \(succeeded\)/);
  });
  test("runner only uses server terminal state names", () => {
    const src = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../scripts/e2e/ks-e2e-runner.js"),
      "utf8"
    );
    expect(src).not.toMatch(/"done"/);
    expect(src).toMatch(/"succeeded"/);
  });
});
