# 0001 Repository Boundaries And Ownership

- Status: Accepted
- Date: 2026-03-16

## Context

This repository contains multiple delivery surfaces in one codebase:

- React frontend and route/view composition
- Supabase integration, Edge Functions, and SQL migrations
- Python ML API, planning logic, and regression tests
- supporting integrations such as Discord bot, Excel add-in, and Power BI connector

The repo already has CI, release checklists, and product-facing documentation, but it does not yet expose clear contributor workflow or ownership boundaries. That creates three problems for a multi-person team:

1. review routing depends on tribal knowledge
2. cross-cutting changes are easy to merge without explicit accountability
3. large refactors risk expanding without a written boundary for what belongs where

## Decision

We will keep a single repository, but treat it as a boundary-managed multi-surface codebase.

The repository is divided into four ownership zones:

- frontend UX: `src/components`, `src/pages`, `src/views`, `src/router.jsx`
- platform/data plane: `src/services`, `supabase`, `sql`
- ML/runtime: `src/ml`, `tests`, planning and regression scripts
- repo operations: `.github`, `docs`, release/checklist materials

The collaboration rules are:

- path ownership is declared in `.github/CODEOWNERS`
- contributor workflow lives in `CONTRIBUTING.md`
- design-heavy changes require an ADR under `docs/adr/`
- release and rollout expectations remain documented in the existing runbooks and gate docs

## Consequences

Positive:

- contributors can identify the owner of a path before editing it
- PR review scope is easier to route and reason about
- architectural changes gain a durable written trail

Trade-offs:

- the repo still has large files and mixed runtimes, so ownership does not remove the need for future modular refactors
- `CODEOWNERS` starts with a single default owner and must be updated as real teams or maintainers are added

Follow-up work:

- split oversized workflow files into domain modules that map cleanly to ownership zones
- formalize shared contracts between frontend, platform services, and ML runtime
- add workspace-level tooling if the supporting integrations continue to grow

