const http = require("http");
const express = require("express");

const mockStore = new Map();
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    isMultiUserMode: jest.fn(async () => false),
    get: jest.fn(async ({ label }) => mockStore.get(label) || null),
    _updateSettings: jest.fn(async (u) => {
      for (const [k, v] of Object.entries(u))
        mockStore.set(k, { label: k, value: v });
    }),
    delete: jest.fn(async ({ label }) => {
      mockStore.delete(label);
      return true;
    }),
  },
}));
jest.mock("../../models/user", () => ({ User: { get: jest.fn() } }));
jest.mock("../../utils/http", () => ({
  reqBody: jest.requireActual("../../utils/http").reqBody,
  decodeJWT: jest.fn(),
  userFromSession: jest.fn(),
}));
jest.mock("../../utils/EncryptionManager", () => ({
  EncryptionManager: class {
    encrypt(s) {
      return "enc:" + Buffer.from(s).toString("base64");
    }
    decrypt(s) {
      return s.startsWith("enc:")
        ? Buffer.from(s.slice(4), "base64").toString()
        : null;
    }
  },
}));

const secrets = require("../../utils/knowledgeSync/secrets");
const { knowledgeSyncEndpoints } = require("../../endpoints/knowledgeSync");

const PAT = "ghp_" + "a".repeat(30) + "WXYZ";
const PASS = "correct horse battery";

let server, port;
beforeAll(async () => {
  delete process.env.AUTH_TOKEN;
  const app = express();
  app.use(express.text());
  app.use(express.json());
  const r = express.Router();
  knowledgeSyncEndpoints(r);
  app.use("/api", r);
  await new Promise((res) => (server = app.listen(0, res)));
  port = server.address().port;
});
afterAll(() => server.close());
beforeEach(() => mockStore.clear());

const call = (method, path, body, contentType = "application/json") =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        port,
        method,
        path: "/api" + path,
        headers: { "content-type": contentType },
      },
      (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, text: t }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });

describe("secrets", () => {
  test("PAT stored encrypted, last4 derived", async () => {
    await secrets.setPat(PAT);
    expect(mockStore.get("ks_github_pat").value).not.toContain(PAT);
    expect(mockStore.size).toBe(1);
    expect(await secrets.patStatus()).toEqual({
      configured: true,
      last4: "WXYZ",
    });
    expect(await secrets.getPat()).toBe(PAT);
  });
  test("invalid PAT rejected without echo", async () => {
    await expect(secrets.setPat("nope")).rejects.toMatchObject({
      code: "KS_E_PAT_INVALID",
    });
    expect(mockStore.size).toBe(0);
  });
  test("undecryptable -> not configured", async () => {
    mockStore.set("ks_github_pat", {
      label: "ks_github_pat",
      value: "garbage",
    });
    expect(await secrets.patStatus()).toEqual({
      configured: false,
      last4: null,
    });
  });
  test("passphrase min length and lifecycle", async () => {
    await expect(secrets.setPassphrase("short")).rejects.toMatchObject({
      code: "KS_E_PASSPHRASE_TOO_SHORT",
    });
    await secrets.setPassphrase(PASS);
    expect(await secrets.passphraseStatus()).toEqual({ configured: true });
    await secrets.clearPassphrase();
    expect(await secrets.passphraseStatus()).toEqual({ configured: false });
  });
});

describe("routes", () => {
  test("body githubPat ignored", async () => {
    const r = await call("PUT", "/knowledge-sync/pat", { githubPat: PAT });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error.code).toBe("KS_E_PAT_INVALID");
    expect(r.text).not.toContain(PAT);
    expect(mockStore.size).toBe(0);
  });
  test("set pat, status leaks nothing", async () => {
    const put = await call("PUT", "/knowledge-sync/pat", { pat: PAT });
    expect(put.status).toBe(200);
    await call("PUT", "/knowledge-sync/passphrase", { passphrase: PASS });
    const st = await call("GET", "/knowledge-sync/status");
    expect(JSON.parse(st.text)).toEqual({
      pat: { configured: true, last4: "WXYZ" },
      passphrase: { configured: true },
    });
    for (const t of [put.text, st.text]) {
      expect(t).not.toContain(PAT);
      expect(t).not.toContain(PASS);
    }
  });
  // Frontend baseHeaders() sends no content-type, so fetch posts text/plain.
  test("text/plain JSON bodies are accepted", async () => {
    const pat = await call(
      "PUT",
      "/knowledge-sync/pat",
      { pat: PAT },
      "text/plain"
    );
    expect(pat.status).toBe(200);
    const pass = await call(
      "PUT",
      "/knowledge-sync/passphrase",
      { passphrase: PASS },
      "text/plain"
    );
    expect(pass.status).toBe(200);
    expect(JSON.parse(pass.text).passphrase.configured).toBe(true);
  });
  test("short passphrase 400", async () => {
    const r = await call("PUT", "/knowledge-sync/passphrase", {
      passphrase: "x",
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error.code).toBe("KS_E_PASSPHRASE_TOO_SHORT");
  });
  test("delete routes", async () => {
    await secrets.setPat(PAT);
    const r = await call("DELETE", "/knowledge-sync/pat");
    expect(JSON.parse(r.text).pat.configured).toBe(false);
  });
});
