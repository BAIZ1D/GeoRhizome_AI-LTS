import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

// Never log request bodies; secrets must not reach console/localStorage/URL.
async function call(path, method, body) {
  try {
    const res = await fetch(`${API_BASE}/knowledge-sync/${path}`, {
      method,
      headers: baseHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = data?.error?.code || null;
      return { ok: false, data: null, error: { code, status: res.status } };
    }
    return { ok: true, data, error: null };
  } catch {
    return {
      ok: false,
      data: null,
      error: { code: "KS_E_UNKNOWN", status: 0 },
    };
  }
}

const KnowledgeSync = {
  status: () => call("status", "GET"),
  setPat: (pat) => call("pat", "PUT", { pat }),
  clearPat: () => call("pat", "DELETE"),
  setPassphrase: (passphrase) => call("passphrase", "PUT", { passphrase }),
  clearPassphrase: () => call("passphrase", "DELETE"),
};

export default KnowledgeSync;
