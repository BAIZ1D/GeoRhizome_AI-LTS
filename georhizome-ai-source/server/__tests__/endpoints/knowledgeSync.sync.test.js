const http = require("http");
const express = require("express");

const mockUsers = {
  admin: { id: 1, role: "admin" },
  default: { id: 3, role: "default" },
};
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    isMultiUserMode: jest.fn(async () => true),
    get: jest.fn(async () => null),
    _updateSettings: jest.fn(async () => {}),
    delete: jest.fn(async () => true),
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
jest.mock("../../utils/knowledgeSync/exporter", () => ({
  exportWorkspace: jest.fn(),
}));
jest.mock("../../utils/knowledgeSync/preview", () => ({
  previewImport: jest.fn(),
}));
jest.mock("../../utils/knowledgeSync/importer", () => ({
  confirmImport: jest.fn(),
}));
jest.mock("../../utils/knowledgeSync/rollback", () => ({
  rollbackWorkspace: jest.fn(),
}));
jest.mock("../../utils/knowledgeSync/secrets", () => ({
  getPassphrase: jest.fn(async () => "stored-pass"),
  passphraseStatus: jest.fn(),
  patStatus: jest.fn(),
}));
jest.mock("../../utils/knowledgeSync/redact", () => ({
  safeLog: jest.fn(),
  redact: (s) => s,
}));
const mockStage = { loadStaged: jest.fn(), discardStaged: jest.fn() };
jest.mock("../../utils/knowledgeSync/stage", () => mockStage);

const exporter = require("../../utils/knowledgeSync/exporter");
const previewMod = require("../../utils/knowledgeSync/preview");
const importer = require("../../utils/knowledgeSync/importer");
const rollback = require("../../utils/knowledgeSync/rollback");
const { safeLog } = require("../../utils/knowledgeSync/redact");
const { KnowledgeSyncError } = require("../../utils/knowledgeSync/errors");
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
beforeEach(() => jest.clearAllMocks());

const call = (path, token, body = {}) =>
  new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ port, method: "POST", path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({ status: res.statusCode, text: data, json: safe(data) })
      );
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
const safe = (d) => {
  try {
    return JSON.parse(d);
  } catch {
    return null;
  }
};

const UUID = "11111111-1111-4111-8111-111111111111";

describe("export gate", () => {
  test("no token 401, default user 401/403, admin 200", async () => {
    exporter.exportWorkspace.mockResolvedValue({
      archivePath: "/secret/path/ws-v1.grks",
      archiveName: "ws-v1.grks",
      versionId: 1,
      rowCount: 2,
      bytes: 10,
    });
    expect((await call("/knowledge-sync/export/ws")).status).toBe(401);
    const d = await call("/knowledge-sync/export/ws", "3");
    expect([401, 403]).toContain(d.status);
    expect(exporter.exportWorkspace).not.toHaveBeenCalled();
    const a = await call("/knowledge-sync/export/ws", "1");
    expect(a.status).toBe(200);
    expect(a.json).toEqual({
      archive: { name: "ws-v1.grks", versionId: 1, bytes: 10, rowCount: 2 },
    });
    expect(a.text).not.toContain("/secret/path");
  });
  test("unsafe slug rejected 400", async () => {
    const r = await call("/knowledge-sync/export/..%2Fx", "1");
    expect(r.status).toBe(400);
    expect(exporter.exportWorkspace).not.toHaveBeenCalled();
  });
});

