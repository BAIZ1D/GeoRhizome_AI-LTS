const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { getKnowledgeSyncConfig } = require("./config");
const { KnowledgeSyncError } = require("./errors");
const { redact, registerSecret } = require("./redact");
const { sha256File } = require("./util");
const { PART_RE } = require("./publicIndex");
const { withRetry } = require("./transport");
const paths = require("./paths");

const API_HOSTS = new Set(["api.github.com", "uploads.github.com"]);
const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "uploads.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const CATALOG_ASSET = "catalog.bin";

const unsafe = (phase) =>
  new KnowledgeSyncError("KS_E_UNSAFE_ENTRY", { phase });

function httpError(res) {
  const e = new Error(`HTTP ${res.status}`);
  e.status = res.status;
  e.headers = res.headers;
  return e;
}

// Maps raw failures to client-safe KnowledgeSyncError (never leaks token).
function mapErr(e) {
  if (e instanceof KnowledgeSyncError) return e;
  if (e && e.status === 401) return new KnowledgeSyncError("KS_E_PAT_INVALID");
  if (e && e.name === "AbortError")
    return new KnowledgeSyncError("KS_E_CANCELLED");
  return new KnowledgeSyncError("KS_E_GITHUB", {
    phase: redact(String((e && e.status) || "network")),
  });
}

