/* eslint-env jest */
const { EventEmitter } = require("events");

const mockSpawn = jest.fn();
jest.mock("../../../utils/BackgroundWorkers", () => ({
  BackgroundService: class {
    get jobsRoot() {
      return "/jobs";
    }
    spawnWorker(...a) {
      return mockSpawn(...a);
    }
    async removeJob() {}
  },
}));
jest.mock("../../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: () => ({
    deleteDocumentFromNamespace: jest.fn(),
  }),
}));
jest.mock("../../../utils/prisma", () => ({}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));

const locks = require("../../../utils/knowledgeSync/locks");
const { embedFiles } = require("../../../utils/EmbeddingWorkerManager");
const { Document } = require("../../../models/documents");

function fakeWorker() {
  const w = new EventEmitter();
  w.send = jest.fn();
  return w;
}

afterEach(() => {
  locks._resetForTests();
  mockSpawn.mockReset();
});

describe("embed lock wiring", () => {
  test("acquired before spawn and held after embedFiles resolves; exit releases", async () => {
    const w = fakeWorker();
    mockSpawn.mockImplementation(async () => {
      expect(locks.state("s1")).toMatchObject({ op: "embed" });
      return { worker: w, jobId: "j" };
    });
    await embedFiles("s1", ["a"], 1, null);
    expect(locks.state("s1")).not.toBeNull();
    w.emit("exit", 0);
    expect(locks.state("s1")).toBeNull();
  });

  test("add_files to a running worker then exit leaves lock free", async () => {
    const w = fakeWorker();
    mockSpawn.mockResolvedValue({ worker: w, jobId: "j" });
    await embedFiles("s2", ["a"], 1, null);
    await embedFiles("s2", ["b"], 1, null);
    expect(w.send).toHaveBeenCalledWith({ type: "add_files", files: ["b"] });
    w.emit("exit", 0);
    expect(locks.state("s2")).toBeNull();
  });

  test("error then exit releases exactly once", async () => {
    const w = fakeWorker();
    mockSpawn.mockResolvedValue({ worker: w, jobId: "j" });
    await embedFiles("s3", ["a"], 1, null);
    w.emit("error", new Error("x"));
    expect(locks.state("s3")).toBeNull();
    w.emit("exit", 1);
    expect(locks.state("s3")).toBeNull();
  });

  test("spawn rejection releases the lock", async () => {
    mockSpawn.mockRejectedValue(new Error("spawn fail"));
    await expect(embedFiles("s4", ["a"], 1, null)).rejects.toThrow(
      "spawn fail"
    );
    expect(locks.state("s4")).toBeNull();
  });

  test("export lock held -> embedFiles rejects KS_E_BUSY, no spawn", async () => {
    locks.acquire("s5", "export");
    await expect(embedFiles("s5", ["a"], 1, null)).rejects.toMatchObject({
      code: "KS_E_BUSY",
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("import lock held -> removeDocuments rejects KS_E_BUSY", async () => {
    locks.acquire("s6", "import");
    await expect(
      Document.removeDocuments({ slug: "s6", id: 1 }, ["p"], null)
    ).rejects.toMatchObject({ code: "KS_E_BUSY" });
  });
});
