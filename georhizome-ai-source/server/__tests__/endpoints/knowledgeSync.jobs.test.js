const http = require("http");
const express = require("express");

const mockUsers = {
  admin: { id: 1, role: "admin" },
  default: { id: 3, role: "default" },
  other: { id: 4, role: "default" },
};
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    isMultiUserMode: jest.fn(async () => true),
    get: jest.fn(async () => null),
  },
}));
jest.mock("../../models/user", () => ({
  User: {
    get: jest.fn(async ({ id }) =>
      Object.values(mockUsers).find((u) => u.id === id)
    ),
  },
}));
jest.mock("../../utils/http", () => ({
  reqBody: jest.requireActual("../../utils/http").reqBody,
  decodeJWT: jest.fn((t) => ({ id: Number(t) })),
  userFromSession: jest.fn(),
}));
jest.mock("../../utils/EncryptionManager", () => ({
  EncryptionManager: class {
    encrypt(s) {
      return s;
    }
    decrypt(s) {
      return s;
    }
  },
}));
jest.mock("../../utils/knowledgeSync/exporter", () => ({}));
jest.mock("../../utils/knowledgeSync/preview", () => ({}));
jest.mock("../../utils/knowledgeSync/importer", () => ({}));
jest.mock("../../utils/knowledgeSync/stage", () => ({}));
jest.mock("../../utils/knowledgeSync/access", () => ({
  assertWorkspaceAccess: jest.fn(async () => {}),
}));
const mockSecrets = {
  getPat: jest.fn(async () => "ghp_token"),
  getPassphrase: jest.fn(async () => "pass-phrase-1"),
  passphraseStatus: jest.fn(async () => ({ configured: false })),
};
jest.mock("../../utils/knowledgeSync/secrets", () => mockSecrets);
const mockRunners = {
  publishRunner: jest.fn(),
  syncRunner: jest.fn(),
  rollbackRunner: jest.fn(),
};
jest.mock("../../utils/knowledgeSync/runners", () => mockRunners);
const mockCatalog = {
  getCatalogStatus: jest.fn(),
  refresh: jest.fn(),
  invalidate: jest.fn(),
};
jest.mock("../../utils/knowledgeSync/catalogCache", () => mockCatalog);
const mockWipe = { wipeWorkspace: jest.fn(async ({ slug }) => ({ slug })) };
jest.mock("../../utils/knowledgeSync/wipe", () => mockWipe);
jest.mock("../../utils/knowledgeSync/marker", () => ({
  writeJobBreadcrumb: jest.fn(async () => {}),
  readJobBreadcrumb: jest.fn(async () => null),
  listJobBreadcrumbs: jest.fn(async () => []),
}));

const jobsMod = require("../../utils/knowledgeSync/jobs");
const { knowledgeSyncEndpoints } = require("../../endpoints/knowledgeSync");

let server, port;
beforeAll(async () => {
  delete process.env.AUTH_TOKEN;
  delete process.env.JWT_SECRET;
  const app = express();
  app.use(express.json());
  knowledgeSyncEndpoints(app);
  await new Promise((res) => (server = app.listen(0, res)));
  port = server.address().port;
});
afterAll(() => server.close());
beforeEach(() => {
  jest.clearAllMocks();
  jobsMod._resetForTests();
  mockSecrets.getPat.mockResolvedValue("ghp_token");
  mockSecrets.getPassphrase.mockResolvedValue("pass-phrase-1");
  mockRunners.publishRunner.mockResolvedValue({});
  mockRunners.syncRunner.mockResolvedValue({});
});

const call = (method, path, token, body) =>
  new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ port, method, path, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let json = {};
        try {
          json = JSON.parse(d);
        } catch (_e) {
          /* non-json */
        }
        resolve({ status: res.statusCode, json, text: d });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
