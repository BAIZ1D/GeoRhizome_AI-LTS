const { execFile } = require("child_process");

const deps = { execFile };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    deps.execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ""));
    });
  });
}

async function listenPids(port) {
  let out = "";
  try {
    out = await run("lsof", ["-nP", `-iTCP:${Number(port)}`, "-sTCP:LISTEN", "-t"]);
  } catch (_) {
    return [];
  }
  return out
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));
}

async function killServer(opts) {
  if (opts.mode === "container") {
    const name = opts.name || "georhizome-core";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
      throw new Error("invalid container name (globs not allowed)");
    const state = (
      await run("docker", ["inspect", "-f", "{{.State.Running}}", name])
    ).trim();
    if (state !== "true") throw new Error(`container ${name} is not running`);
    await run("docker", ["kill", "--signal=KILL", name]);
    return { mode: "container", name };
  }
  const pids = await listenPids(opts.port);
  if (pids.length !== 1)
    throw new Error(`expected exactly one LISTEN pid on port, found ${pids.length}`);
  const comm = (await run("ps", ["-o", "comm=", "-p", String(pids[0])])).trim();
  if (!/node/i.test(comm))
    throw new Error(
      `LISTEN process is "${comm}", not node; use container mode (--kill-mode container)`
    );
  process.kill(pids[0], "SIGKILL");
  return { mode: "host", pid: pids[0] };
}

async function restartServer(opts) {
  const file = opts.composeFile || "installers/employee-docker-compose.yml";
  await run("docker", ["compose", "-f", file, "up", "-d"]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPhase(fetchJob, phase, intervalMs, timeoutMs) {
  const seen = [];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const job = await fetchJob();
    if (job && job.phase && seen[seen.length - 1] !== job.phase)
      seen.push(job.phase);
    if (job && job.phase === phase) return { job, seen };
    if (job && ["succeeded", "failed", "cancelled", "interrupted"].includes(job.state))
      throw new Error(`job ended (${job.state}) before phase ${phase}`);
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for phase ${phase}`);
}

module.exports = { listenPids, killServer, restartServer, waitForPhase, deps, sleep };
