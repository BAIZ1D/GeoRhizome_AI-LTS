const store = new Map();
jest.mock("../../../utils/prisma", () => ({
  system_settings: {
    upsert: async ({ where, create }) => {
      store.set(where.label, create.value);
    },
    findFirst: async ({ where }) =>
      store.has(where.label) ? { value: store.get(where.label) } : null,
    findMany: async ({ where }) =>
      [...store]
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
  const raw = JSON.parse(store.get("ks_job_ws"));
  expect(Object.keys(raw).sort()).toEqual(
    ["jobId", "kind", "phase", "slug", "state", "updatedAt", "userId"].sort()
  );
  expect((await m.readJobBreadcrumb("ws")).jobId).toBe("j1");
  expect(await m.listJobBreadcrumbs()).toHaveLength(1);
  expect(await m.readJobBreadcrumb("none")).toBeNull();
});
