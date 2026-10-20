const http = require("http");
const express = require("express");

const mockUsers = {
  admin: { id: 1, role: "admin" },
  manager: { id: 2, role: "manager" },
  default: { id: 3, role: "default" },
};
let mockMulti = false;

jest.mock("child_process", () => ({ execSync: jest.fn(), exec: jest.fn() }));
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    isMultiUserMode: jest.fn(async () => mockMulti),
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
// Side-effect-heavy modules required by system.js: stub so loading is inert.
for (const m of [
  "models/agentSkillWhitelist",
  "models/apiKeys",
  "models/browserExtensionApiKey",
  "models/documents",
  "models/eventLogs",
  "models/slashCommandsPresets",
  "models/systemPromptVariables",
  "models/telemetry",
  "models/temporaryAuthToken",
  "models/vectors",
  "models/workspaceChats",
  "utils/chats",
  "utils/collectorApi",
  "utils/files",
  "utils/files/logo",
  "utils/files/pfp",
  "utils/files/purgeDocument",
  "utils/helpers",
  "utils/helpers/chat/convertTo",
  "utils/helpers/customModels",
  "utils/helpers/updateENV",
  "utils/PasswordRecovery",
  "utils/prisma",
]) {
  jest.doMock("../../" + m, () => ({}));
}

const mockWorkspace = {
  get: jest.fn(async ({ slug }) => ({ id: 5, slug })),
  getWithUser: jest.fn(),
  new: jest.fn(),
  delete: jest.fn(),
};
jest.doMock("../../models/workspace", () => ({ Workspace: mockWorkspace }));
jest.doMock("../../utils/prisma", () => ({
  workspace_documents: { findMany: jest.fn(async () => []) },
}));
jest.doMock("../../utils/knowledgeSync/stage", () => ({
  loadStaged: jest.fn(async () => ({
    jobId: "job-1",
    meta: { ownerUserId: null },
    manifest: { versionId: "v1", workspace: { name: "WS", randomId: "r" } },
    rows: { docs: [], vectors: [] },
    stagedLance: "/x/lance",
    stagedDocs: "/x/docs",
  })),
  discardStaged: jest.fn(async () => {}),
}));
jest.doMock("../../utils/knowledgeSync/preview", () => ({
  previewImport: jest.fn(),
  validateConfirmable: jest.fn(async () => ({
    ok: true,
    blocking: [],
    target: { matched: true, workspace: { id: 5, slug: "ws-a" } },
  })),
}));
jest.doMock("../../utils/knowledgeSync/swap", () => ({
  CrashSignal: class CrashSignal extends Error {},
  runSwap: jest.fn(async () => {}),
}));

const mockMw = (_req, _res, next) => next();
jest.doMock("../../utils/middleware/chatHistoryViewable", () => ({
  chatHistoryViewable: mockMw,
}));
jest.doMock("../../utils/middleware/simpleSSOEnabled", () => ({
  simpleSSOEnabled: mockMw,
  simpleSSOLoginDisabled: mockMw,
}));
jest.doMock("../../utils/files/multer", () => ({
  handleAssetUpload: mockMw,
  handlePfpUpload: mockMw,
}));

const childProcess = require("child_process");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const {
  knowledgeSyncEndpoints,
  KS_ADMIN_GATE,
  KS_USER_GATE,
} = require("../../endpoints/knowledgeSync");
const {
  systemEndpoints,
  KS_LEGACY_SYNC_GATE,
} = require("../../endpoints/system");

let server, port;
beforeAll(async () => {
  delete process.env.AUTH_TOKEN;
  delete process.env.JWT_SECRET;
  const app = express();
  app.use(express.text());
  app.use(express.json());
  systemEndpoints(app);
  knowledgeSyncEndpoints(app);
  await new Promise((res) => (server = app.listen(0, res)));
  port = server.address().port;
});
afterAll(() => server.close());
beforeEach(() => childProcess.execSync.mockClear());

const call = (method, path, token, body = {}) =>
  new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    if (method !== "DELETE") req.write(JSON.stringify(body));
    req.end();
  });

const ADMIN_ONLY = [
  ["PUT", "/knowledge-sync/pat"],
  ["DELETE", "/knowledge-sync/pat"],
  ["POST", "/system/upload-workspace"],
];
const ANY_USER = [
  ["PUT", "/knowledge-sync/passphrase"],
  ["DELETE", "/system/workspace-vectors/abc"],
];
const denied = (s) => s === 401 || s === 403;

describe("multi-user mode", () => {
  beforeAll(() => (mockMulti = true));
  test.each(ADMIN_ONLY)("default user denied %s %s", async (m, p) => {
    expect(denied(await call(m, p, "3"))).toBe(true);
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });
  test.each(ADMIN_ONLY)("no token denied %s %s", async (m, p) => {
    expect(await call(m, p)).toBe(401);
  });
  test.each(ADMIN_ONLY)("admin passes gate %s %s", async (m, p) => {
    expect(denied(await call(m, p, "1"))).toBe(false);
  });
  test.each(ANY_USER)("default user passes %s %s", async (m, p) => {
    expect(denied(await call(m, p, "3", { passphrase: "x" }))).toBe(false);
  });
  test.each(ANY_USER)("no token denied %s %s", async (m, p) => {
    expect(await call(m, p)).toBe(401);
  });
  test("manager denied admin-only routes", async () => {
    expect(denied(await call("PUT", "/knowledge-sync/pat", "2"))).toBe(true);
  });
  test("default user may set passphrase (D-03)", async () => {
    const s = await call("PUT", "/knowledge-sync/passphrase", "3", {
      passphrase: "x",
    });
    expect(denied(s)).toBe(false);
  });
  test("legacy sync-workspace: default denied, manager/admin pass", async () => {
    expect(denied(await call("POST", "/system/sync-workspace", "3"))).toBe(
      true
    );
    expect(denied(await call("POST", "/system/sync-workspace", "2"))).toBe(
      false
    );
    expect(denied(await call("POST", "/system/sync-workspace", "1"))).toBe(
      false
    );
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });
});

