const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { toClientError } = require("../utils/knowledgeSync/errors");
const secrets = require("../utils/knowledgeSync/secrets");
const { SystemSettings } = require("../models/systemSettings");
const { safeLog } = require("../utils/knowledgeSync/redact");
const { reqBody } = require("../utils/http");
const { assertSafeSlug } = require("../utils/knowledgeSync/paths");
const { exportWorkspace } = require("../utils/knowledgeSync/exporter");
const { previewImport } = require("../utils/knowledgeSync/preview");
const { confirmImport } = require("../utils/knowledgeSync/importer");
const { loadStaged, discardStaged } = require("../utils/knowledgeSync/stage");
const { KnowledgeSyncError } = require("../utils/knowledgeSync/errors");
const fs = require("fs");
const { assertWorkspaceAccess } = require("../utils/knowledgeSync/access");
const jobs = require("../utils/knowledgeSync/jobs");
const runners = require("../utils/knowledgeSync/runners");
const releases = require("../utils/knowledgeSync/releases");
const catalogCache = require("../utils/knowledgeSync/catalogCache");
const { wipeWorkspace } = require("../utils/knowledgeSync/wipe");
const { backupRoot } = require("../utils/knowledgeSync/paths");
const { getKnowledgeSyncConfig } = require("../utils/knowledgeSync/config");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Locked admin gate: Phase 7 publish / delete-version / wipe routes MUST use it.
const KS_ADMIN_GATE = [validatedRequest, flexUserRoleValid([ROLES.admin])];
const KS_USER_GATE = [validatedRequest, flexUserRoleValid([ROLES.all])];

const STATUS = {
  KS_E_FORBIDDEN: 403,
  KS_E_NOT_FOUND: 404,
  KS_E_BUSY: 409,
  KS_E_SYNCING: 409,
  KS_E_GITHUB: 502,
  KS_E_PART_HASH: 502,
  KS_E_CATALOG: 502,
  KS_E_JOB_NOT_FOUND: 404,
  KS_E_NO_PAT: 400,
  KS_E_UNKNOWN: 500,
};

function fail(response, err) {
  const body = toClientError(err);
  const status = STATUS[body.code] || 400;
  if (status === 500) safeLog("error", "request failed", { code: body.code });
  return response.status(status).json({ error: body });
}

async function isAdminOrSingle(response) {
  if (!response.locals?.multiUserMode) return true;
  return response.locals?.user?.role === ROLES.admin;
}

async function accessCtx(response) {
  const multiUser =
    response.locals?.multiUserMode ?? (await SystemSettings.isMultiUserMode());
  return { user: response.locals?.user ?? null, multiUser: !!multiUser };
}