describe("default user can preview/confirm/rollback", () => {
  test("preview passes body passphrase and user id; incompatible is 200", async () => {
    previewMod.previewImport.mockResolvedValue({
      previewId: UUID,
      compatibility: { ok: false, reasons: [{ code: "KS_E_DIM_MISMATCH" }] },
      blocking: ["KS_E_DIM_MISMATCH"],
    });
    const r = await call("/knowledge-sync/import/preview", "3", {
      archive: "a.grks",
      passphrase: "body-pass-xyz",
    });
    expect(r.status).toBe(200);
    expect(r.json.compatibility.ok).toBe(false);
    expect(previewMod.previewImport).toHaveBeenCalledWith({
      archiveName: "a.grks",
      passphrase: "body-pass-xyz",
      userId: 3,
    });
    expect(r.text).not.toContain("body-pass-xyz");
  });
  test("preview falls back to stored passphrase", async () => {
    previewMod.previewImport.mockResolvedValue({ previewId: UUID });
    await call("/knowledge-sync/import/preview", "3", { archive: "a.grks" });
    expect(previewMod.previewImport.mock.calls[0][0].passphrase).toBe(
      "stored-pass"
    );
  });
  test("confirm ok and confirm of incompatible preview is 400", async () => {
    importer.confirmImport.mockResolvedValueOnce({ slug: "ws" });
    const ok = await call("/knowledge-sync/import/confirm", "3", {
      previewId: UUID,
    });
    expect(ok.status).toBe(200);
    expect(importer.confirmImport.mock.calls[0][0].userId).toBe(3);
    importer.confirmImport.mockRejectedValueOnce(
      new KnowledgeSyncError("KS_E_EMBEDDER_MISMATCH")
    );
    const bad = await call("/knowledge-sync/import/confirm", "3", {
      previewId: UUID,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("KS_E_EMBEDDER_MISMATCH");
  });
  test("rollback ok", async () => {
    rollback.rollbackWorkspace.mockResolvedValue({
      slug: "ws",
      restoredVersionId: 1,
    });
    const r = await call("/knowledge-sync/rollback/ws", "3");
    expect(r.status).toBe(200);
    expect(rollback.rollbackWorkspace).toHaveBeenCalledWith({
      slug: "ws",
      userId: 3,
    });
  });
  test("discard: owner ok, other user's preview refused", async () => {
    mockStage.loadStaged.mockResolvedValue({ meta: { ownerUserId: 3 } });
    expect(
      (await call("/knowledge-sync/import/discard", "3", { previewId: UUID }))
        .status
    ).toBe(200);
    expect(mockStage.discardStaged).toHaveBeenCalledWith(UUID);
    mockStage.discardStaged.mockClear();
    mockStage.loadStaged.mockResolvedValue({ meta: { ownerUserId: 9 } });
    const r = await call("/knowledge-sync/import/discard", "3", {
      previewId: UUID,
    });
    expect(r.status).toBe(400);
    expect(mockStage.discardStaged).not.toHaveBeenCalled();
  });
});

describe("error status mapping", () => {
  test.each([
    ["KS_E_BUSY", 409],
    ["KS_E_SYNCING", 409],
    ["KS_E_NOT_FOUND", 404],
    ["KS_E_FORBIDDEN", 403],
    ["KS_E_UNKNOWN", 500],
    ["KS_E_NO_BACKUP", 400],
    ["KS_E_VERSION_STALE", 400],
    ["KS_E_PASSPHRASE", 400],
  ])("%s -> %i", async (code, status) => {
    rollback.rollbackWorkspace.mockRejectedValueOnce(
      new KnowledgeSyncError(code)
    );
    const r = await call("/knowledge-sync/rollback/ws", "3");
    expect(r.status).toBe(status);
    expect(r.json.error.code).toBe(code);
  });
  test("non-KS error becomes 500 KS_E_UNKNOWN without leaking", async () => {
    rollback.rollbackWorkspace.mockRejectedValueOnce(
      new Error("boom /etc/passwd")
    );
    const r = await call("/knowledge-sync/rollback/ws", "3");
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("passwd");
    expect(safeLog).toHaveBeenCalledWith("error", "request failed", {
      code: "KS_E_UNKNOWN",
    });
  });
});

describe("secret and path hygiene", () => {
  test("passphrase never in responses or log calls", async () => {
    previewMod.previewImport.mockRejectedValueOnce(
      new KnowledgeSyncError("KS_E_PASSPHRASE")
    );
    const r = await call("/knowledge-sync/import/preview", "3", {
      archive: "a.grks",
      passphrase: "SuperSecretPass1",
    });
    expect(r.text).not.toContain("SuperSecretPass1");
    expect(JSON.stringify(safeLog.mock.calls)).not.toContain(
      "SuperSecretPass1"
    );
  });
  test("path-like previewId and archive rejected 400", async () => {
    const real = jest.requireActual("../../utils/knowledgeSync/stage");
    importer.confirmImport.mockRejectedValueOnce(
      new KnowledgeSyncError("KS_E_PREVIEW_INVALID")
    );
    const c = await call("/knowledge-sync/import/confirm", "3", {
      previewId: "../x",
    });
    expect(c.status).toBe(400);
    mockStage.loadStaged.mockImplementationOnce(real.loadStaged);
    const d = await call("/knowledge-sync/import/discard", "3", {
      previewId: "../x",
    });
    expect(d.status).toBe(400);
    expect(mockStage.discardStaged).not.toHaveBeenCalled();
    previewMod.previewImport.mockRejectedValueOnce(
      new KnowledgeSyncError("KS_E_UNSAFE_ENTRY")
    );
    const p = await call("/knowledge-sync/import/preview", "3", {
      archive: "a/b",
    });
    expect(p.status).toBe(400);
  });
});