describe("single-user mode", () => {
  beforeAll(() => (mockMulti = false));
  test.each([...ADMIN_ONLY, ...ANY_USER, ["POST", "/system/sync-workspace"]])(
    "reaches handler %s %s",
    async (m, p) => {
      expect(denied(await call(m, p))).toBe(false);
    }
  );
});

describe("gate wiring", () => {
  const handlesOf = (router, path, method) =>
    router.stack
      .filter(
        (l) => l.route && l.route.path === path && l.route.methods[method]
      )
      .flatMap((l) => l.route.stack.map((s) => s.handle));

  test("KS_ADMIN_GATE shape", () => {
    expect(KS_ADMIN_GATE[0]).toBe(validatedRequest);
    expect(typeof KS_ADMIN_GATE[1]).toBe("function");
    expect(KS_LEGACY_SYNC_GATE[0]).toBe(validatedRequest);
  });
  test("legacy publish uses KS_ADMIN_GATE, wipe uses KS_USER_GATE", () => {
    const app = express.Router();
    systemEndpoints(app);
    const up = handlesOf(app, "/system/upload-workspace", "post");
    expect(up).toContain(KS_ADMIN_GATE[0]);
    expect(up).toContain(KS_ADMIN_GATE[1]);
    const wipe = handlesOf(app, "/system/workspace-vectors/:slug", "delete");
    expect(wipe).toContain(KS_USER_GATE[0]);
    expect(wipe).toContain(KS_USER_GATE[1]);
    const sync = handlesOf(app, "/system/sync-workspace", "post");
    expect(sync).toContain(KS_LEGACY_SYNC_GATE[1]);
  });
  test("every sensitive /knowledge-sync route uses KS_ADMIN_GATE", () => {
    const router = express.Router();
    knowledgeSyncEndpoints(router);
    const sensitive = /\/knowledge-sync\/(pat|publish|delete-version|versions)/;
    let checked = 0;
    for (const l of router.stack) {
      if (!l.route || !sensitive.test(l.route.path)) continue;
      const h = l.route.stack.map((s) => s.handle);
      expect(h).toContain(validatedRequest);
      expect(h).toContain(KS_ADMIN_GATE[1]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
  test("Phase 6 routes: export admin gate, others user gate", () => {
    const router = express.Router();
    knowledgeSyncEndpoints(router);
    const h = (p) => handlesOf(router, p, "post");
    const exp = h("/knowledge-sync/export/:slug");
    expect(exp).toContain(KS_ADMIN_GATE[0]);
    expect(exp).toContain(KS_ADMIN_GATE[1]);
    for (const p of [
      "/knowledge-sync/import/preview",
      "/knowledge-sync/import/confirm",
      "/knowledge-sync/import/discard",
      "/knowledge-sync/rollback/:slug",
    ]) {
      const hs = h(p);
      expect(hs).toContain(KS_USER_GATE[0]);
      expect(hs).toContain(KS_USER_GATE[1]);
      expect(hs).not.toContain(KS_ADMIN_GATE[1]);
    }
  });
});

describe("W2 workspace access on confirm and rollback", () => {
  const post = (path, token, body = {}) =>
    new Promise((resolve, reject) => {
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const req = http.request(
        { port, method: "POST", path, headers },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} })
          );
        }
      );
      req.on("error", reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  const member = (ok) =>
    mockWorkspace.getWithUser.mockImplementation(async (_u, { slug }) =>
      ok ? { id: 5, slug } : null
    );
  beforeEach(() => mockWorkspace.getWithUser.mockReset());

  describe("multi-user", () => {
    beforeAll(() => (mockMulti = true));

    test("non-member rollback -> 403 KS_E_FORBIDDEN", async () => {
      member(false);
      const r = await post("/knowledge-sync/rollback/ws-a", "3");
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("KS_E_FORBIDDEN");
    });
    test("member rollback passes the access check", async () => {
      member(true);
      const r = await post("/knowledge-sync/rollback/ws-a", "3");
      expect(r.status).not.toBe(403);
      expect(mockWorkspace.getWithUser).toHaveBeenCalled();
    });
    test("admin rollback sees all workspaces", async () => {
      mockWorkspace.getWithUser.mockImplementation(async (u, { slug }) =>
        u.role === "admin" ? { id: 5, slug } : null
      );
      const r = await post("/knowledge-sync/rollback/ws-a", "1");
      expect(r.status).not.toBe(403);
    });
    test("non-member confirm into existing workspace -> 403", async () => {
      member(false);
      const r = await post("/knowledge-sync/import/confirm", "3", {
        previewId: "p1",
      });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("KS_E_FORBIDDEN");
      expect(
        require("../../utils/knowledgeSync/swap").runSwap
      ).not.toHaveBeenCalled();
    });
    test("member confirm into existing workspace OK", async () => {
      member(true);
      const r = await post("/knowledge-sync/import/confirm", "3", {
        previewId: "p1",
      });
      expect(r.status).toBe(200);
    });
  });

  describe("single-user", () => {
    beforeAll(() => (mockMulti = false));
    test("rollback and confirm never consult membership", async () => {
      const rb = await post("/knowledge-sync/rollback/ws-a");
      expect(rb.status).not.toBe(403);
      const cf = await post("/knowledge-sync/import/confirm", null, {
        previewId: "p1",
      });
      expect(cf.status).toBe(200);
      expect(mockWorkspace.getWithUser).not.toHaveBeenCalled();
    });
  });
});