function knowledgeSyncEndpoints(app) {
  if (!app) return;

  app.get("/knowledge-sync/status", KS_USER_GATE, async (_req, response) => {
    try {
      const multi =
        response.locals?.multiUserMode ??
        (await SystemSettings.isMultiUserMode());
      response.locals.multiUserMode = multi;
      const out = { passphrase: await secrets.passphraseStatus() };
      if (await isAdminOrSingle(response)) out.pat = await secrets.patStatus();
      return response.status(200).json(out);
    } catch (e) {
      return fail(response, e);
    }
  });

  app.put("/knowledge-sync/pat", KS_ADMIN_GATE, async (request, response) => {
    try {
      await secrets.setPat(reqBody(request)?.pat);
      return response.status(200).json({ pat: await secrets.patStatus() });
    } catch (e) {
      return fail(response, e);
    }
  });

  app.delete("/knowledge-sync/pat", KS_ADMIN_GATE, async (_req, response) => {
    try {
      await secrets.clearPat();
      return response.status(200).json({ pat: await secrets.patStatus() });
    } catch (e) {
      return fail(response, e);
    }
  });

  app.put(
    "/knowledge-sync/passphrase",
    KS_USER_GATE,
    async (request, response) => {
      try {
        await secrets.setPassphrase(reqBody(request)?.passphrase);
        return response
          .status(200)
          .json({ passphrase: await secrets.passphraseStatus() });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.delete(
    "/knowledge-sync/passphrase",
    KS_USER_GATE,
    async (_req, response) => {
      try {
        await secrets.clearPassphrase();
        return response
          .status(200)
          .json({ passphrase: await secrets.passphraseStatus() });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.post(
    "/knowledge-sync/export/:slug",
    KS_ADMIN_GATE,
    async (request, response) => {
      try {
        const slug = assertSafeSlug(request.params.slug);
        const r = await exportWorkspace({ slug });
        return response.status(200).json({
          archive: {
            name: r.archiveName,
            versionId: r.versionId,
            bytes: r.bytes,
            rowCount: r.rowCount,
          },
        });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.post(
    "/knowledge-sync/import/preview",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const body = reqBody(request) || {};
        const passphrase = body.passphrase || (await secrets.getPassphrase());
        const preview = await previewImport({
          archiveName: body.archive,
          passphrase,
          userId: response.locals.user?.id ?? null,
        });
        return response.status(200).json(preview);
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.post(
    "/knowledge-sync/import/confirm",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const body = reqBody(request) || {};
        const r = await confirmImport({
          previewId: body.previewId,
          userId: response.locals.user?.id ?? null,
          ...(await accessCtx(response)),
          passphrase: body.passphrase,
          allowUnsynced: body.allowUnsynced === true,
        });
        return response.status(200).json(r);
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.post(
    "/knowledge-sync/import/discard",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const previewId = (reqBody(request) || {}).previewId;
        // Expired previews must still be discardable (CR-02).
        const staged = await loadStaged(previewId, { allowExpired: true });
        const owner = staged.meta && staged.meta.ownerUserId;
        const uid = response.locals.user?.id ?? null;
        if (owner !== null && owner !== undefined && owner !== uid)
          throw new KnowledgeSyncError("KS_E_PREVIEW_INVALID", {
            phase: "owner",
          });
        await discardStaged(previewId);
        return response.status(200).json({ discarded: true });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  const uid = (response) => response.locals.user?.id ?? null;
  const pollMs = () => getKnowledgeSyncConfig().job_poll_interval_ms;
  const jobId = (request) => {
    const id = request.params.jobId;
    if (typeof id !== "string" || !UUID_RE.test(id))
      throw new KnowledgeSyncError("KS_E_JOB_NOT_FOUND");
    return id;
  };
  const isAdmin = (response) => response.locals?.user?.role === ROLES.admin;
  const withLocals = async (response) => {
    response.locals.multiUserMode =
      response.locals?.multiUserMode ??
      (await SystemSettings.isMultiUserMode());
    return response.locals.multiUserMode;
  };
  // Single-user mode has no role: everyone is the admin.
  const adminFlag = async (response) =>
    (await withLocals(response)) ? isAdmin(response) : true;

  async function requirePassphrase() {
    const passphrase = await secrets.getPassphrase();
    if (!passphrase)
      throw new KnowledgeSyncError("KS_E_PASSPHRASE", { phase: "preflight" });
    return passphrase;
  }

  app.post(
    "/knowledge-sync/publish/:slug",
    KS_ADMIN_GATE,
    async (request, response) => {
      try {
        const slug = assertSafeSlug(request.params.slug);
        if (!(await secrets.getPat()))
          throw new KnowledgeSyncError("KS_E_NO_PAT", { phase: "preflight" });
        const passphrase = await requirePassphrase();
        const userId = uid(response);
        const id = jobs.startJob({
          kind: "publish",
          slug,
          userId,
          run: (ctx) =>
            runners.publishRunner({
              slug,
              userId,
              ctx,
              passphrase,
              onCatalogChanged: catalogCache.invalidate,
            }),
        });
        return response.status(202).json({ jobId: id });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.get(
    "/knowledge-sync/versions/:slug",
    KS_ADMIN_GATE,
    async (request, response) => {
      try {
        const slug = assertSafeSlug(request.params.slug);
        const r = await releases.listVersions({
          slug,
          passphrase: await requirePassphrase(),
        });
        return response.status(200).json({ ...r, next: (r.latest || 0) + 1 });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.delete(
    "/knowledge-sync/delete-version/:slug/:version",
    KS_ADMIN_GATE,
    async (request, response) => {
      try {
        const slug = assertSafeSlug(request.params.slug);
        if (!/^[1-9][0-9]{0,8}$/.test(String(request.params.version)))
          throw new KnowledgeSyncError("KS_E_NOT_FOUND", { phase: "delete" });
        const r = await releases.deleteVersion({
          slug,
          version: Number(request.params.version),
          passphrase: await requirePassphrase(),
          onCatalogChanged: catalogCache.invalidate,
        });
        catalogCache.invalidate();
        return response.status(200).json({ deleted: true, version: r.version });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  async function catalogView(refresh) {
    const status = refresh
      ? await catalogCache.refresh()
      : await catalogCache.getCatalogStatus();
    if (!status.configured) return { ...status, entries: [] };
    const entries = (status.entries || []).map((e) => {
      let backup = false;
      try {
        backup = fs.existsSync(backupRoot(e.slug));
      } catch {
        backup = false;
      }
      return {
        ...e,
        localVersion: (status.localVersions || {})[e.slug] ?? null,
        backupExists: backup,
      };
    });
    return { ...status, entries, passphrase: true };
  }

  app.get("/knowledge-sync/catalog", KS_USER_GATE, async (_req, response) => {
    try {
      return response.status(200).json(await catalogView(false));
    } catch (e) {
      return fail(response, e);
    }
  });

  app.post(
    "/knowledge-sync/catalog/refresh",
    KS_USER_GATE,
    async (_req, response) => {
      try {
        return response.status(200).json(await catalogView(true));
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.post(
    "/knowledge-sync/sync/:slug",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const slug = assertSafeSlug(request.params.slug);
        const passphrase = await requirePassphrase();
        const body = reqBody(request) || {};
        const userId = uid(response);
        const ctxAccess = await accessCtx(response);
        const id = jobs.startJob({
          kind: "sync",
          slug,
          userId,
          run: (ctx) =>
            runners.syncRunner({
              slug,
              userId,
              ctx,
              passphrase,
              accessCtx: ctxAccess,
              version: Number.isInteger(body.version)
                ? body.version
                : undefined,
            }),
        });
        return response.status(202).json({ jobId: id });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.post(
    "/knowledge-sync/rollback/:slug",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const slug = assertSafeSlug(request.params.slug);
        const userId = uid(response);
        const ctxAccess = await accessCtx(response);
        // Fail early (403) instead of inside the job.
        await assertWorkspaceAccess({ slug, ...ctxAccess });
        const id = jobs.startJob({
          kind: "rollback",
          slug,
          userId,
          run: (ctx) =>
            runners.rollbackRunner({
              slug,
              userId,
              ctx,
              accessCtx: ctxAccess,
            }),
        });
        return response.status(202).json({ jobId: id });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.post(
    "/knowledge-sync/jobs/:jobId/confirm",
    KS_USER_GATE,
    async (request, response) => {
      try {
        await withLocals(response);
        return response
          .status(200)
          .json({ job: jobs.confirmJob(jobId(request), response.locals.user) });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.post(
    "/knowledge-sync/jobs/:jobId/cancel",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const admin = await adminFlag(response);
        return response.status(200).json({
          job: jobs.requestCancel(jobId(request), response.locals.user, admin),
        });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.get(
    "/knowledge-sync/jobs/:jobId",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const admin = await adminFlag(response);
        const job = await jobs.getJob(
          jobId(request),
          response.locals.user,
          admin
        );
        return response
          .status(200)
          .json({ job, job_poll_interval_ms: pollMs() });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.get(
    "/knowledge-sync/workspaces/:slug/job",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const slug = assertSafeSlug(request.params.slug);
        const admin = await adminFlag(response);
        const job = await jobs.lastJobForSlug(
          slug,
          response.locals.user,
          admin
        );
        return response
          .status(200)
          .json({ job, job_poll_interval_ms: pollMs() });
      } catch (e) {
        return fail(response, e);
      }
    }
  );

  app.post(
    "/knowledge-sync/wipe/:slug",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const slug = assertSafeSlug(request.params.slug);
        const r = await wipeWorkspace({
          slug,
          userId: uid(response),
          ...(await accessCtx(response)),
        });
        catalogCache.invalidate();
        return response.status(200).json(r);
      } catch (e) {
        return fail(response, e);
      }
    }
  );
}

module.exports = { knowledgeSyncEndpoints, KS_ADMIN_GATE, KS_USER_GATE };
