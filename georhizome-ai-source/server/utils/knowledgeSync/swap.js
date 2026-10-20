const fs = require("fs");
const path = require("path");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const paths = require("./paths");
const journalLib = require("./journal");
const marker = require("./marker");
const locks = require("./locks");
const { buildSnapshotRows } = require("./docmap");
const { safeLog } = require("./redact");

const prisma = () => require("../prisma");
const BATCH = 500;

class CrashSignal extends Error {
  constructor(name) {
    super("crash:" + name);
    this.name = "CrashSignal";
  }
}

// TEST ONLY: failpoints are inert unless set.
let failpoint = null;
function setFailpoint(name) {
  failpoint = name || null;
}
function fp(name) {
  if (failpoint === "crash:" + name) throw new CrashSignal(name);
  if (failpoint === name) throw new Error("failpoint");
}

const exists = (p) =>
  fs.promises.access(p).then(
    () => true,
    () => false
  );
const rmrf = (p) => fs.promises.rm(p, { recursive: true, force: true });
async function mv(from, to) {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.rename(from, to);
}

function pendingRoot(slug) {
  return path.join(paths.backupRoot(slug), "backup-pending");
}

// Where a consumed source goes when its step is reversed (journal-only).
function undoTargets(journal) {
  const bk = paths.backupRoot(journal.slug);
  const jd = journalLib.jobDir(journal.jobId);
  return journal.kind === "rollback"
    ? { lance: path.join(bk, "lance"), docs: path.join(bk, "docs") }
    : { lance: path.join(jd, "undo-lance"), docs: path.join(jd, "undo-docs") };
}

async function reverseOne(live, pending, undo, had) {
  if (had) {
    // pending present => the original was moved aside (S1/S3 done).
    if (await exists(pending)) {
      if (await exists(live)) await mv(live, undo);
      await mv(pending, live);
    }
  } else if (await exists(live)) {
    await mv(live, undo);
  }
}

/** Idempotent, journal-only reversal (also used by boot recovery). */
async function rollbackSwap(journal) {
  const slug = journal.slug;
  const pend = pendingRoot(slug);
  const undo = undoTargets(journal);
  await reverseOne(
    paths.ksDocsDir(slug),
    path.join(pend, "docs"),
    undo.docs,
    journal.hadDocs
  );
  await reverseOne(
    paths.lanceTablePath(slug),
    path.join(pend, "lance"),
    undo.lance,
    journal.hadLance
  );
  await rmrf(pend);
  try {
    await journalLib.updateJournal(journal.jobId, { state: "rolled_back" });
  } catch {
    // journal dir may already be gone
  }
  await journalLib.removeJournalDir(journal.jobId);
}

/** Idempotent post-commit promotion of pending -> backup, then cleanup. */
async function finishSwap(journal) {
  const slug = journal.slug;
  const bk = paths.backupRoot(slug);
  const pend = pendingRoot(slug);
  if (await exists(pend)) {
    const plan = [
      ["lance", journal.hadLance],
      ["docs", journal.hadDocs],
      ["rows.json", true],
      ["marker.json", true],
    ];
    for (const [name, had] of plan) {
      const src = path.join(pend, name);
      if (had) {
        if (await exists(src)) {
          await rmrf(path.join(bk, name));
          await mv(src, path.join(bk, name));
        }
      } else {
        await rmrf(path.join(bk, name));
      }
    }
    await rmrf(pend);
  }
  await journalLib.removeJournalDir(journal.jobId);
}

const toDate = (v) => (v instanceof Date ? v : v ? new Date(v) : undefined);

