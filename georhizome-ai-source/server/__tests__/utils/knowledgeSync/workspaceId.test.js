const mockStore = new Map();
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    get: async ({ label }) =>
      mockStore.has(label) ? { label, value: mockStore.get(label) } : null,
    _updateSettings: async (u) => {
      for (const k of Object.keys(u)) mockStore.set(k, String(u[k]));
    },
  },
}));
const {
  getOrCreateRandomId,
  getRandomId,
} = require("../../../utils/knowledgeSync/workspaceId");

test("stable per slug", async () => {
  const a = await getOrCreateRandomId("my-ws");
  expect(a).toMatch(/^[0-9a-f]{8}$/);
  expect(await getOrCreateRandomId("my-ws")).toBe(a);
  expect(await getRandomId("my-ws")).toBe(a);
  expect(await getRandomId("other")).toBeNull();
  const b = await getOrCreateRandomId("other");
  expect(b).not.toBe(a);
});
test("invalid slug", async () => {
  await expect(getOrCreateRandomId("../x")).rejects.toMatchObject({
    code: "KS_E_UNSAFE_ENTRY",
  });
});
