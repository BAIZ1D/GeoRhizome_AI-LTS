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
const { rollbackWorkspace } = require("../utils/knowledgeSync/rollback");
const { loadStaged, discardStaged } = require("../utils/knowledgeSync/stage");
const { KnowledgeSyncError } = require("../utils/knowledgeSync/errors");

// Locked admin gate: Phase 7 publish / delete-version / wipe routes MUST use it.
const KS_ADMIN_GATE = [validatedRequest, flexUserRoleValid([ROLES.admin])];
const KS_USER_GATE = [validatedRequest, flexUserRoleValid([ROLES.all])];

const STATUS = {
  KS_E_FORBIDDEN: 403,
  KS_E_NOT_FOUND: 404,
  KS_E_BUSY: 409,
  KS_E_SYNCING: 409,
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
        const staged = await loadStaged(previewId);
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

  app.post(
    "/knowledge-sync/rollback/:slug",
    KS_USER_GATE,
    async (request, response) => {
      try {
        const slug = assertSafeSlug(request.params.slug);
        const r = await rollbackWorkspace({
          slug,
          userId: response.locals.user?.id ?? null,
          ...(await accessCtx(response)),
        });
        return response.status(200).json(r);
      } catch (e) {
        return fail(response, e);
      }
    }
  );
}

module.exports = { knowledgeSyncEndpoints, KS_ADMIN_GATE, KS_USER_GATE };
