const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { KnowledgeSyncError } = require("./errors");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `name` is a non-empty plain file name (no separators/traversal). */
function isSafeBasename(name) {
  return (
    typeof name === "string" &&
    !!name &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !name.includes("..")
  );
}

/** Returns `name` or throws KS_E_UNSAFE_ENTRY tagged with `phase`. */
function safeBasename(name, phase) {
  if (!isSafeBasename(name))
    throw new KnowledgeSyncError("KS_E_UNSAFE_ENTRY", { phase });
  return name;
}

async function sha256File(file) {
  const h = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", resolve);
  });
  return h.digest("hex");
}

async function listFiles(root, rel = "") {
  const out = [];
  for (const ent of await fs.promises.readdir(path.join(root, rel))) {
    const r = rel ? `${rel}/${ent}` : ent;
    const st = await fs.promises.lstat(path.join(root, r));
    if (st.isDirectory()) out.push(...(await listFiles(root, r)));
    else out.push(r);
  }
  return out;
}

module.exports = {
  UUID_RE,
  isSafeBasename,
  safeBasename,
  sha256File,
  listFiles,
};
