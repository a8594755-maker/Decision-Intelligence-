-- Patch: add missing brief fields + pin_order to analysis_snapshots

-- #1: Store implications, caveats, next_steps from AgentBrief
ALTER TABLE analysis_snapshots ADD COLUMN IF NOT EXISTS implications  jsonb DEFAULT '[]';
ALTER TABLE analysis_snapshots ADD COLUMN IF NOT EXISTS caveats       jsonb DEFAULT '[]';
ALTER TABLE analysis_snapshots ADD COLUMN IF NOT EXISTS next_steps    jsonb DEFAULT '[]';

-- #7: Support user-defined pin ordering
ALTER TABLE analysis_snapshots ADD COLUMN IF NOT EXISTS pin_order     int DEFAULT 0;