const tick = () => new Promise((r) => setTimeout(r, 30));
const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("publish", () => {
  test("admin gets 202 + jobId; passphrase passed to runner, not in job", async () => {
    const r = await call("POST", "/knowledge-sync/publish/ws-a", "1");
    expect(r.status).toBe(202);
    expect(typeof r.json.jobId).toBe("string");
    await tick();
    expect(mockRunners.publishRunner).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: "pass-phrase-1", slug: "ws-a" })
    );
    const j = await call("GET", `/knowledge-sync/jobs/${r.json.jobId}`, "1");
    expect(JSON.stringify(j.json)).not.toContain("pass-phrase-1");
  });
  test("non-admin 403", async () => {
    const r = await call("POST", "/knowledge-sync/publish/ws-a", "3");
    expect([401, 403]).toContain(r.status);
    expect(mockRunners.publishRunner).not.toHaveBeenCalled();
  });
  test("no PAT -> 400 KS_E_NO_PAT, no job", async () => {
    mockSecrets.getPat.mockResolvedValue(null);
    const spy = jest.spyOn(jobsMod, "startJob");
    const r = await call("POST", "/knowledge-sync/publish/ws-a", "1");
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("KS_E_NO_PAT");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  test("no passphrase -> KS_E_PASSPHRASE, no job", async () => {
    mockSecrets.getPassphrase.mockResolvedValue(null);
    const spy = jest.spyOn(jobsMod, "startJob");
    const r = await call("POST", "/knowledge-sync/publish/ws-a", "1");
    expect(r.json.error.code).toBe("KS_E_PASSPHRASE");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  test("bad delete-version param rejected", async () => {
    const r = await call(
      "DELETE",
      "/knowledge-sync/delete-version/ws-a/0x1",
      "1"
    );
    expect(r.status).toBe(404);
  });
});

describe("sync", () => {
  test("202 for a user", async () => {
    const r = await call("POST", "/knowledge-sync/sync/ws-a", "3");
    expect(r.status).toBe(202);
    await tick();
    expect(mockRunners.syncRunner).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: "pass-phrase-1" })
    );
  });
  test("without passphrase fails early, no job", async () => {
    mockSecrets.getPassphrase.mockResolvedValue(null);
    const r = await call("POST", "/knowledge-sync/sync/ws-a", "3");
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("KS_E_PASSPHRASE");
    expect(mockRunners.syncRunner).not.toHaveBeenCalled();
  });
});

describe("jobs", () => {
  const startHeld = async (token) => {
    let release;
    mockRunners.syncRunner.mockImplementation(
      (a) =>
        new Promise((res) => {
          a.ctx.setPhase("import");
          release = res;
        })
    );
    const r = await call("POST", "/knowledge-sync/sync/ws-h", token);
    await tick();
    return { id: r.json.jobId, release: () => release && release({}) };
  };
  test("GET job owner or admin only, includes poll interval", async () => {
    const { id, release } = await startHeld("3");
    const own = await call("GET", `/knowledge-sync/jobs/${id}`, "3");
    expect(own.status).toBe(200);
    expect(own.json.job_poll_interval_ms).toEqual(expect.any(Number));
    const other = await call("GET", `/knowledge-sync/jobs/${id}`, "4");
    expect(other.status).toBe(403);
    expect(other.json.error.code).toBe("KS_E_FORBIDDEN");
    expect((await call("GET", `/knowledge-sync/jobs/${id}`, "1")).status).toBe(
      200
    );
    release();
  });
  test("cancel during import -> 409 KS_E_SYNCING", async () => {
    const { id, release } = await startHeld("3");
    const r = await call("POST", `/knowledge-sync/jobs/${id}/cancel`, "3");
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("KS_E_SYNCING");
    release();
  });
  test("confirm is owner only", async () => {
    const { id, release } = await startHeld("3");
    const r = await call("POST", `/knowledge-sync/jobs/${id}/confirm`, "4");
    expect(r.status).toBe(403);
    release();
  });
  test("malformed jobId rejected", async () => {
    const r = await call("GET", "/knowledge-sync/jobs/not-a-uuid", "3");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("KS_E_JOB_NOT_FOUND");
  });
  test("unknown uuid 404", async () => {
    const r = await call("GET", `/knowledge-sync/jobs/${UUID}`, "3");
    expect(r.status).toBe(404);
  });
  test("workspace job re-attach carries poll interval", async () => {
    const { id, release } = await startHeld("3");
    const r = await call("GET", "/knowledge-sync/workspaces/ws-h/job", "3");
    expect(r.status).toBe(200);
    expect(r.json.job.id).toBe(id);
    expect(r.json.job_poll_interval_ms).toEqual(expect.any(Number));
    release();
  });
});

describe("catalog and wipe", () => {
  test("catalog without passphrase: configured false, no fetch", async () => {
    mockCatalog.getCatalogStatus.mockResolvedValue({
      configured: false,
      entries: [],
    });
    const r = await call("GET", "/knowledge-sync/catalog", "3");
    expect(r.status).toBe(200);
    expect(r.json.configured).toBe(false);
    expect(r.json.entries).toEqual([]);
  });
  test("wipe works for non-admin user", async () => {
    const r = await call("POST", "/knowledge-sync/wipe/ws-a", "3");
    expect(r.status).toBe(200);
    expect(mockWipe.wipeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "ws-a", userId: 3 })
    );
  });
  test("unsafe slug rejected", async () => {
    const r = await call("POST", "/knowledge-sync/wipe/..%2Fx", "3");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(mockWipe.wipeWorkspace).not.toHaveBeenCalled();
  });
});
