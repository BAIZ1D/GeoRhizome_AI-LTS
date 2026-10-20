const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const gh = require("../../../utils/knowledgeSync/github");

const base =
  require("../../../utils/knowledgeSync/config").getKnowledgeSyncConfig();
const cfg = {
  ...base,
  upload_backoff_min_ms: 1,
  upload_backoff_max_ms: 2,
  catalog_max_probe: 3,
};
const sleep = async () => {};
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const resp = (status, body = "", headers = {}) =>
  new Response(status === 204 ? null : body, { status, headers });

describe("downloadPart", () => {
  let server, port, handler, seenAuth;
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ks-dl-"));
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      handler(req, res);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => {
    seenAuth = [];
  });
  const opts = () => ({
    config: cfg,
    sleep,
    net: {
      hosts: new Set(["127.0.0.1"]),
      allowHttp: true,
      downloadBase: `http://127.0.0.1:${port}`,
    },
  });
  const data = Buffer.from("0123456789abcdef");
  const part = { name: "part-0001.bin", size: data.length, sha256: sha(data) };

  test("plain 200 download, no Authorization", async () => {
    handler = (req, res) => {
      res.writeHead(200);
      res.end(data);
    };
    const dir = tmp();
    await gh.downloadPart("t1", part, dir, opts());
    expect(fs.readFileSync(path.join(dir, part.name)).equals(data)).toBe(true);
    expect(seenAuth.every((a) => a === undefined)).toBe(true);
  });

  test("206 resume appends", async () => {
    handler = (req, res) => {
      expect(req.headers.range).toBe("bytes=4-");
      res.writeHead(206, { "Content-Range": `bytes 4-15/16` });
      res.end(data.subarray(4));
    };
    const dir = tmp();
    fs.writeFileSync(path.join(dir, part.name), data.subarray(0, 4));
    await gh.downloadPart("t1", part, dir, opts());
    expect(fs.readFileSync(path.join(dir, part.name)).equals(data)).toBe(true);
  });

  test("200 on ranged request restarts", async () => {
    handler = (req, res) => {
      res.writeHead(200);
      res.end(data);
    };
    const dir = tmp();
    fs.writeFileSync(path.join(dir, part.name), data.subarray(0, 4));
    await gh.downloadPart("t1", part, dir, opts());
    expect(fs.readFileSync(path.join(dir, part.name)).equals(data)).toBe(true);
  });

  test("hash mismatch twice -> KS_E_PART_HASH", async () => {
    let n = 0;
    handler = (req, res) => {
      n++;
      res.writeHead(200);
      res.end(Buffer.alloc(data.length, 1));
    };
    await expect(
      gh.downloadPart("t1", part, tmp(), opts())
    ).rejects.toMatchObject({ code: "KS_E_PART_HASH" });
    expect(n).toBe(2);
  });

  test("abort cancels", async () => {
    handler = (req, res) => {
      res.writeHead(200);
      res.end(data);
    };
    const ac = new AbortController();
    ac.abort();
    await expect(
      gh.downloadPart("t1", part, tmp(), { ...opts(), signal: ac.signal })
    ).rejects.toMatchObject({ code: "KS_E_CANCELLED" });
  });

  test("rejects bad part names and oversize", async () => {
    await expect(
      gh.downloadPart("t1", { ...part, name: "../x.bin" }, tmp(), opts())
    ).rejects.toMatchObject({ code: "KS_E_UNSAFE_ENTRY" });
    await expect(
      gh.downloadPart(
        "t1",
        { ...part, size: cfg.part_size_bytes + 1 },
        tmp(),
        opts()
      )
    ).rejects.toMatchObject({ code: "KS_E_SIZE_LIMIT" });
  });
});

