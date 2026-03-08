# Changelog

All notable repository-level changes should be recorded here.

## [Unreleased]

### Changed

- Reframed the repo around product, architecture, deployment, limitations, and release notes.
- Added a curated documentation portal and reduced the prominence of internal execution and refactor reports.

## [0.1.0] - 2026-03-08

### Added

- React application shell with Command Center, Plan Studio, Forecast Studio, Risk Center, Digital Twin, Scenario Studio, and Settings routes.
- Supabase-backed auth, storage, operational tables, RPCs, and Edge Functions for AI proxy, BOM explosion, and sync workflows.
- Python ML API for forecasting, planning, async runs, registry, governance, and telemetry.
- Frontend, ML, guardrail, and regression workflows under `.github/workflows/`.

### Operational Notes

- Frontend ships as a static Vite build.
- ML API is deployed as a separate container and has Railway configuration in-repo.
- Full product usage requires Supabase configuration plus Edge Function secrets for AI providers.
