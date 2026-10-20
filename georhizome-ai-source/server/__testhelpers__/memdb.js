// In-memory prisma double with transaction rollback-on-throw (tests only).
const state = { docs: [], vecs: [], settings: new Map(), nextId: 1 };
const calls = { workspaces: 0, tx: 0 };
const clone = () => ({
  docs: state.docs.map((d) => ({ ...d })),
  vecs: state.vecs.map((d) => ({ ...d })),
  settings: new Map(state.settings),
  nextId: state.nextId,
});
const restore = (s) => Object.assign(state, s);
const matchDoc = (d, w = {}) =>
  (w.workspaceId === undefined || d.workspaceId === w.workspaceId) &&
  (!w.docId ||
    (w.docId.in ? w.docId.in.includes(d.docId) : d.docId === w.docId));

const api = {
  workspace_documents: {
    findMany: async ({ where } = {}) =>
      state.docs.filter((d) => matchDoc(d, where)).map((d) => ({ ...d })),
    deleteMany: async ({ where }) => {
      state.docs = state.docs.filter((d) => !matchDoc(d, where));
    },
    create: async ({ data }) => {
      if (state.docs.some((d) => d.docId === data.docId))
        throw new Error("unique docId");
      state.docs.push({ id: state.nextId++, ...data });
    },
  },
  document_vectors: {
    findMany: async ({ where } = {}) =>
      state.vecs.filter((v) => matchDoc(v, where)).map((v) => ({ ...v })),
    deleteMany: async ({ where }) => {
      state.vecs = state.vecs.filter((v) => !matchDoc(v, where));
    },
    create: async ({ data }) => {
      state.vecs.push({ ...data });
    },
  },
  system_settings: {
    findFirst: async ({ where }) =>
      state.settings.has(where.label)
        ? { value: state.settings.get(where.label) }
        : null,
    findMany: async ({ where } = {}) =>
      [...state.settings.entries()]
        .filter(
          ([label]) =>
            !where?.label?.startsWith ||
            label.startsWith(where.label.startsWith)
        )
        .map(([label, value]) => ({ label, value })),
    upsert: async ({ where, create }) => {
      state.settings.set(where.label, create.value);
    },
    deleteMany: async ({ where }) => {
      state.settings.delete(where.label);
    },
  },
  workspaces: new Proxy(
    {},
    {
      get: () => async () => {
        calls.workspaces++;
      },
    }
  ),
  $transaction: async (fn) => {
    calls.tx++;
    const snap = clone();
    try {
      return await fn(api);
    } catch (e) {
      restore(snap);
      throw e;
    }
  },
};
const snapshot = () =>
  JSON.stringify(clone(), (k, v) => (v instanceof Map ? [...v] : v));
const reset = () => {
  state.docs = [];
  state.vecs = [];
  state.settings = new Map();
  state.nextId = 1;
  calls.workspaces = 0;
  calls.tx = 0;
};
module.exports = { db: api, state, calls, snapshot, reset };
