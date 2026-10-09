const { getGitVersion } = require("../../endpoints/utils");
const { Telemetry } = require("../../models/telemetry");

// Telemetry is anonymized and your data is never read. This can be disabled by setting
// DISABLE_TELEMETRY=true in the `.env` of however you setup. Telemetry helps us determine use
// of how GeoRhizome AI is used and how to improve this product!
// You can see all Telemetry events by ctrl+f `Telemetry.sendTelemetry` calls to verify this claim.
async function setupTelemetry() {
  return true;
}

module.exports = setupTelemetry;
