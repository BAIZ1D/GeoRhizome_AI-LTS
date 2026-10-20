const fs = require("fs");
const path = require("path");
const { KnowledgeSyncError } = require("./errors");
const { stagingRoot, assertWithin, assertSafeSlug } = require("./paths");

const { UUID_RE } = require("./util");
const KINDS = ["import", "rollback"];
const STATES = ["prepared", "swapping", "committed", "rolled_back"];
const STEP_KEYS = ["S1", "S2", "S3", "S4"];
const KEYS = [
  "v",
  "jobId",
  "kind",
  "slug",
  "state",
  "steps",
  "hadLance",
  "hadDocs",
  "createdWorkspaceId",
  "createdAt",
];

const unsafe = () =>
  new KnowledgeSyncError("KS_E_UNSAFE_ENTRY", { phase: "journal" });

function assertJobId(jobId) {
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) throw unsafe();
  return jobId;
}
function jobDir(jobId) {
  assertJobId(jobId);
  const root = stagingRoot();
  return assertWithin(root, path.join(root, jobId));
}
function journalPath(jobId) {
  const dir = jobDir(jobId);
  return assertWithin(dir, path.join(dir, "journal.json"));
}

function validJournal(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return false;
  const ks = Object.keys(j);
  if (ks.length !== KEYS.length || !KEYS.every((k) => ks.includes(k)))
    return false;
  if (j.v !== 1 || !UUID_RE.test(j.jobId)) return false;
  if (!KINDS.includes(j.kind) || !STATES.includes(j.state)) return false;
  try {
    assertSafeSlug(j.slug);
  } catch {
    return false;
  }
  const s = j.steps;
  if (!s || typeof s !== "object") return false;
  const sk = Object.keys(s);
  if (sk.length !== STEP_KEYS.length || !STEP_KEYS.every((k) => sk.includes(k)))
    return false;
  if (!STEP_KEYS.every((k) => typeof s[k] === "boolean")) return false;
  if (typeof j.hadLance !== "boolean" || typeof j.hadDocs !== "boolean")
    return false;
  if (j.createdWorkspaceId !== null && !Number.isInteger(j.createdWorkspaceId))
    return false;
  return typeof j.createdAt === "string";
}

async function writeAtomic(jobId, journal) {
  const file = journalPath(jobId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const part = file + ".part";
  await fs.promises.writeFile(part, JSON.stringify(journal));
  await fs.promises.rename(part, file);
}

async function createJournal(
  jobId,
  { kind, slug, createdWorkspaceId = null, hadLance = false, hadDocs = false }
) {
  assertJobId(jobId);
  assertSafeSlug(slug);
  const journal = {
    v: 1,
    jobId,
    kind,
    slug,
    state: "prepared",
    steps: { S1: false, S2: false, S3: false, S4: false },
    hadLance: !!hadLance,
    hadDocs: !!hadDocs,
    createdWorkspaceId: createdWorkspaceId ?? null,
    createdAt: new Date().toISOString(),
  };
  if (!validJournal(journal)) throw unsafe();
  await writeAtomic(jobId, journal);
  return journal;
}

async function readJournal(jobId) {
  try {
    const raw = await fs.promises.readFile(journalPath(jobId), "utf-8");
    const j = JSON.parse(raw);
    return validJournal(j) && j.jobId === jobId ? j : null;
  } catch {
    return null;
  }
}

async function updateJournal(jobId, patch) {
  const cur = await readJournal(jobId);
  if (!cur) throw unsafe();
  const next = {
    ...cur,
    ...patch,
    steps: { ...cur.steps, ...(patch.steps || {}) },
  };
  if (!validJournal(next)) throw unsafe();
  await writeAtomic(jobId, next);
  return next;
}

async function listJournals() {
  const root = stagingRoot();
  let ents;
  try {
    ents = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory() || !UUID_RE.test(e.name)) continue;
    const j = await readJournal(e.name);
    if (j) out.push(j);
  }
  return out;
}

async function removeJournalDir(jobId) {
  await fs.promises.rm(jobDir(jobId), { recursive: true, force: true });
}

/** Remove only journal.json (the job dir may be a still-valid preview). */
async function removeJournalFile(jobId) {
  await fs.promises.rm(journalPath(jobId), { force: true });
}

module.exports = {
  removeJournalFile,
  createJournal,
  updateJournal,
  readJournal,
  listJournals,
  removeJournalDir,
  jobDir,
  journalPath,
};