async function commitDb(ctx, cfg) {
  const { slug, workspaceId, source } = ctx;
  await prisma().$transaction(
    async (tx) => {
      const old = await tx.workspace_documents.findMany({
        where: { workspaceId },
      });
      const oldIds = old.map((d) => d.docId);
      for (let i = 0; i < oldIds.length; i += BATCH)
        await tx.document_vectors.deleteMany({
          where: { docId: { in: oldIds.slice(i, i + BATCH) } },
        });
      await tx.workspace_documents.deleteMany({ where: { workspaceId } });
      const docs = source.rows.docs.map((d) => ({
        ...d,
        workspaceId,
        createdAt: toDate(d.createdAt),
        lastUpdatedAt: toDate(d.lastUpdatedAt),
      }));
      for (let i = 0; i < docs.length; i += BATCH)
        await Promise.all(
          docs
            .slice(i, i + BATCH)
            .map((data) => tx.workspace_documents.create({ data }))
        );
      const vecs = source.rows.vectors;
      for (let i = 0; i < vecs.length; i += BATCH)
        await Promise.all(
          vecs.slice(i, i + BATCH).map((v) =>
            tx.document_vectors.create({
              data: { docId: v.docId, vectorId: v.vectorId },
            })
          )
        );
      fp("in:S5");
      if (source.marker)
        await marker.writeMarker(tx, slug, {
          ...source.marker,
          jobId: ctx.jobId,
        });
      else await marker.deleteMarker(tx, slug);
    },
    { timeout: cfg.import_tx_timeout_ms, maxWait: cfg.import_tx_max_wait_ms }
  );
}

async function runSwap(ctx, { config } = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const { jobId, kind, slug, source } = ctx;
  const st = locks.state(slug);
  if (!st || st.op !== kind)
    throw new KnowledgeSyncError("KS_E_BUSY", { phase: "lock" });

  const live = paths.lanceTablePath(slug);
  const liveDocs = paths.ksDocsDir(slug);
  const pend = pendingRoot(slug);
  paths.assertSameFilesystem(
    ...[live, liveDocs, source.lance, pend].filter(Boolean)
  );

  let journal = null;
  let committed = false;
  try {
    await rmrf(pend);
    const hadLance = await exists(live);
    const hadDocs = await exists(liveDocs);
    journal = await journalLib.createJournal(jobId, {
      kind,
      slug,
      createdWorkspaceId: ctx.createdWorkspaceId ?? null,
      hadLance,
      hadDocs,
    });
    await fs.promises.mkdir(pend, { recursive: true });
    const snap = await buildSnapshotRows(prisma(), ctx.workspaceId);
    await fs.promises.writeFile(
      path.join(pend, "rows.json"),
      JSON.stringify(snap)
    );
    await fs.promises.writeFile(
      path.join(pend, "marker.json"),
      JSON.stringify(await marker.readMarker(slug))
    );
    journal = await journalLib.updateJournal(jobId, { state: "swapping" });

    const step = async (key, fn, fpName) => {
      await fn();
      journal = await journalLib.updateJournal(jobId, {
        steps: { [key]: true },
      });
      fp(fpName);
    };
    if (hadLance)
      await step("S1", () => mv(live, path.join(pend, "lance")), "after:S1");
    // A null source.lance (rollback to a state that had none) leaves live absent.
    if (source.lance)
      await step("S2", () => mv(source.lance, live), "after:S2");
    if (hadDocs)
      await step("S3", () => mv(liveDocs, path.join(pend, "docs")), "after:S3");
    await step(
      "S4",
      async () => {
        if (source.docs) await mv(source.docs, liveDocs);
        else await rmrf(liveDocs);
      },
      "after:S4"
    );

    await commitDb(ctx, cfg);
    committed = true;
    fp("after:S5");
    journal = await journalLib.updateJournal(jobId, { state: "committed" });
    fp("after:S6");
    await finishSwap(journal);
  } catch (e) {
    if (e instanceof CrashSignal) throw e;
    safeLog("error", "swap failed", {
      code: e && e.code,
      committed,
      kind,
    });
    if (committed) {
      // DB is the commit authority; recovery finishes the FS side.
      try {
        await journalLib.updateJournal(jobId, { state: "committed" });
      } catch {
        // best effort
      }
    } else if (journal) {
      try {
        await rollbackSwap(journal);
      } catch (re) {
        safeLog("error", "swap rollback failed", { code: re && re.code });
      }
    }
    if (e instanceof KnowledgeSyncError) throw e;
    throw new KnowledgeSyncError("KS_E_UNKNOWN", { phase: "swap" });
  }
}

module.exports = {
  runSwap,
  rollbackSwap,
  finishSwap,
  setFailpoint,
  CrashSignal,
  _testOnly: { pendingRoot },
};
