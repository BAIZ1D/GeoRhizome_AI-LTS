const http = require("http");

/**
 * In-process fake of services/local_sparse_server.py for tests (no ML).
 * Modes: ok | 413 | 503-busy | 503-degraded | down.
 */
async function start({
  mode = "ok",
  maxChars = 1024,
  maxInputs = 16,
  port = 0,
} = {}) {
  const calls = [];
  let inflight = 0;
  const state = { maxInflight: 0, mode, port: 0 };
  const sockets = new Set();

  function handler(req, res) {
    if (req.method === "GET" && req.url === "/health") {
      calls.push({ path: "/health", method: "GET" });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          state: state.mode === "503-degraded" ? "degraded" : "ready",
        })
      );
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let inputs = [];
      try {
        const b = JSON.parse(raw || "{}");
        inputs = Array.isArray(b.input) ? b.input : [b.input];
      } catch (_) {
        /* ignore */
      }
      calls.push({ path: req.url, method: req.method, inputs: inputs.length });
      const send = (status, obj) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(obj));
      };
      if (state.mode === "413") return send(413, { detail: "too large" });
      if (
        inputs.length > maxInputs ||
        inputs.some((t) => [...String(t)].length > maxChars)
      ) {
        return send(413, { detail: "too large" });
      }
      if (state.mode === "503-busy")
        return send(503, { detail: "sparse encoder busy" });
      if (state.mode === "503-degraded")
        return send(503, { detail: "sparse encoder degraded" });
      inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, inflight);
      // Returned reversed to prove the client re-aligns by `index`.
      const data = inputs
        .map((t, i) => ({
          index: i,
          indices: [i + 1, i + 100],
          values: [1.5, 0.5],
        }))
        .reverse();
      setTimeout(() => {
        inflight -= 1;
        send(200, { model_id: "fake", vocab_size: 32768, truncated: 0, data });
      }, 10);
    });
  }

  const server = http.createServer(handler);
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  state.port = server.address().port;
  return {
    url: `http://127.0.0.1:${state.port}`,
    port: state.port,
    calls,
    state,
    setMode: (m) => (state.mode = m),
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

module.exports = { start };
