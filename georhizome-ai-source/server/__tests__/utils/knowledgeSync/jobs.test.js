const mockCrumbs = new Map();
jest.mock("../../../utils/knowledgeSync/marker", () => ({
  writeJobBreadcrumb: jest.fn(async (slug, rec) => {
    mockCrumbs.set(slug, { ...rec, slug });
  }),
  readJobBreadcrumb: jest.fn(async (slug) => mockCrumbs.get(slug) || null),
  listJobBreadcrumbs: jest.fn(async () => [...mockCrumbs.values()]),
}));

const jobs = require("../../../utils/knowledgeSync/jobs");

const tick = () => new Promise((r) => setTimeout(r, 5));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  jobs._resetForTests();
  mockCrumbs.clear();
});

test("returns id before run executes", async () => {
  const run = jest.fn(async () => {});
  const id = jobs.startJob({ kind: "publish", slug: "a", userId: 1, run });
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(run).not.toHaveBeenCalled();
  await tick();
  expect(run).toHaveBeenCalled();
  expect((await jobs.getJob(id, 1)).state).toBe("succeeded");
});

test("BUSY on same slug, parallel on different slugs", async () => {
  const d = deferred();
  jobs.startJob({ kind: "publish", slug: "a", userId: 1, run: () => d.promise });
  expect(() =>
    jobs.startJob({ kind: "sync", slug: "a", userId: 1, run: async () => {} })
  ).toThrow(expect.objectContaining({ code: "KS_E_BUSY" }));
  const id2 = jobs.startJob({
    kind: "publish",
    slug: "b",
    userId: 1,
    run: () => d.promise,
  });
  expect(id2).toBeTruthy();
  d.resolve();
  await tick();
  // slot released
  expect(
    jobs.startJob({ kind: "sync", slug: "a", userId: 1, run: async () => {} })
  ).toBeTruthy();
});

test("cancel allowed in download, refused in import", async () => {
  const d = deferred();
  const id = jobs.startJob({
    kind: "sync",
    slug: "a",
    userId: 1,
    run: async (ctx) => {
      ctx.setPhase("download");
      await d.promise;
      ctx.throwIfCancelled();
      ctx.setPhase("import");
      await new Promise(() => {});
    },
  });
  await tick();
  expect(jobs.requestCancel(id, 1).phase).toBe("download");
  d.resolve();
  await tick();
  const v = await jobs.getJob(id, 1);
  expect(v.state).toBe("cancelled");
  expect(v.error.code).toBe("KS_E_CANCELLED");

  const id2 = jobs.startJob({
    kind: "sync",
    slug: "b",
    userId: 1,
    run: async (ctx) => {
      ctx.setPhase("import");
      await new Promise(() => {});
    },
  });
  await tick();
  expect(() => jobs.requestCancel(id2, 1)).toThrow(
    expect.objectContaining({ code: "KS_E_SYNCING" })
  );
});

test("owner-only access; admin may read; confirm owner-only", async () => {
  const id = jobs.startJob({
    kind: "sync",
    slug: "a",
    userId: 1,
    run: async (ctx) => {
      ctx.setPhase("preview");
      ctx.setPreview({ ok: true });
      await ctx.awaitConfirm();
      ctx.setPhase("import");
    },
  });
  await tick();
  expect((await jobs.getJob(id, 1)).state).toBe("awaiting_confirm");
  await expect(jobs.getJob(id, 2)).rejects.toMatchObject({
    code: "KS_E_FORBIDDEN",
  });
  expect((await jobs.getJob(id, 2, true)).preview).toEqual({ ok: true });
  expect(() => jobs.confirmJob(id, 2)).toThrow(
    expect.objectContaining({ code: "KS_E_FORBIDDEN" })
  );
  jobs.confirmJob(id, 1);
  await tick();
  expect((await jobs.getJob(id, 1)).state).toBe("succeeded");
});

test("interrupted fallback via breadcrumb with owner/admin enforcement", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  mockCrumbs.set("zz", {
    jobId: id,
    userId: 7,
    slug: "zz",
    kind: "publish",
    state: "running",
    phase: "upload",
  });
  const v = await jobs.getJob(id, 7);
  expect(v.state).toBe("interrupted");
  expect(v.error.code).toBe("KS_E_INTERRUPTED");
  await expect(jobs.getJob(id, 8)).rejects.toMatchObject({
    code: "KS_E_FORBIDDEN",
  });
  expect((await jobs.getJob(id, 8, true)).state).toBe("interrupted");
  await expect(
    jobs.getJob("22222222-2222-4222-8222-222222222222", 7)
  ).rejects.toMatchObject({ code: "KS_E_JOB_NOT_FOUND" });
});
