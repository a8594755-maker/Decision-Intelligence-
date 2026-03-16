# Contributing

This repository is maintained as a product prototype with multiple runtime surfaces: frontend, Supabase/SQL, and ML API. Changes should be easy to review, test, and roll back by someone other than the original author.

## Working Agreement

- Keep pull requests focused on one problem or one bounded refactor.
- Prefer additive migrations and backward-compatible API changes.
- Do not mix product copy rewrites, infra changes, and feature work in the same PR unless they are tightly coupled.
- Update docs when behavior, setup, or operating boundaries change.
- Record non-trivial architecture decisions in `docs/adr/`.

## Workspace Surfaces

The root `package.json` is the entry point for Node-based surfaces:

- root app: frontend, shared services, Playwright, and Vitest
- `discord-bot/`: operational bot bridge
- `excel-addin/`: Office/Excel integration surface

Use root workspace commands so installs and lockfile changes stay reviewable:

```bash
npm ci
npm run bot:dev
npm run excel:dev
```

The root `package-lock.json` is the canonical lockfile for workspace-managed Node surfaces.

See `docs/WORKSPACES.md` for the current workspace boundary and what is intentionally kept outside it.

## Before Opening a PR

Run the smallest relevant checks locally:

```bash
npm run lint
npm run test:run
npm run build
python3 -m pytest -q tests/regression
```

If your change only touches one area, state the narrower verification you ran instead of claiming full-repo coverage.

## Change Types

### Frontend

- Keep page-level files thin where possible; extract hooks, card renderers, and service adapters before adding more conditional branches.
- Prefer route/view changes to stay inside their domain folder instead of extending unrelated shared files.

### SQL / Supabase

- Add forward-only migrations under `sql/migrations/`.
- Document rollout and rollback expectations for schema or RPC changes.
- Call out any RLS or permission changes explicitly in the PR.

### ML API / Planning

- Keep request/response contracts stable or versioned.
- Update regression fixtures or tests when planner behavior changes intentionally.
- Document changes that affect SLOs, telemetry, or release gates.

## PR Expectations

- Link the motivating issue, bug, or decision note.
- Include a concise risk section: user impact, rollout concern, and rollback path.
- Include screenshots or artifacts for UI or report changes.
- Note any follow-up work that is intentionally deferred.

## Ownership

Path ownership is defined in `.github/CODEOWNERS`. If a change crosses frontend, platform, and ML boundaries, request review from each affected owner before merge.

## ADR Process

Create an ADR for decisions such as:

- introducing a new runtime or deployment surface
- changing core data contracts
- refactoring a large workflow boundary
- changing release, rollback, or observability policy

Use `docs/adr/README.md` for the format and index.
