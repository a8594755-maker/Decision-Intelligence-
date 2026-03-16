# Workspace Surfaces

This repository keeps one root app and multiple supporting integration surfaces. Node-based integrations are managed from the root `package.json` as npm workspaces so contributors can install, script, and review them from a single entry point.

## Included In The npm Workspace

- root app: React frontend, shared services, tests, and release scripts
- `discord-bot/`: Discord bridge for operational workflows
- `excel-addin/`: Excel add-in runtime and local sideload tooling

## Intentionally Outside The npm Workspace

- `opencloud-extension/`: extension surface without a Node package manifest yet
- `powerbi-connector/`: connector assets and setup docs, not a packaged runtime
- `.netlify/`: platform-generated implementation details

These directories stay outside the workspace until they gain their own package manifest, scripts, and reviewable dependency lifecycle.

The root `package-lock.json` is the canonical lockfile for workspace-managed packages. Do not add or update per-workspace lockfiles under `discord-bot/` or `excel-addin/`.

## Common Commands

Install all workspace dependencies from the root:

```bash
npm ci
```

Run the frontend:

```bash
npm run dev
```

Run the Discord bot:

```bash
npm run bot:dev
```

Run the Excel add-in local server:

```bash
npm run excel:dev
```

Sideload the Excel add-in:

```bash
npm run excel:sideload
```

## Review Expectations

- keep workspace-specific dependencies inside the owning package
- avoid adding integration-only scripts to the root unless they are intended for cross-team usage
- document new runtime surfaces in `docs/adr/` before adding them to the workspace
- keep non-workspace surfaces documented here so contributors know they are intentional, not forgotten
