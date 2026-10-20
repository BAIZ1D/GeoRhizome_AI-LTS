const {
  withRetry,
  cryptoSemaphore,
} = require("../../../utils/knowledgeSync/transport");

const opts = (extra) => ({ attempts: 5, minMs: 2000, maxMs: 60000, ...extra });
const httpErr = (status, headers) =>
  Object.assign(new Error("x"), { status, headers });

test("exponential backoff delays", async () => {
  const delays = [];
  const sleep = async (ms) => delays.push(ms);
  await expect(
    withRetry(async () => {
      throw httpErr(503);
    }, opts({ sleep }))
  ).rejects.toMatchObject({ status: 503 });
  expect(delays).toEqual([2000, 4000, 8000, 16000]);
});

test("Retry-After honored", async () => {
  const delays = [];
  let n = 0;
  const r = await withRetry(
    async () => {
      if (++n === 1) throw httpErr(429, { "retry-after": "30" });
      return "ok";
    },
    opts({ sleep: async (ms) => delays.push(ms) })
  );
  expect(r).toBe("ok");
  expect(delays).toEqual([30000]);
});

test.each([401, 404, 422])("%i not retried", async (s) => {
  let n = 0;
  await expect(
    withRetry(
      async () => {
        n++;
        throw httpErr(s);
      },
      opts({ sleep: async () => {} })
    )
  ).rejects.toMatchObject({ status: s });
  expect(n).toBe(1);
});

test("abort cancels", async () => {
  const ac = new AbortController();
  ac.abort();
  await expect(
    withRetry(async () => "x", opts({ signal: ac.signal }))
  ).rejects.toMatchObject({ code: "KS_E_CANCELLED" });
});

test("semaphore serializes", async () => {
  const sem = cryptoSemaphore(1);
  const log = [];
  const t = (id) => async () => {
    log.push("s" + id);
    await new Promise((r) => setTimeout(r, 10));
    log.push("e" + id);
  };
  await Promise.all([sem.run(t(1)), sem.run(t(2))]);
  expect(log).toEqual(["s1", "e1", "s2", "e2"]);
});
