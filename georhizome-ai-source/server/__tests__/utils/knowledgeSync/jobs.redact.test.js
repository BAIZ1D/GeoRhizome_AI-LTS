const mockCrumbs = new Map();
jest.mock("../../../utils/knowledgeSync/marker", () => ({
  writeJobBreadcrumb: jest.fn(async (slug, rec) => {
    mockCrumbs.set(slug, JSON.stringify(rec));
  }),
  readJobBreadcrumb: jest.fn(async () => null),
  listJobBreadcrumbs: jest.fn(async () => []),
}));

const jobs = require("../../../utils/knowledgeSync/jobs");
const { registerSecret } = require("../../../utils/knowledgeSync/redact");

test("secrets in thrown errors never reach getJob or breadcrumb", async () => {
  const PASS = "fake-passphrase-123";
  registerSecret(PASS);
  const id = jobs.startJob({
    kind: "publish",
    slug: "r",
    userId: 1,
    run: async () => {
      throw new Error(`boom TEST_PAT ${PASS}`);
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  const v = await jobs.getJob(id, 1);
  expect(v.state).toBe("failed");
  const out = JSON.stringify(v) + (mockCrumbs.get("r") || "");
  expect(out).not.toContain("TEST_PAT");
  expect(out).not.toContain(PASS);
  expect(v.error.code).toBe("KS_E_UNKNOWN");
});