describe("catalog", () => {
  const catFile = () => {
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ks-cat-")),
      "catalog.bin"
    );
    fs.writeFileSync(f, "cat");
    return f;
  };
  function fakeApi(initial) {
    const releases = [...initial];
    const calls = [];
    let id = 100;
    const fetchImpl = async (url, init) => {
      const u = new URL(url);
      const m = init.method;
      calls.push(`${m} ${u.pathname}`);
      if (m === "GET" && u.pathname.endsWith("/releases"))
        return resp(
          200,
          JSON.stringify(u.searchParams.get("page") === "1" ? releases : [])
        );
      if (m === "POST" && u.pathname.endsWith("/releases")) {
        const b = JSON.parse(init.body);
        const r = { id: ++id, tag_name: b.tag_name, draft: true };
        releases.push(r);
        return resp(201, JSON.stringify(r));
      }
      if (m === "POST" && u.hostname === "uploads.github.com") {
        for await (const _c of init.body) {
          /* drain */
        }
        return resp(
          201,
          JSON.stringify({ id: 1, name: u.searchParams.get("name") })
        );
      }
      if (m === "PATCH") {
        const r = releases.find((x) => u.pathname.endsWith("/" + x.id));
        r.draft = false;
        return resp(200, JSON.stringify(r));
      }
      if (m === "DELETE" && u.pathname.includes("/releases/")) {
        const i = releases.findIndex((x) => u.pathname.endsWith("/" + x.id));
        if (i >= 0) releases.splice(i, 1);
        return resp(204);
      }
      if (m === "DELETE") return resp(204);
      return resp(404);
    };
    return {
      releases,
      calls,
      client: gh.createGithubClient({
        getToken: async () => "TEST_PAT",
        config: cfg,
        fetchImpl,
        sleep,
      }),
    };
  }
  const pub = (n) => ({
    id: n,
    tag_name: "ks-catalog-" + String(n).padStart(4, "0"),
    draft: false,
  });

  test("publish from none creates 0001 draft->upload->publish", async () => {
    const { client, calls, releases } = fakeApi([]);
    const r = await client.publishCatalogRelease(catFile());
    expect(r.tag).toBe("ks-catalog-0001");
    expect(releases[0].draft).toBe(false);
    expect(
      calls.some(
        (c) => c.startsWith("DELETE /repos/") && c.includes("/assets/")
      )
    ).toBe(false);
  });

  test("from 0001+0003 creates 0004; stale draft removed first", async () => {
    const { client, calls } = fakeApi([
      pub(1),
      pub(3),
      { id: 9, tag_name: "ks-catalog-0004", draft: true },
    ]);
    const r = await client.publishCatalogRelease(catFile());
    expect(r.tag).toBe("ks-catalog-0004");
    expect(calls.findIndex((c) => c.startsWith("DELETE"))).toBeLessThan(
      calls.findIndex((c) => c.startsWith("POST /repos"))
    );
    expect(calls.some((c) => c.includes("/assets/"))).toBe(false);
  });

  test("prune deletes whole releases only", async () => {
    const { client, calls } = fakeApi([pub(1), pub(2), pub(3)]);
    expect(await client.pruneCatalogReleases(1)).toBe(2);
    expect(calls.some((c) => c.includes("/assets/"))).toBe(false);
  });

  test("fetchPublicCatalog probes from hint, tolerates gaps, github.com only", async () => {
    const urls = [];
    const have = new Set([2, 4]);
    const fetchImpl = async (url, init) => {
      urls.push(url);
      expect(init.headers.Authorization).toBeUndefined();
      const m = url.match(/ks-catalog-(\d{4})\//);
      return have.has(Number(m[1])) ? resp(200, "cat" + m[1]) : resp(404);
    };
    const r = await gh.fetchPublicCatalog({
      config: cfg,
      fetchImpl,
      startSeq: 1,
      persistHint: false,
    });
    expect(r.seq).toBe(4);
    expect(r.buffer.toString()).toBe("cat0004");
    expect(urls.every((u) => u.startsWith("https://github.com/"))).toBe(true);
    // stops after catalog_max_probe (3) misses past last hit: 5,6,7
    expect(urls.length).toBe(7);
  });

  test("fetchPublicCatalog throws KS_E_CATALOG when none", async () => {
    await expect(
      gh.fetchPublicCatalog({
        config: cfg,
        fetchImpl: async () => resp(404),
        persistHint: false,
      })
    ).rejects.toMatchObject({ code: "KS_E_CATALOG" });
  });
});
