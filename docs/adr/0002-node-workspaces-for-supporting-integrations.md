# 0002 Node Workspaces For Supporting Integrations

- Status: Accepted
- Date: 2026-03-16

## Context

The repository already contains multiple Node-based delivery surfaces:

- the root frontend and test toolchain
- `discord-bot/` for operational chat integration
- `excel-addin/` for Office/Excel workflows

These surfaces were stored in one repository but managed as loosely related folders. That created avoidable team friction:

1. dependency updates were spread across multiple install entry points
2. root-level contributors could not discover supported integration scripts quickly
3. reviewers had no written boundary for which supporting runtimes were first-class Node packages versus static assets

## Decision

We will manage Node-based supporting integrations from the root `package.json` using npm workspaces.

The initial workspace members are:

- `discord-bot/`
- `excel-addin/`

We will keep `powerbi-connector/` and platform-generated directories outside the workspace until they expose their own package manifest and dependency lifecycle.

## Consequences

Positive:

- contributors can install and run supported Node surfaces from one root entry point
- dependency review becomes easier because workspace membership is explicit
- integration ownership can be documented and enforced alongside the main app

Trade-offs:

- workspace boundaries now need maintenance as new integrations are added
- non-workspace integrations remain heterogeneous and require separate documentation

Follow-up work:

- consolidate or retire legacy per-package lockfile patterns as workspace adoption settles
- add package-level CI jobs if the Discord bot or Excel add-in gain independent release cadence
- promote additional integrations into the workspace only after they have clear manifests and owners
