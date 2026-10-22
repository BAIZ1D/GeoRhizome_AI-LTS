#!/usr/bin/env node
/**
 * Knowledge Sync live E2E runner.
 * Usage: node scripts/e2e/ks-e2e-runner.js <command> [flags]
 *
 * Secrets come from env ONLY (never argv):
 *   KS_E2E_PAT, KS_E2E_PASSPHRASE, KS_E2E_WRONG_PASSPHRASE, KS_E2E_AUTH (optional API bearer token)
 * Endpoints (no defaults hardcoded): --base-a / KS_E2E_BASE_A (host-run), --base-b / KS_E2E_BASE_B (Docker-run)
 * Repo for gh calls: --repo / KS_E2E_REPO. Log: --log (default 08-E2E-LOG.md in the phase dir).
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { request, log: rawLog, mask } = require("./lib/http");
const faults = require("./lib/faults");
const { planCleanup } = require("./lib/cleanup");
const { scanFiles, scanText } = require("./lib/scan");

const PHASE_DIR = path.resolve(
  __dirname,
  "../../../.planning/phases/08-live-e2e-regression-gate"
);
const COMMANDS = [
  "snapshot",
  "publish",
  "sync",
  "drill-upload",
  "drill-import",
  "drill-passphrase",
  "scan",
  "cleanup",
];

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[k] = true;
      else {
        flags[k] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { cmd: pos[0], flags };
}

function help() {
  console.log(
    `ks-e2e-runner <command> [flags]\nCommands:\n  ${COMMANDS.join("\n  ")}\n` +
      `Flags: --base-a --base-b --repo --slug --log --confirm --container --compose-file\n` +
      `       --port-a --kill-mode --interval-ms --timeout-ms --min-upload-bytes --protected-tag\n` +
      `Env: KS_E2E_PAT KS_E2E_PASSPHRASE KS_E2E_WRONG_PASSPHRASE KS_E2E_AUTH KS_E2E_BASE_A KS_E2E_BASE_B KS_E2E_REPO`
  );
}

function need(v, msg) {
  if (!v) {
    console.error(`ABORT: ${msg}`);
    process.exit(2);
  }
  return v;
}

function gh(args, repo) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GH_TOKEN: process.env.KS_E2E_PAT || "" };
    execFile("gh", args, { env, maxBuffer: 50 * 1024 * 1024 }, (e, out, err) =>
      e ? reject(new Error(mask(String(err || e.message)))) : resolve(String(out))
    );
  });
}

async function listTags(repo) {
  const out = await gh(
    ["release", "list", "--repo", repo, "--limit", "500", "--json", "tagName"],
    repo
  );
  return JSON.parse(out).map((r) => r.tagName);
}

function protectedTags(flags) {
  const tags = [flags["protected-tag"]];
  try {
    tags.push(
      require("../../server/utils/knowledgeSync/config").getKnowledgeSyncConfig()
        .catalog_release_tag
    );
  } catch (_) {
    tags.push("ks-catalog-0001");
  }
  return tags.filter((t) => typeof t === "string");
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (!cmd || flags.help || cmd === "--help" || !COMMANDS.includes(cmd)) {
    help();
    return;
  }
  const logFile = typeof flags.log === "string" ? flags.log : path.join(PHASE_DIR, "08-E2E-LOG.md");
  const L = (m) => rawLog(m, logFile);
  const interval = Number(flags["interval-ms"] || process.env.KS_E2E_INTERVAL_MS || 500);
  const timeout = Number(flags["timeout-ms"] || process.env.KS_E2E_TIMEOUT_MS || 600000);
  const token = process.env.KS_E2E_AUTH || undefined;
  const baseA = flags["base-a"] || process.env.KS_E2E_BASE_A;
  const baseB = flags["base-b"] || process.env.KS_E2E_BASE_B;
  const repo = flags.repo || process.env.KS_E2E_REPO;
  const slug = flags.slug || "ks-e2e-test";
  const snapFile = path.join(PHASE_DIR, ".e2e-snapshot.json");
  const api = (base, p, o = {}) => request(base, `/api${p}`, { token, ...o });

  const pollJob = async (base, id) => {
    const r = await api(base, `/knowledge-sync/jobs/${id}`);
    return r.json?.job;
  };
  const waitDone = async (base, id) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const j = await pollJob(base, id);
      if (j && ["done", "failed", "cancelled", "interrupted"].includes(j.state)) return j;
      await faults.sleep(interval);
    }
    throw new Error("job timeout");
  };
  const waitHealth = async (base) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const r = await api(base, "/ping");
        if (r.ok) return true;
      } catch (_) {}
      await faults.sleep(interval);
    }
    return false;
  };
  const counts = async (base) => {
    const r = await api(base, `/workspace/${slug}`);
    const ws = r.json?.workspace;
    const w = Array.isArray(ws) ? ws[0] : ws;
    return {
      docs: (w?.documents || []).length,
      settings: JSON.stringify({
        p: w?.openAiPrompt,
        t: w?.openAiTemp,
        h: w?.openAiHistory,
        n: w?.similarityThreshold,
        k: w?.topN,
      }),
    };
  };
  const setPass = async (base, pass) =>
    api(base, "/knowledge-sync/passphrase", { method: "PUT", body: { passphrase: pass } });
  const restartPrompt = async (base, why) => {
    L(`RESTART NOW (${why}); waiting for health...`);
    if (!(await waitHealth(base)))
      L("server did not return; start it manually (e.g. yarn dev:server) and re-run assertions");
  };

  switch (cmd) {
    case "snapshot": {
      need(process.env.KS_E2E_PAT, "KS_E2E_PAT env required");
      need(repo, "--repo or KS_E2E_REPO required");
      fs.writeFileSync(snapFile, JSON.stringify({ tags: await listTags(repo) }));
      L(`snapshot written: ${snapFile}`);
      break;
    }
    case "publish": {
      need(process.env.KS_E2E_PAT, "KS_E2E_PAT env required");
      need(process.env.KS_E2E_PASSPHRASE, "KS_E2E_PASSPHRASE env required");
      need(baseA, "--base-a or KS_E2E_BASE_A required");
      await api(baseA, "/knowledge-sync/pat", { method: "PUT", body: { pat: process.env.KS_E2E_PAT } });
      await setPass(baseA, process.env.KS_E2E_PASSPHRASE);
      const r = await api(baseA, `/knowledge-sync/publish/${slug}`, { method: "POST" });
      need(r.json?.jobId, `publish rejected (${r.status})`);
      const j = await waitDone(baseA, r.json.jobId);
      L(`publish state=${j.state} phase=${j.phase}`);
      if (j.state !== "done") process.exitCode = 1;
      break;
    }
    case "sync": {
      need(process.env.KS_E2E_PASSPHRASE, "KS_E2E_PASSPHRASE env required");
      need(baseB, "--base-b or KS_E2E_BASE_B required");
      await setPass(baseB, process.env.KS_E2E_PASSPHRASE);
      const before = await counts(baseB);
      const r = await api(baseB, `/knowledge-sync/sync/${slug}`, { method: "POST", body: {} });
      need(r.json?.jobId, `sync rejected (${r.status})`);
      let j = await waitDone(baseB, r.json.jobId);
      if (j.state === "awaiting_confirm" || j.preview) {
        await api(baseB, `/knowledge-sync/jobs/${r.json.jobId}/confirm`, { method: "POST", body: {} });
        j = await waitDone(baseB, r.json.jobId);
      }
      const after = await counts(baseB);
      L(`sync state=${j.state} docs ${before.docs}->${after.docs} settings_unchanged=${before.settings === after.settings}`);
      if (j.state !== "done") process.exitCode = 1;
      break;
    }
    case "drill-upload": {
      need(process.env.KS_E2E_PAT, "KS_E2E_PAT env required");
      need(baseA, "--base-a or KS_E2E_BASE_A required");
      const port = need(flags["port-a"] || process.env.KS_E2E_PORT_A, "--port-a required");
      const r = await api(baseA, `/knowledge-sync/publish/${slug}`, { method: "POST" });
      need(r.json?.jobId, `publish rejected (${r.status})`);
      const { seen } = await faults.waitForPhase(() => pollJob(baseA, r.json.jobId), "upload", Math.min(interval, 200), timeout);
      L(`observed phases: ${seen.join(",")}`);
      L(`kill: ${JSON.stringify(await faults.killServer({ mode: "host", port: Number(port) }))}`);
      await restartPrompt(baseA, "host server killed during upload");
      if (repo) L(`releases after: ${(await listTags(repo)).join(",")}`);
      break;
    }
    case "drill-import": {
      need(process.env.KS_E2E_PASSPHRASE, "KS_E2E_PASSPHRASE env required");
      need(baseB, "--base-b or KS_E2E_BASE_B required");
      await setPass(baseB, process.env.KS_E2E_PASSPHRASE);
      const pre = await counts(baseB);
      const r = await api(baseB, `/knowledge-sync/sync/${slug}`, { method: "POST", body: {} });
      need(r.json?.jobId, `sync rejected (${r.status})`);
      await waitDone(baseB, r.json.jobId).catch(() => null);
      const j2 = await pollJob(baseB, r.json.jobId);
      if (j2?.preview) await api(baseB, `/knowledge-sync/jobs/${r.json.jobId}/confirm`, { method: "POST", body: {} });
      await faults.waitForPhase(() => pollJob(baseB, r.json.jobId), "import", Math.min(interval, 200), timeout);
      const name = flags.container || "georhizome-core";
      L(`kill: ${JSON.stringify(await faults.killServer({ mode: "container", name }))}`);
      await faults.restartServer({ mode: "container", composeFile: flags["compose-file"] });
      await waitHealth(baseB);
      const post = await counts(baseB);
      L(`rollback docs ${pre.docs}->${post.docs} equal=${pre.docs === post.docs}`);
      if (pre.docs !== post.docs) process.exitCode = 1;
      break;
    }
    case "drill-passphrase": {
      need(process.env.KS_E2E_WRONG_PASSPHRASE, "KS_E2E_WRONG_PASSPHRASE env required");
      need(baseB, "--base-b or KS_E2E_BASE_B required");
      const before = await counts(baseB);
      await setPass(baseB, process.env.KS_E2E_WRONG_PASSPHRASE);
      const r = await api(baseB, `/knowledge-sync/sync/${slug}`, { method: "POST", body: {} });
      const j = r.json?.jobId ? await waitDone(baseB, r.json.jobId) : { state: `rejected:${r.status}` };
      const after = await counts(baseB);
      const same = before.docs === after.docs && before.settings === after.settings;
      L(`wrong-passphrase state=${j.state} unchanged=${same}`);
      if (!same || j.state === "done") process.exitCode = 1;
      break;
    }
    case "scan": {
      const files = typeof flags.files === "string" ? flags.files.split(",") : [];
      const hits = scanFiles(files, process.env.KS_E2E_PAT);
      L(`scan files=${files.length} hits=${hits.length} ${hits.join(",")}`);
      if (flags.container) {
        const out = await new Promise((res) =>
          execFile("docker", ["logs", String(flags.container)], { maxBuffer: 200 * 1024 * 1024 }, (_e, o, e) => res(`${o || ""}${e || ""}`))
        );
        const bad = scanText(out, process.env.KS_E2E_PAT);
        L(`docker logs hit=${bad}`);
        if (bad) process.exitCode = 1;
      }
      if (repo && process.env.KS_E2E_PAT) {
        const body = await gh(["release", "list", "--repo", repo, "--json", "tagName,name"], repo);
        const bad = scanText(body, process.env.KS_E2E_PAT);
        L(`release metadata hit=${bad}`);
        if (bad) process.exitCode = 1;
      }
      if (hits.length) process.exitCode = 1;
      break;
    }
    case "cleanup": {
      need(process.env.KS_E2E_PAT, "KS_E2E_PAT env required");
      need(repo, "--repo or KS_E2E_REPO required");
      need(fs.existsSync(snapFile), `snapshot missing: ${snapFile}`);
      const snap = JSON.parse(fs.readFileSync(snapFile, "utf8"));
      const plan = planCleanup(snap.tags, await listTags(repo), protectedTags(flags));
      L(`cleanup plan: ${JSON.stringify(plan)}`);
      if (!flags.confirm) {
        L("dry run; pass --confirm to execute");
        break;
      }
      for (const p of plan) {
        await gh(["release", "delete", p.tag, "--repo", repo, "--yes", "--cleanup-tag"], repo);
        L(`deleted release+tag ${p.tag}`);
      }
      break;
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(mask(e && e.stack ? e.stack : String(e)));
    process.exit(1);
  });
}

module.exports = { parseArgs };
