const { assertSafeSlug } = require("./paths");
const { newRandomId } = require("./manifest");

const RID_RE = /^[0-9a-f]{8}$/;
const label = (slug) => `ks_rid_${assertSafeSlug(slug)}`;

function settings() {
  // Lazy: models/systemSettings pulls in prisma.
  return require("../../models/systemSettings").SystemSettings;
}

async function getRandomId(slug) {
  const row = await settings().get({ label: label(slug) });
  return row && RID_RE.test(String(row.value)) ? row.value : null;
}

// D-13: created once, persisted, never regenerated.
async function getOrCreateRandomId(slug) {
  const existing = await getRandomId(slug);
  if (existing) return existing;
  const id = newRandomId();
  await settings()._updateSettings({ [label(slug)]: id });
  return id;
}

module.exports = { getOrCreateRandomId, getRandomId };
