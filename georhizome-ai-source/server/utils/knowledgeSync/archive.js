const fs = require("fs");
const path = require("path");
const tar = require("tar");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const { stagingRoot, assertWithin } = require("./paths");

const DEFAULT_ALLOWED_PREFIXES = Object.freeze([
  "manifest.enc",
  "lancedb",
  "documents",
  "db",
]);
const OK_TYPES = new Set(["File", "OldFile", "Directory"]);

const unsafe = (phase) =>
  new KnowledgeSyncError("KS_E_UNSAFE_ENTRY", { phase });

function checkEntryPath(p, allowedPrefixes) {
  if (typeof p !== "string" || p.length === 0) throw unsafe("entry");
  if (p.includes("\\") || p.includes("\0")) throw unsafe("entry");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw unsafe("entry");
  const norm = path.posix.normalize(p);
  const segs = p.split("/");
  if (
    segs.includes("..") ||
    norm.startsWith("..") ||
    path.posix.isAbsolute(norm)
  )
    throw unsafe("entry");
  const top = norm.split("/").filter((s) => s && s !== ".")[0];
  if (!top || !allowedPrefixes.includes(top)) throw unsafe("entry");
}

// Regular files and directories only; never follows symlinks (SEC-03).
async function packDirectory(srcDir, outFile, entries) {
  const cwd = path.resolve(srcDir);
  const list = entries && entries.length ? entries : ["."];
  await tar.c(
    {
      cwd,
      file: path.resolve(outFile),
      portable: true,
      follow: false,
      filter: (_p, stat) => stat.isFile() || stat.isDirectory(),
    },
    list
  );
  return path.resolve(outFile);
}

async function walkAssert(root, dir) {
  for (const ent of await fs.promises.readdir(dir)) {
    const p = path.join(dir, ent);
    assertWithin(root, p);
    const st = await fs.promises.lstat(p);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()))
      throw unsafe("post-extract");
    if (st.isDirectory()) await walkAssert(root, p);
  }
}

async function extractArchive(file, stagingDir, opts = {}) {
  const {
    allowedPrefixes = DEFAULT_ALLOWED_PREFIXES,
    enforceStagingRoot = true,
  } = opts;
  const cfg = opts.config || getKnowledgeSyncConfig();
  const dest = path.resolve(stagingDir);
  if (enforceStagingRoot) assertWithin(stagingRoot({ config: cfg }), dest);

  try {
    // Pass 1: list and validate every entry before touching disk.
    let count = 0;
    let total = 0;
    let violation = null;
    await tar.t({
      file: path.resolve(file),
      onReadEntry: (entry) => {
        if (violation) return;
        try {
          count += 1;
          total += entry.size || 0;
          if (!OK_TYPES.has(entry.type)) throw unsafe("type");
          checkEntryPath(entry.path, allowedPrefixes);
          if (cfg.max_entries && count > cfg.max_entries)
            throw unsafe("max_entries");
          if (cfg.max_extract_bytes && total > cfg.max_extract_bytes)
            throw unsafe("max_extract_bytes");
        } catch (e) {
          violation = e;
        }
      },
    });
    if (violation) throw violation;

    await fs.promises.mkdir(dest, { recursive: true });
    let warned = null;
    await tar.x({
      file: path.resolve(file),
      cwd: dest,
      preservePaths: false,
      strict: true,
      filter: (p, entry) => {
        if (entry && !OK_TYPES.has(entry.type)) return false;
        try {
          checkEntryPath(p, allowedPrefixes);
        } catch (_e) {
          return false;
        }
        return true;
      },
      onwarn: (_code, _msg) => {
        warned = unsafe("warn");
      },
    });
    if (warned) throw warned;
    await walkAssert(dest, dest);
    return dest;
  } catch (err) {
    await fs.promises.rm(dest, { recursive: true, force: true });
    if (err instanceof KnowledgeSyncError) throw err;
    throw unsafe("extract");
  }
}

module.exports = { packDirectory, extractArchive, DEFAULT_ALLOWED_PREFIXES };