function withTimeout(signal, ms) {
  if (!ms) return { signal, done() {} };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ac.signal,
    done() {
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Redirect-safe fetch. Credentials are attached only on the first hop and only
 * when its host is api.github.com / uploads.github.com (XFER-05).
 * `net` is a test-only injected override ({hosts, allowHttp}).
 */
async function request(url, o = {}) {
  const cfg = o.config || getKnowledgeSyncConfig();
  const doFetch = o.fetchImpl || fetch;
  const hosts = o.net && o.net.hosts ? o.net.hosts : ALLOWED_HOSTS;
  const allowHttp = !!(o.net && o.net.allowHttp);
  const method = o.method || "GET";
  let cur = url;
  for (let hop = 0; hop <= cfg.max_redirect_hops; hop++) {
    const u = new URL(cur);
    if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:"))
      throw unsafe("scheme");
    if (!hosts.has(u.hostname)) throw unsafe("host");
    const headers = { ...(o.headers || {}) };
    if (hop === 0 && o.token && API_HOSTS.has(u.hostname))
      headers["Authorization"] = `Bearer ${o.token}`;
    const init = { method, headers, redirect: "manual", signal: o.signal };
    if (o.body !== undefined) {
      init.body = o.body;
      if (o.duplex) init.duplex = o.duplex;
    }
    const res = await doFetch(cur, init);
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (method !== "GET" && method !== "HEAD") throw httpError(res);
      if (res.body && typeof res.body.cancel === "function")
        await res.body.cancel().catch(() => {});
      cur = new URL(res.headers.get("location"), cur).toString();
      continue;
    }
    return res;
  }
  throw unsafe("redirects");
}

function repoOf(cfg) {
  return cfg.repo;
}
function downloadUrl(cfg, tag, asset, net) {
  if (!NAME_RE.test(String(tag)) || !NAME_RE.test(String(asset)))
    throw unsafe("name");
  const base = (net && net.downloadBase) || "https://github.com";
  return `${base}/${repoOf(cfg)}/releases/download/${tag}/${asset}`;
}

async function readCapped(res, maxBytes) {
  const chunks = [];
  let n = 0;
  for await (const c of Readable.fromWeb(res.body)) {
    n += c.length;
    if (n > maxBytes) throw new KnowledgeSyncError("KS_E_SIZE_LIMIT");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ---------- token-free reads (XFER-04, D-15) ----------

async function fetchPublicAsset(tag, assetName, o = {}) {
  const cfg = o.config || getKnowledgeSyncConfig();
  const cap = o.maxBytes || cfg.max_extract_bytes;
  const url = downloadUrl(cfg, tag, assetName, o.net);
  try {
    return await withRetry(
      async () => {
        const t = withTimeout(o.signal, cfg.github_api_timeout_ms);
        try {
          const res = await request(url, {
            ...o,
            config: cfg,
            signal: t.signal,
          });
          if (!res.ok) throw httpError(res);
          return await readCapped(res, cap);
        } finally {
          t.done();
        }
      },
      {
        attempts: cfg.download_attempts,
        minMs: cfg.upload_backoff_min_ms,
        maxMs: cfg.upload_backoff_max_ms,
        signal: o.signal,
        sleep: o.sleep,
      }
    );
  } catch (e) {
    throw mapErr(e);
  }
}

function readCatalogSeqHint(opts) {
  try {
    const j = JSON.parse(
      fs.readFileSync(paths.catalogSeqHintPath(opts), "utf8")
    );
    return Number.isInteger(j.seq) && j.seq >= 1 ? j.seq : 1;
  } catch {
    return 1;
  }
}
function writeCatalogSeqHint(seq, opts) {
  const p = paths.catalogSeqHintPath(opts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ seq }));
  fs.renameSync(tmp, p);
}

const pad4 = (n) => String(n).padStart(4, "0");

async function probeCatalog(startSeq, o, cfg) {
  let seq = startSeq;
  let misses = 0;
  let best = null;
  while (misses < cfg.catalog_max_probe) {
    const url = downloadUrl(
      cfg,
      cfg.catalog_tag_prefix + pad4(seq),
      CATALOG_ASSET,
      o.net
    );
    const t = withTimeout(o.signal, cfg.github_api_timeout_ms);
    try {
      const res = await request(url, { ...o, config: cfg, signal: t.signal });
      if (res.status === 200) {
        best = {
          seq,
          buffer: await readCapped(res, o.maxBytes || cfg.max_extract_bytes),
        };
        misses = 0;
      } else if (res.status === 404) {
        misses++;
        if (res.body && res.body.cancel)
          await res.body.cancel().catch(() => {});
      } else throw httpError(res);
    } finally {
      t.done();
    }
    seq++;
  }
  return best;
}

async function fetchPublicCatalog(o = {}) {
  const cfg = o.config || getKnowledgeSyncConfig();
  const start =
    Number.isInteger(o.startSeq) && o.startSeq >= 1 ? o.startSeq : 1;
  try {
    let found = await probeCatalog(start, o, cfg);
    if (!found && start > 1) found = await probeCatalog(1, o, cfg);
    if (!found) throw new KnowledgeSyncError("KS_E_CATALOG");
    if (o.persistHint !== false) {
      try {
        writeCatalogSeqHint(found.seq, o.pathOpts);
      } catch {
        /* hint is best-effort */
      }
    }
    return found;
  } catch (e) {
    throw mapErr(e);
  }
}

async function downloadPart(tag, part, destDir, o = {}) {
  const cfg = o.config || getKnowledgeSyncConfig();
  if (!part || !PART_RE.test(String(part.name))) throw unsafe("part");
  const cap = Math.min(cfg.part_size_bytes, o.maxBytes || cfg.part_size_bytes);
  if (!Number.isInteger(part.size) || part.size < 0 || part.size > cap)
    throw new KnowledgeSyncError("KS_E_SIZE_LIMIT");
  const dest = paths.assertWithin(destDir, path.join(destDir, part.name));
  const url = downloadUrl(cfg, tag, part.name, o.net);
  await fs.promises.mkdir(destDir, { recursive: true });
  const size = async () => {
    try {
      return (await fs.promises.stat(dest)).size;
    } catch {
      return 0;
    }
  };
  const attempt = async () => {
    let have = await size();
    if (have > part.size) {
      await fs.promises.rm(dest, { force: true });
      have = 0;
    }
    if (have === part.size) return;
    {
      const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
      const res = await request(url, {
        ...o,
        config: cfg,
        headers,
        signal: o.signal,
      });
      let flags = "w";
      if (res.status === 206) {
        const m = String(res.headers.get("content-range") || "").match(
          /^bytes (\d+)-/
        );
        if (!m || Number(m[1]) !== have) {
          await fs.promises.rm(dest, { force: true });
          throw Object.assign(new Error("range"), { retryable: true });
        }
        flags = "a";
      } else if (res.status === 416) {
        await fs.promises.rm(dest, { force: true });
        throw Object.assign(new Error("range"), { retryable: true });
      } else if (res.status !== 200) throw httpError(res);
      let got = flags === "a" ? have : 0;
      const src = Readable.fromWeb(res.body);
      src.on("data", (c) => {
        got += c.length;
        if (got > part.size)
          src.destroy(new KnowledgeSyncError("KS_E_SIZE_LIMIT"));
        if (o.onBytes) o.onBytes(c.length);
      });
      await pipeline(src, fs.createWriteStream(dest, { flags }));
    }
  };
  const retryOpts = {
    attempts: cfg.download_attempts,
    minMs: cfg.upload_backoff_min_ms,
    maxMs: cfg.upload_backoff_max_ms,
    signal: o.signal,
    sleep: o.sleep,
  };
  try {
    for (let restart = 0; restart < 2; restart++) {
      await withRetry(attempt, retryOpts);
      if (
        (await size()) === part.size &&
        (await sha256File(dest)) === part.sha256
      )
        return dest;
      await fs.promises.rm(dest, { force: true });
    }
  } catch (e) {
    throw mapErr(e);
  }
  throw new KnowledgeSyncError("KS_E_PART_HASH", { phase: "download" });
}

// ---------- authenticated client ----------

function createGithubClient({ getToken, config, fetchImpl, sleep, net } = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const tokenFn = getToken || require("./secrets").getPat;
  const apiBase = (net && net.apiBase) || "https://api.github.com";
  const uploadBase = (net && net.uploadBase) || "https://uploads.github.com";
  const repo = repoOf(cfg);
  const retryOf = (signal) => ({
    attempts: cfg.upload_attempts,
    minMs: cfg.upload_backoff_min_ms,
    maxMs: cfg.upload_backoff_max_ms,
    signal,
    sleep,
  });

  async function token() {
    const t = await tokenFn();
    if (!t) throw new KnowledgeSyncError("KS_E_NO_PAT");
    registerSecret(t);
    return t;
  }

  async function api(method, pathname, { json, signal, okStatuses = [] } = {}) {
    const tok = await token();
    try {
      return await withRetry(async () => {
        const t = withTimeout(signal, cfg.github_api_timeout_ms);
        try {
          const res = await request(`${apiBase}${pathname}`, {
            method,
            token: tok,
            config: cfg,
            fetchImpl,
            net,
            signal: t.signal,
            headers: {
              Accept: "application/vnd.github+json",
              ...(json !== undefined
                ? { "Content-Type": "application/json" }
                : {}),
            },
            body: json !== undefined ? JSON.stringify(json) : undefined,
          });
          if (okStatuses.includes(res.status))
            return { status: res.status, data: null };
          if (!res.ok) throw httpError(res);
          const text = res.status === 204 ? "" : await res.text();
          return { status: res.status, data: text ? JSON.parse(text) : null };
        } finally {
          t.done();
        }
      }, retryOf(signal));
    } catch (e) {
      throw mapErr(e);
    }
  }

  async function listReleases({ signal } = {}) {
    const out = [];
    for (let page = 1; ; page++) {
      const { data } = await api(
        "GET",
        `/repos/${repo}/releases?per_page=${cfg.release_list_per_page}&page=${page}`,
        { signal }
      );
      out.push(...data);
      if (data.length < cfg.release_list_per_page) return out;
    }
  }
  const listReleasesByTagPrefix = async (prefix, o) =>
    (await listReleases(o)).filter((r) =>
      String(r.tag_name).startsWith(prefix)
    );
  const createDraftRelease = async ({ tag, name, body }, o = {}) =>
    (
      await api("POST", `/repos/${repo}/releases`, {
        json: {
          tag_name: tag,
          name: name || tag,
          body: body || "",
          draft: true,
        },
        signal: o.signal,
      })
    ).data;
  const getReleaseByTag = async (tag, o = {}) => {
    const r = await api(
      "GET",
      `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      {
        signal: o.signal,
        okStatuses: [404],
      }
    );
    return r.data;
  };
  const listAssets = async (releaseId, o = {}) =>
    (
      await api(
        "GET",
        `/repos/${repo}/releases/${releaseId}/assets?per_page=${cfg.release_list_per_page}`,
        o
      )
    ).data;
  // Only ever invoked on DRAFT releases (published ones are immutable).
  const deleteAsset = (assetId, o = {}) =>
    api("DELETE", `/repos/${repo}/releases/assets/${assetId}`, o);
  const publishRelease = async (releaseId, o = {}) =>
    (
      await api("PATCH", `/repos/${repo}/releases/${releaseId}`, {
        json: { draft: false },
        signal: o.signal,
      })
    ).data;
  const deleteRelease = (releaseId, o = {}) =>
    api("DELETE", `/repos/${repo}/releases/${releaseId}`, {
      ...o,
      okStatuses: [404],
    });
  const deleteTag = (tag, o = {}) =>
    api("DELETE", `/repos/${repo}/git/refs/tags/${encodeURIComponent(tag)}`, {
      ...o,
      okStatuses: [404, 422],
    });

  async function uploadAsset(
    releaseId,
    name,
    filePath,
    { signal, onBytes } = {}
  ) {
    if (!NAME_RE.test(String(name))) throw unsafe("name");
    const tok = await token();
    const { size } = await fs.promises.stat(filePath);
    const once = async () => {
      const rs = fs.createReadStream(filePath);
      if (onBytes) rs.on("data", (c) => onBytes(c.length));
      const res = await request(
        `${uploadBase}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          token: tok,
          config: cfg,
          fetchImpl,
          net,
          signal,
          duplex: "half",
          headers: {
            Accept: "application/vnd.github+json",
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
          },
          body: Readable.toWeb(rs),
        }
      );
      if (!res.ok) throw httpError(res);
      return JSON.parse(await res.text());
    };
    try {
      return await withRetry(async () => {
        try {
          return await once();
        } catch (e) {
          if (!e || e.status !== 422) throw e;
          const existing = (await listAssets(releaseId, { signal })).find(
            (a) => a.name === name
          );
          if (!existing) throw e;
          await deleteAsset(existing.id, { signal });
          return await once();
        }
      }, retryOf(signal));
    } catch (e) {
      throw mapErr(e);
    }
  }

  async function publishCatalogRelease(catalogPath, { signal } = {}) {
    const prefix = cfg.catalog_tag_prefix;
    const all = await listReleasesByTagPrefix(prefix, { signal });
    for (const r of all.filter((x) => x.draft === true)) {
      await deleteRelease(r.id, { signal });
      await deleteTag(r.tag_name, { signal });
    }
    let max = 0;
    for (const r of all.filter((x) => x.draft !== true)) {
      const n = Number(String(r.tag_name).slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    const seq = max + 1;
    const tag = prefix + pad4(seq);
    const rel = await createDraftRelease({ tag, name: tag }, { signal });
    await uploadAsset(rel.id, CATALOG_ASSET, catalogPath, { signal });
    await publishRelease(rel.id, { signal });
    return { tag, seq };
  }

  // Prunes whole older catalog releases, never individual assets.
  async function pruneCatalogReleases(keep, { signal } = {}) {
    const prefix = cfg.catalog_tag_prefix;
    const pub = (await listReleasesByTagPrefix(prefix, { signal }))
      .filter((r) => r.draft !== true)
      .sort((a, b) => String(a.tag_name).localeCompare(String(b.tag_name)));
    const drop = pub.slice(0, Math.max(0, pub.length - keep));
    for (const r of drop) {
      await deleteRelease(r.id, { signal });
      await deleteTag(r.tag_name, { signal });
    }
    return drop.length;
  }

  return {
    listReleases,
    listReleasesByTagPrefix,
    createDraftRelease,
    getReleaseByTag,
    listAssets,
    deleteAsset,
    uploadAsset,
    publishRelease,
    deleteRelease,
    deleteTag,
    publishCatalogRelease,
    pruneCatalogReleases,
  };
}

module.exports = {
  request,
  createGithubClient,
  fetchPublicAsset,
  fetchPublicCatalog,
  downloadPart,
  readCatalogSeqHint,
  writeCatalogSeqHint,
  ALLOWED_HOSTS,
};
