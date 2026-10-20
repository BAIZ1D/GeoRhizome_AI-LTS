// In-memory GitHub release store used by knowledgeSync orchestration tests.
const fs = require("fs");

function createMemGithub(prefix = "ks-catalog-") {
  const releases = [];
  const calls = [];
  const fail = {};
  let id = 100;
  const log = (n, ...a) => calls.push([n, ...a]);
  const trip = (k, v) => {
    if (fail[k] && fail[k](v)) throw Object.assign(new Error("boom " + k), {});
  };
  const find = (rid) => releases.find((r) => r.id === rid);

  const client = {
    async listReleasesByTagPrefix(p) {
      return releases
        .filter((r) => r.tag_name.startsWith(p))
        .map((r) => ({ id: r.id, tag_name: r.tag_name, draft: r.draft }));
    },
    async createDraftRelease({ tag }) {
      log("createDraft", tag);
      trip("createDraft", tag);
      const r = { id: ++id, tag_name: tag, draft: true, assets: new Map() };
      releases.push(r);
      return { id: r.id, tag_name: tag };
    },
    async uploadAsset(rid, name, file, { onBytes } = {}) {
      log("upload", name);
      trip("upload", name);
      const buf = await fs.promises.readFile(file);
      if (onBytes) onBytes(buf.length);
      find(rid).assets.set(name, buf);
      return {};
    },
    async publishRelease(rid) {
      log("publish", find(rid).tag_name);
      trip("publish", find(rid).tag_name);
      find(rid).draft = false;
      return {};
    },
    async deleteRelease(rid) {
      log("deleteRelease", find(rid) && find(rid).tag_name);
      const i = releases.findIndex((r) => r.id === rid);
      if (i >= 0) releases.splice(i, 1);
    },
    async deleteTag(tag) {
      log("deleteTag", tag);
      trip("deleteTag", tag);
    },
    async getReleaseByTag(tag) {
      const r = releases.find((x) => x.tag_name === tag);
      return r ? { id: r.id, tag_name: r.tag_name, draft: r.draft } : null;
    },
    async publishCatalogRelease(file) {
      log("publishCatalog");
      trip("publishCatalog");
      for (const r of releases.filter(
        (x) => x.tag_name.startsWith(prefix) && x.draft
      )) {
        await client.deleteRelease(r.id);
      }
      let max = 0;
      for (const r of releases.filter(
        (x) => x.tag_name.startsWith(prefix) && !x.draft
      ))
        max = Math.max(max, Number(r.tag_name.slice(prefix.length)));
      const tag = prefix + String(max + 1).padStart(4, "0");
      const rel = await client.createDraftRelease({ tag });
      await client.uploadAsset(rel.id, "catalog.bin", file);
      await client.publishRelease(rel.id);
      return { tag, seq: max + 1 };
    },
  };

  // Token-free github.com download responses (published releases only).
  const fetchImpl = async (url, init) => {
    if (init && init.headers && init.headers.Authorization)
      throw new Error("token leaked to download");
    const m = String(url).match(/\/releases\/download\/([^/]+)\/([^/]+)$/);
    const r = m && releases.find((x) => x.tag_name === m[1] && !x.draft);
    const buf = r && r.assets.get(m[2]);
    if (!buf) return new Response("nf", { status: 404 });
    return new Response(buf, { status: 200 });
  };

  return { client, releases, calls, fail, fetchImpl };
}

module.exports = { createMemGithub };
