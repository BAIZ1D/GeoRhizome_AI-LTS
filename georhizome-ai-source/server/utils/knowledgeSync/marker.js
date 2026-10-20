const markerLabel = (slug) => "ks_synced_" + slug;
const exportCounterLabel = (slug) => "ks_export_ver_" + slug;

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

module.exports = {
  markerLabel,
  exportCounterLabel,
  readMarker,
  isSynced,
  writeMarker,
  deleteMarker,
  nextExportVersion,
  commitExportVersion,
};
