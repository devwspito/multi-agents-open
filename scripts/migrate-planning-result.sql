-- Migration: Add planning_result column to tasks table
-- Purpose: Store structured planning data (UX flows, planned tasks, clarifications) for ML training
-- Run with: psql -U oma -d open_multi_agents -f scripts/migrate-planning-result.sql

-- Add planning_result JSONB column
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS planning_result JSONB;

-- Create index for querying planning data
CREATE INDEX IF NOT EXISTS idx_tasks_planning_result ON tasks USING GIN (planning_result);

-- Add comment for documentation
COMMENT ON COLUMN tasks.planning_result IS 'Structured planning data from ProductPlanningPhase including UX flows, planned tasks, and clarifications';

-- Verify migration
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'tasks'
AND column_name = 'planning_result';
