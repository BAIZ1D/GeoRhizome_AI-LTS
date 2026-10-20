import { useCallback, useEffect, useState } from "react";
import KnowledgeSync from "@/models/knowledgeSync";

// Module-level cache shared by sidebar and page (no double fetch, no polling).
let cache = null; // { entries, configured, lastChecked, stale, error }
let inflight = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(cache));

function shape(data) {
  return {
    entries: data?.entries || [],
    configured: data?.configured !== false,
    lastChecked: data?.checkedAt || null,
    stale: !!data?.stale,
    error: data?.error || null,
  };
}

async function load(force) {
  if (inflight) return inflight;
  inflight = (async () => {
    const res = force
      ? await KnowledgeSync.refreshCatalog()
      : await KnowledgeSync.catalog();
    cache = res.ok
      ? shape(res.data)
      : { ...(cache || shape(null)), stale: true, error: res.error };
    inflight = null;
    emit();
    return cache;
  })();
  return inflight;
}

export function resetKsCatalogCache() {
  cache = null;
  inflight = null;
  emit();
}

export default function useKsCatalog() {
  const [state, setState] = useState(cache);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    const fn = (c) => {
      setState(c);
      setLoading(false);
    };
    listeners.add(fn);
    if (!cache) load(false);
    return () => listeners.delete(fn);
  }, []);

  const refresh = useCallback(async () => {
    // D-16: no checks when the catalog is not configured.
    if (state && state.configured === false) return;
    setLoading(true);
    await load(true);
  }, [state]);

  return {
    entries: state?.entries || [],
    configured: state ? state.configured : true,
    lastChecked: state?.lastChecked || null,
    stale: !!state?.stale,
    error: state?.error || null,
    loading,
    refresh,
  };
}
