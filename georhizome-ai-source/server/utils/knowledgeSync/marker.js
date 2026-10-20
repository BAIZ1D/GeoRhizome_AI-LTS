const markerLabel = (slug) => "ks_synced_" + slug;
const commitTokenLabel = (jobId) => "ks_commit_" + jobId;
const exportCounterLabel = (slug) => "ks_export_ver_" + slug;

const jobLabel = (slug) => "ks_job_" + slug;
const JOB_FIELDS = [
  "jobId",
  "userId",
  "slug",
  "kind",
  "state",
  "phase",
  "updatedAt",
];

const db = () => require("../prisma");

async function readMarker(slug, client) {
  const c = client || db();
  const row = await c.system_settings.findFirst({
    where: { label: markerLabel(slug) },
  });
  if (!row || !row.value) return null;
  try {
    const v = JSON.parse(row.value);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

async function isSynced(slug) {
  return (await readMarker(slug)) !== null;
}

async function writeMarker(tx, slug, value) {
  const label = markerLabel(slug);
  const data = JSON.stringify({
    ...value,
    syncedAt: value.syncedAt || new Date().toISOString(),
  });
  await tx.system_settings.upsert({
    where: { label },
    update: { value: data },
    create: { label, value: data },
  });
}

async function deleteMarker(tx, slug) {
  await tx.system_settings.deleteMany({ where: { label: markerLabel(slug) } });
}

/** Written in the same DB transaction as the swap rows: recovery authority. */
async function writeCommitToken(tx, jobId) {
  const label = commitTokenLabel(jobId);
  const value = new Date().toISOString();
  await tx.system_settings.upsert({
    where: { label },
    update: { value },
    create: { label, value },
  });
}

async function hasCommitToken(jobId, client) {
  const row = await (client || db()).system_settings.findFirst({
    where: { label: commitTokenLabel(jobId) },
  });
  return !!row;
}

async function deleteCommitToken(jobId, client) {
  await (client || db()).system_settings.deleteMany({
    where: { label: commitTokenLabel(jobId) },
  });
}

async function nextExportVersion(slug) {
  const row = await db().system_settings.findFirst({
    where: { label: exportCounterLabel(slug) },
  });
  const n = Number(row?.value);
  return (Number.isSafeInteger(n) && n > 0 ? n : 0) + 1;
}

async function commitExportVersion(slug, n) {
  const label = exportCounterLabel(slug);
  await db().system_settings.upsert({
    where: { label },
    update: { value: String(n) },
    create: { label, value: String(n) },
  });
}

/** Persists only the whitelisted job fields; anything else is stripped. */
async function writeJobBreadcrumb(slug, rec) {
  const clean = {};
  for (const k of JOB_FIELDS)
    if (rec && rec[k] !== undefined) clean[k] = rec[k];
  clean.slug = slug;
  clean.updatedAt = clean.updatedAt || new Date().toISOString();
  const label = jobLabel(slug);
  const value = JSON.stringify(clean);
  await db().system_settings.upsert({
    where: { label },
    update: { value },
    create: { label, value },
  });
  return clean;
}

function parseJob(row) {
  if (!row || !row.value) return null;
  try {
    const v = JSON.parse(row.value);
    if (!v || typeof v !== "object") return null;
    const out = {};
    for (const k of JOB_FIELDS) if (v[k] !== undefined) out[k] = v[k];
    return out;
  } catch {
    return null;
  }
}

async function readJobBreadcrumb(slug) {
  return parseJob(
    await db().system_settings.findFirst({ where: { label: jobLabel(slug) } })
  );
}

async function listJobBreadcrumbs() {
  const rows = await db().system_settings.findMany({
    where: { label: { startsWith: "ks_job_" } },
  });
  return rows.map(parseJob).filter(Boolean);
}

module.exports = {
  jobLabel,
  writeJobBreadcrumb,
  readJobBreadcrumb,
  listJobBreadcrumbs,
  markerLabel,
  exportCounterLabel,
  commitTokenLabel,
  writeCommitToken,
  hasCommitToken,
  deleteCommitToken,
  readMarker,
  isSynced,
  writeMarker,
  deleteMarker,
  nextExportVersion,
  commitExportVersion,
};
