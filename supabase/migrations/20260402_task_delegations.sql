-- ============================================================================
-- Phase 8: Multi-Worker Collaboration — task_delegations
-- ============================================================================
-- Supports three collaboration patterns:
--   1. Sequential handoff:  Planning → Risk → Procurement
--   2. Parallel fan-out:    Same event → multiple workers analyze in parallel
--   3. Escalation:          Low-level worker → coordinator/senior worker
-- ============================================================================

-- ── task_delegations ────────────────────────────────────────────────────────

create table if not exists public.task_delegations (
  id              uuid primary key default gen_random_uuid(),
  parent_task_id  uuid not null,
  parent_worker_id uuid not null,
  child_task_id   uuid,
  child_worker_id uuid not null,
  delegation_type text not null check (delegation_type in ('handoff', 'fan_out', 'escalation')),
  sequence_order  int default 0,        -- for sequential handoff ordering
  context_json    jsonb default '{}'::jsonb,
  status          text not null default 'pending'
                  check (status in ('pending', 'active', 'completed', 'failed', 'cancelled', 'skipped')),
  result_json     jsonb,                -- child task result summary
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Indexes
create index if not exists idx_delegations_parent_task  on public.task_delegations (parent_task_id);
create index if not exists idx_delegations_child_task   on public.task_delegations (child_task_id);
create index if not exists idx_delegations_parent_worker on public.task_delegations (parent_worker_id);
create index if not exists idx_delegations_type_status  on public.task_delegations (delegation_type, status);

-- RLS
alter table public.task_delegations enable row level security;

create policy "Authenticated users can read delegations"
  on public.task_delegations for select
  to authenticated
  using (true);

create policy "Authenticated users can insert delegations"
  on public.task_delegations for insert
  to authenticated
  with check (true);

create policy "Authenticated users can update delegations"
  on public.task_delegations for update
  to authenticated
  using (true);

-- ── delegation_templates ────────────────────────────────────────────────────
-- Pre-defined delegation chains (e.g., Planning → Risk → Procurement)

create table if not exists public.delegation_templates (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  description     text,
  delegation_type text not null check (delegation_type in ('handoff', 'fan_out', 'escalation')),
  worker_chain    jsonb not null default '[]'::jsonb,  -- ordered list of worker_ids
  trigger_conditions jsonb default '{}'::jsonb,         -- when to auto-trigger
  enabled         boolean not null default true,
  created_at      timestamptz not null default now()
);

-- Seed default templates
insert into public.delegation_templates (name, description, delegation_type, worker_chain) values
  ('planning_to_procurement',
   'Sequential: Planning Worker → Risk Assessment → Procurement Execution',
   'handoff',
   '["planning_worker", "risk_worker", "procurement_worker"]'::jsonb),
  ('parallel_demand_analysis',
   'Fan-out: Demand spike → Planning + Risk + Finance analyze in parallel',
   'fan_out',
   '["planning_worker", "risk_worker", "finance_worker"]'::jsonb),
  ('escalate_to_coordinator',
   'Escalation: Any worker → Senior Coordinator when confidence < threshold',
   'escalation',
   '["coordinator_worker"]'::jsonb)
on conflict (name) do nothing;

-- ── Updated timestamp trigger ───────────────────────────────────────────────

create or replace function update_delegation_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_delegation_updated_at
  before update on public.task_delegations
  for each row execute function update_delegation_updated_at();
