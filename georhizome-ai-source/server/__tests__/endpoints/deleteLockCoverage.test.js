/* eslint-env jest */
const mockDeleteNs = jest.fn().mockResolvedValue(true);
const mockWs = { id: 7, slug: "ws-del", name: "WS" };

jest.mock("../../models/workspace", () => ({
  Workspace: {
    get: jest.fn(async () => mockWs),
    where: jest.fn(async () => [mockWs]),
    delete: jest.fn(async () => true),
  },
}));
jest.mock("../../models/documents", () => ({
  Document: { delete: jest.fn(async () => true) },
}));
jest.mock("../../models/vectors", () => ({
  DocumentVectors: {
    deleteForWorkspace: jest.fn(async () => true),
    delete: jest.fn(async () => true),
  },
}));
jest.mock("../../models/workspaceChats", () => ({
  WorkspaceChats: { delete: jest.fn(async () => true) },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn(async () => true) },
}));
jest.mock("../../utils/files", () => ({ purgeEntireVectorCache: jest.fn() }));
jest.mock("../../utils/helpers", () => ({
  getVectorDbClass: () => ({
    "delete-namespace": mockDeleteNs,
    reset: jest.fn(async () => true),
  }),
}));

const locks = require("../../utils/knowledgeSync/locks");
const {
  resetAllVectorStores,
} = require("../../utils/vectorStore/resetAllVectorStores");
const {
  deleteWorkspaceLocked,
} = require("../../utils/knowledgeSync/deleteGuard");

afterEach(() => {
  locks._resetForTests();
  mockDeleteNs.mockClear();
});

describe("delete-namespace lock coverage (W1)", () => {
  test("resetAllVectorStores refused while export lock held; nothing deleted", async () => {
    locks.acquire("ws-del", "export");
    const ok = await resetAllVectorStores({ vectorDbKey: "lancedb" });
    expect(ok).toBe(false);
    expect(mockDeleteNs).not.toHaveBeenCalled();
    expect(locks.state("ws-del").op).toBe("export");
  });

  test("resetAllVectorStores succeeds and releases locks when free", async () => {
    const ok = await resetAllVectorStores({ vectorDbKey: "lancedb" });
    expect(ok).toBe(true);
    expect(mockDeleteNs).toHaveBeenCalledWith({ namespace: "ws-del" });
    expect(locks.heldCount()).toBe(0);
  });

  test("deleteWorkspaceLocked (admin/api delete) rejects KS_E_BUSY during export", async () => {
    locks.acquire("ws-del", "export");
    const fn = jest.fn();
    await expect(deleteWorkspaceLocked("ws-del", fn)).rejects.toMatchObject({
      code: "KS_E_BUSY",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  test("deleteWorkspaceLocked holds delete lock so export is refused meanwhile", async () => {
    let inner;
    await deleteWorkspaceLocked("ws-del", async () => {
      inner = locks.state("ws-del");
      expect(() => locks.acquire("ws-del", "export")).toThrow();
    });
    expect(inner.op).toBe("delete");
    expect(locks.state("ws-del")).toBeNull();
  });
});
