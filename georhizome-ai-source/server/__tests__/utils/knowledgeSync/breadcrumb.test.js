const mockStore = new Map();
jest.mock("../../../utils/prisma", () => ({
  system_settings: {
    upsert: async ({ where, create }) => {
      mockStore.set(where.label, create.value);
    },
    findFirst: async ({ where }) =>
      mockStore.has(where.label) ? { value: mockStore.get(where.label) } : null,
    findMany: async ({ where }) =>
      [...mockStore]
        .filter(([k]) => k.startsWith(where.label.startsWith))
        .map(([label, value]) => ({ label, value })),
  },
}));
const m = require("../../../utils/knowledgeSync/marker");

test("breadcrumb stores only whitelisted fields", async () => {
  await m.writeJobBreadcrumb("ws", {
    jobId: "j1",
    userId: 3,
    kind: "publish",
    state: "running",
    phase: "pack",
    pat: "ghp_secret",
    path: "/x/y",
  });
  const raw = JSON.parse(mockStore.get("ks_job_ws"));
  expect(Object.keys(raw).sort()).toEqual(
    ["jobId", "kind", "phase", "slug", "state", "updatedAt", "userId"].sort()
  );
  expect((await m.readJobBreadcrumb("ws")).jobId).toBe("j1");
  expect(await m.listJobBreadcrumbs()).toHaveLength(1);
  expect(await m.readJobBreadcrumb("none")).toBeNull();
});
