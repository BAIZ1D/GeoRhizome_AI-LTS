---
phase: 12-hybrid-retrieval
plan: 03
subsystem: workspace-settings
tags: [prisma, hybrid-search, i18n]
requires: []
provides: [workspaces.hybridSearch nullable flag, workspace settings toggle]
affects: [12-04]
key-files:
  created:
    - georhizome-ai-source/server/prisma/migrations/20261105000000_workspace_hybrid_search/migration.sql
    - georhizome-ai-source/server/__tests__/models/workspace.hybridSearch.test.js
    - georhizome-ai-source/frontend/src/pages/WorkspaceSettings/VectorDatabase/HybridSearch/index.jsx
  modified:
    - georhizome-ai-source/server/prisma/schema.prisma
    - georhizome-ai-source/server/models/workspace.js
    - georhizome-ai-source/frontend/src/pages/WorkspaceSettings/VectorDatabase/index.jsx
    - georhizome-ai-source/frontend/src/locales/en/common.js
    - georhizome-ai-source/frontend/src/locales/ja/common.js
decisions:
  - "hybridSearch nullable Boolean; null follows app_config.hybrid.enabled"
metrics:
  tasks: 2
  completed: 2026-11-05
---

# Phase 12 Plan 03: Per-workspace hybridSearch toggle Summary

Nullable `workspaces.hybridSearch` column (migration applied via `migrate deploy`), model validator normalizing to true/false/null, and a lancedb-gated select (system default / on / off) in workspace vector settings with real Japanese labels.

## Commits
- 1cf3b2b: column, migration, validation, jest test (4 pass)
- c49ed4b: HybridSearch component, mount, en/ja i18n

## Deviations from Plan
None to code. `yarn translations:verify` fails on pre-existing missing keys across many other locales (out of scope; not touched).

## Verification
- prisma migrate status: up to date; jest passes; eslint clean; vite build OK.
- anythingllm.db is gitignored, not committed.

## Self-Check: PASSED
