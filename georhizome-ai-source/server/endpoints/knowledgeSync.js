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

// Locked admin gate: Phase 7 publish / delete-version / wipe routes MUST use it.
const KS_ADMIN_GATE = [validatedRequest, flexUserRoleValid([ROLES.admin])];
const KS_USER_GATE = [validatedRequest, flexUserRoleValid([ROLES.all])];

function fail(response, err) {
  const body = toClientError(err);
  const status =
    body.code === "KS_E_FORBIDDEN"
      ? 403
      : body.code === "KS_E_UNKNOWN"
        ? 500
        : 400;
  if (status === 500) safeLog("error", "request failed", { code: body.code });
  return response.status(status).json({ error: body });
}

async function isAdminOrSingle(response) {
  if (!response.locals?.multiUserMode) return true;
  return response.locals?.user?.role === ROLES.admin;
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
}

module.exports = { knowledgeSyncEndpoints, KS_ADMIN_GATE, KS_USER_GATE };
