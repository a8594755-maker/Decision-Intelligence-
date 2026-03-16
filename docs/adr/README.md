# ADR Index

Architecture Decision Records capture decisions that affect multiple contributors, runtime surfaces, or release policy.

## When To Write An ADR

Write an ADR when a change:

- creates or removes a runtime boundary
- changes a shared data or API contract
- changes release, rollback, or observability policy
- restructures a major workflow or ownership boundary

## Format

Each ADR should include:

1. Title
2. Status
3. Date
4. Context
5. Decision
6. Consequences

Keep ADRs short. Link to deeper specs, PRs, or runbooks instead of copying them.

## Index

- [0001 Repository Boundaries And Ownership](0001-repository-boundaries-and-ownership.md)
- [0002 Node Workspaces For Supporting Integrations](0002-node-workspaces-for-supporting-integrations.md)
