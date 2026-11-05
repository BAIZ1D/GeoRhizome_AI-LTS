/* eslint-env jest */
let mockMulti = false;
const mockProvider = { sparseStatus: jest.fn() };
let mockProviderObj = mockProvider;

jest.mock("../../utils/http", () => ({
  reqBody: jest.fn(),
  multiUserMode: jest.fn(() => mockMulti),
  userFromSession: jest.fn(async () => ({ id: 3, role: "default" })),
  safeJsonParse: jest.fn(),
}));
jest.mock("../../models/workspace", () => ({
  Workspace: {
    get: jest.fn(),
    getWithUser: jest.fn(),
  },
}));
jest.mock("../../utils/helpers", () => ({
  getVectorDbClass: () => mockProviderObj,
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_q, _s, n) => n && n(),
}));
jest.mock("../../utils/middleware/multiUserProtected", () => ({
  flexUserRoleValid: () => (_q, _s, n) => n && n(),
  ROLES: { all: "<all>" },
}));
jest.mock("../../utils/files", () => ({
  normalizePath: jest.fn(),
  isWithin: jest.fn(),
}));
jest.mock("../../models/documents", () => ({ Document: {} }));
jest.mock("../../models/vectors", () => ({ DocumentVectors: {} }));
jest.mock("../../models/workspaceChats", () => ({ WorkspaceChats: {} }));
jest.mock("../../models/telemetry", () => ({ Telemetry: {} }));
jest.mock("../../models/eventLogs", () => ({ EventLogs: {} }));
jest.mock("../../models/workspacesSuggestedMessages", () => ({
  WorkspaceSuggestedMessages: {},
}));
jest.mock("../../models/workspaceThread", () => ({ WorkspaceThread: {} }));
jest.mock("../../utils/files/multer", () => ({}));
jest.mock("../../utils/files/pfp", () => ({}));
jest.mock("../../utils/files/purgeDocument", () => ({}));
jest.mock("../../utils/collectorApi", () => ({ CollectorApi: class {} }));
jest.mock("../../utils/TextToSpeech", () => ({}));
jest.mock("../../utils/helpers/search", () => ({}));
jest.mock("../../utils/helpers/chat/responses", () => ({}));
jest.mock("../../utils/middleware/validWorkspace", () => ({}));
jest.mock("../../endpoints/utils", () => ({}));
jest.mock("../../endpoints/workspacesParsedFiles", () => ({
  workspaceParsedFilesEndpoints: jest.fn(),
}));

const { Workspace } = require("../../models/workspace");
const { workspaceEndpoints } = require("../../endpoints/workspaces");

const routes = {};
const app = new Proxy(
  {},
  {
    get: (_t, method) => (path, ...rest) => {
      routes[`${method} ${path}`] = rest;
    },
  }
);
workspaceEndpoints(app);

const mkRes = () => {
  const r = { statusCode: null, body: undefined };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  r.sendStatus = (c) => ((r.statusCode = c), r);
  r.end = () => r;
  return r;
};
const call = async (slug) => {
  const [mws, handler] = routes["get /workspace/:slug/sparse-status"];
  const res = mkRes();
  await handler({ params: { slug } }, res);
  return { res, mws };
};

beforeEach(() => {
  mockMulti = false;
  mockProviderObj = mockProvider;
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /workspace/:slug/sparse-status", () => {
  test("uses the same middleware chain as GET /workspace/:slug", () => {
    const a = routes["get /workspace/:slug"][0];
    const b = routes["get /workspace/:slug/sparse-status"][0];
    expect(b).toHaveLength(a.length);
    expect(a).toHaveLength(2);
  });

  test("200 with status in single-user mode", async () => {
    Workspace.get.mockResolvedValue({ slug: "w1" });
    mockProvider.sparseStatus.mockResolvedValue("partial");
    const { res } = await call("w1");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sparseStatus: "partial" });
    expect(mockProvider.sparseStatus).toHaveBeenCalledWith("w1");
  });

  test("multi-user: invisible workspace -> 400, provider never queried", async () => {
    mockMulti = true;
    Workspace.getWithUser.mockResolvedValue(null);
    const { res } = await call("secret");
    expect(res.statusCode).toBe(400);
    expect(res.body).toBeUndefined();
    expect(mockProvider.sparseStatus).not.toHaveBeenCalled();
  });

  test("multi-user: visible workspace uses getWithUser", async () => {
    mockMulti = true;
    Workspace.getWithUser.mockResolvedValue({ slug: "w1" });
    mockProvider.sparseStatus.mockResolvedValue("ready");
    const { res } = await call("w1");
    expect(res.body).toEqual({ sparseStatus: "ready" });
    expect(Workspace.get).not.toHaveBeenCalled();
  });

  test("workspace missing -> 400", async () => {
    Workspace.get.mockResolvedValue(null);
    expect((await call("nope")).res.statusCode).toBe(400);
  });

  test("provider without sparseStatus -> 200 missing", async () => {
    mockProviderObj = {};
    Workspace.get.mockResolvedValue({ slug: "w1" });
    const { res } = await call("w1");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sparseStatus: "missing" });
  });

  test("thrown error -> 500 with no body", async () => {
    Workspace.get.mockResolvedValue({ slug: "w1" });
    mockProvider.sparseStatus.mockRejectedValue(new Error("boom /secret/path"));
    const { res } = await call("w1");
    expect(res.statusCode).toBe(500);
    expect(res.body).toBeUndefined();
  });
});
