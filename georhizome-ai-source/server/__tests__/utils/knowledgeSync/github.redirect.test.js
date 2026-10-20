const {
  request,
  createGithubClient,
} = require("../../../utils/knowledgeSync/github");

const resp = (status, headers = {}, body = "") =>
  new Response(body, { status, headers });
const cfg =
  require("../../../utils/knowledgeSync/config").getKnowledgeSyncConfig();

test("no Authorization on redirect hop to CDN", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    if (url.startsWith("https://api.github.com"))
      return resp(302, { location: "https://objects.githubusercontent.com/x" });
    return resp(200, {}, "ok");
  };
  const res = await request("https://api.github.com/a", {
    token: "TEST_PAT",
    fetchImpl,
    config: cfg,
  });
  expect(res.status).toBe(200);
  expect(seen[0].auth).toBe("Bearer TEST_PAT");
  expect(seen[1].url).toContain("objects.githubusercontent.com");
  expect(seen[1].auth).toBeUndefined();
});

test("no Authorization to github.com host", async () => {
  let auth = "unset";
  await request("https://github.com/a", {
    token: "TEST_PAT",
    config: cfg,
    fetchImpl: async (u, init) => {
      auth = init.headers.Authorization;
      return resp(200);
    },
  });
  expect(auth).toBeUndefined();
});

test("refuses non-allowlisted host, http, and redirect to either", async () => {
  const fetchImpl = async () => resp(200);
  await expect(
    request("https://evil.example/x", { fetchImpl, config: cfg })
  ).rejects.toMatchObject({ code: "KS_E_UNSAFE_ENTRY" });
  await expect(
    request("http://api.github.com/x", { fetchImpl, config: cfg })
  ).rejects.toMatchObject({ code: "KS_E_UNSAFE_ENTRY" });
  const redir = async () => resp(302, { location: "https://evil.example/y" });
  await expect(
    request("https://github.com/x", { fetchImpl: redir, config: cfg })
  ).rejects.toMatchObject({ code: "KS_E_UNSAFE_ENTRY" });
});

test("401 maps to KS_E_PAT_INVALID without leaking token", async () => {
  const c = createGithubClient({
    getToken: async () => "TEST_PAT",
    config: cfg,
    fetchImpl: async () => resp(401),
  });
  const err = await c.listReleases().catch((e) => e);
  expect(err.code).toBe("KS_E_PAT_INVALID");
  expect(JSON.stringify(err) + err.message).not.toContain("TEST_PAT");
});
