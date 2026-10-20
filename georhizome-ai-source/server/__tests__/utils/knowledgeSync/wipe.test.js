const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ks-wipe-"));
process.env.NODE_ENV = "test";

const mockWs = { id: 5, slug: "wsx", name: "keep me", openAiPrompt: "chat" };
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    get: jest.fn(async ({ slug }) => (slug === "wsx" ? { ...mockWs } : null)),
    getWithUser: jest.fn(async (user, { slug }) =>
      user && user.id === 1 && slug === "wsx" ? { ...mockWs } : null
    ),
  },
}));
jest.mock(
  "../../../utils/prisma",
  () => require("../../../__testhelpers__/memdb").db
);

const memdb = require("../../../__testhelpers__/memdb");
const marker = require("../../../utils/knowledgeSync/marker");
const locks = require("../../../utils/knowledgeSync/locks");
const paths = require("../../../utils/knowledgeSync/paths");
const { wipeWorkspace } = require("../../../utils/knowledgeSync/wipe");

const SLUG = "wsx";
const touch = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "f"), "x");
};

beforeEach(async () => {
  memdb.reset();
  locks._resetForTests();
  touch(paths.lanceTablePath(SLUG));
  touch(paths.ksDocsDir(SLUG));
  touch(paths.backupRoot(SLUG));
  await memdb.db.workspace_documents.create({
    data: { docId: "d1", workspaceId: 5 },
  });
  await memdb.db.workspace_documents.create({
    data: { docId: "d2", workspaceId: 6 },
  });
  await memdb.db.document_vectors.create({ data: { docId: "d1" } });
  await memdb.db.document_vectors.create({ data: { docId: "d2" } });
  await memdb.db.$transaction((tx) =>
    marker.writeMarker(tx, SLUG, { versionId: 1, sourceRandomId: "abcdef01" })
  );
});

test("removes all five artifacts, keeps workspace row and others", async () => {
  const r = await wipeWorkspace({ slug: SLUG, userId: 1, multiUser: false });
  expect(r).toEqual({ slug: SLUG, wiped: true });
  expect(fs.existsSync(paths.lanceTablePath(SLUG))).toBe(false);
  expect(fs.existsSync(paths.ksDocsDir(SLUG))).toBe(false);
  expect(fs.existsSync(paths.backupRoot(SLUG))).toBe(false);
  expect(await marker.readMarker(SLUG)).toBeNull();
  expect(memdb.state.docs.map((d) => d.docId)).toEqual(["d2"]);
  expect(memdb.state.vecs.map((d) => d.docId)).toEqual(["d2"]);
  // workspaces row never touched
  expect(memdb.calls.workspaces).toBe(0);
  expect(locks.heldCount()).toBe(0);
});

test("busy lock yields KS_E_BUSY and deletes nothing", async () => {
  locks.acquire(SLUG, "import");
  await expect(wipeWorkspace({ slug: SLUG })).rejects.toMatchObject({
    code: "KS_E_BUSY",
  });
  expect(fs.existsSync(paths.lanceTablePath(SLUG))).toBe(true);
});

test("unsafe slug rejected", async () => {
  await expect(wipeWorkspace({ slug: "../etc" })).rejects.toMatchObject({
    code: "KS_E_UNSAFE_ENTRY",
  });
});

test("non-member non-admin forbidden before any deletion", async () => {
  await expect(
    wipeWorkspace({
      slug: SLUG,
      user: { id: 2, role: "default" },
      multiUser: true,
    })
  ).rejects.toMatchObject({ code: "KS_E_FORBIDDEN" });
  expect(fs.existsSync(paths.lanceTablePath(SLUG))).toBe(true);
  expect(await marker.readMarker(SLUG)).not.toBeNull();
  await expect(
    wipeWorkspace({
      slug: SLUG,
      user: { id: 1, role: "default" },
      multiUser: true,
    })
  ).resolves.toMatchObject({ wiped: true });
});

test("unknown workspace gives KS_E_NOT_FOUND", async () => {
  await expect(wipeWorkspace({ slug: "nope" })).rejects.toMatchObject({
    code: "KS_E_NOT_FOUND",
  });
});
