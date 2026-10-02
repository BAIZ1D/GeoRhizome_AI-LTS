const { reqBody } = require("../utils/http");

function hardwareEndpoints(app) {
  if (!app) return;

  const HARDWARE_SERVER_URL = process.env.HARDWARE_SERVER_URL || "http://127.0.0.1:8002";

  // GET /api/hardware/detect
  app.get("/hardware/detect", async (request, response) => {
    try {
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/detect`);
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // GET /api/hardware/catalog
  app.get("/hardware/catalog", async (request, response) => {
    try {
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/catalog`);
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // GET /api/hardware/hf-files
  app.get("/hardware/hf-files", async (request, response) => {
    try {
      const { repo_id } = request.query;
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/hf-files?repo_id=${encodeURIComponent(repo_id || "")}`);
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // POST /api/hardware/download
  app.post("/hardware/download", async (request, response) => {
    try {
      const body = reqBody(request);
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // POST /api/hardware/serve
  app.post("/hardware/serve", async (request, response) => {
    try {
      const body = reqBody(request);
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/serve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // POST /api/hardware/offload
  app.post("/hardware/offload", async (request, response) => {
    try {
      const body = reqBody(request);
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/offload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // POST /api/hardware/cancel_download
  app.post("/hardware/cancel_download", async (request, response) => {
    try {
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/cancel_download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // POST /api/hardware/purge_cache
  app.post("/hardware/purge_cache", async (request, response) => {
    try {
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/purge_cache`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // GET /api/hardware/status
  app.get("/hardware/status", async (request, response) => {
    try {
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/status`);
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // GET /api/hardware/downloaded
  app.get("/hardware/downloaded", async (request, response) => {
    try {
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/downloaded`);
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });

  // DELETE /api/hardware/downloaded/*
  app.delete("/hardware/downloaded/*", async (request, response) => {
    try {
      const filename = request.params[0];
      const res = await fetch(`${HARDWARE_SERVER_URL}/hardware/downloaded/${encodeURIComponent(filename)}`, {
        method: "DELETE"
      });
      const data = await res.json();
      response.status(200).json(data);
    } catch (e) {
      response.status(500).json({ status: "error", error: e.message });
    }
  });
}

module.exports = { hardwareEndpoints };
