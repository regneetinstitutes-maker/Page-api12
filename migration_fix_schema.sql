-- Migration: Fix competition schema - move config from schedules to modes
-- This script converts the stale database schema to match the final Drizzle schema
-- Before running: BACKUP YOUR DATABASE!

BEGIN TRANSACTION;

-- Step 1: Add missing config columns to competition_modes
ALTER TABLE "competition_modes" ADD COLUMN IF NOT EXISTS "type" "competition_type";
ALTER TABLE "competition_modes" ADD COLUMN IF NOT EXISTS "entry_fee" integer;
ALTER TABLE "competition_modes" ADD COLUMN IF NOT EXISTS "max_participants" integer;
ALTER TABLE "competition_modes" ADD COLUMN IF NOT EXISTS "team_size" integer DEFAULT 1;
ALTER TABLE "competition_modes" ADD COLUMN IF NOT EXISTS "prizes" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE "competition_modes" ADD COLUMN IF NOT EXISTS "tournament_metric" text;

-- Step 2: Populate config columns in competition_modes from competition_schedules
-- This assumes one mode per schedule (or uses the first/most recent schedule's config)
UPDATE "competition_modes" m
SET 
  "type" = COALESCE(
    (SELECT "type" FROM "competition_schedules" cs WHERE cs."mode_id" = m."id" LIMIT 1),
    'omb'::competition_type
  ),
  "entry_fee" = COALESCE(
    (SELECT "entry_fee" FROM "competition_schedules" cs WHERE cs."mode_id" = m."id" LIMIT 1),
    50
  ),
  "max_participants" = COALESCE(
    (SELECT "max_participants" FROM "competition_schedules" cs WHERE cs."mode_id" = m."id" LIMIT 1),
    2
  ),
  "team_size" = COALESCE(
    (SELECT "team_size" FROM "competition_schedules" cs WHERE cs."mode_id" = m."id" LIMIT 1),
    1
  ),
  "prizes" = COALESCE(
    (SELECT "prizes" FROM "competition_schedules" cs WHERE cs."mode_id" = m."id" LIMIT 1),
    '[]'::jsonb
  ),
  "tournament_metric" = 
    (SELECT "tournament_metric" FROM "competition_schedules" cs WHERE cs."mode_id" = m."id" LIMIT 1)
WHERE "type" IS NULL;

-- Step 3: Make new columns in competition_modes NOT NULL with proper constraints
ALTER TABLE "competition_modes" ALTER COLUMN "type" SET NOT NULL;
ALTER TABLE "competition_modes" ALTER COLUMN "entry_fee" SET NOT NULL;
ALTER TABLE "competition_modes" ALTER COLUMN "max_participants" SET NOT NULL;

-- Step 4: Add CHECK constraints to competition_modes if they do not already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public."competition_modes"'::regclass
      AND conname = 'competition_modes_entry_fee_positive'
  ) THEN
    ALTER TABLE "competition_modes"
      ADD CONSTRAINT "competition_modes_entry_fee_positive"
      CHECK ("entry_fee" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public."competition_modes"'::regclass
      AND conname = 'competition_modes_max_participants_positive'
  ) THEN
    ALTER TABLE "competition_modes"
      ADD CONSTRAINT "competition_modes_max_participants_positive"
      CHECK ("max_participants" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public."competition_modes"'::regclass
      AND conname = 'competition_modes_team_size_positive'
  ) THEN
    ALTER TABLE "competition_modes"
      ADD CONSTRAINT "competition_modes_team_size_positive"
      CHECK ("team_size" > 0);
  END IF;
END $$;

-- Step 5: Create unique index on (game_id, name) if it doesn't exist
CREATE UNIQUE INDEX IF NOT EXISTS "competition_modes_game_name_unique" 
  ON "competition_modes" ("game_id", "name");

-- Step 6: Add index for mode lookups
CREATE INDEX IF NOT EXISTS "competition_modes_game_type_idx" 
  ON "competition_modes" ("game_id", "type");

-- Step 7: Remove old config columns from competition_schedules
-- First, drop foreign key constraints if any reference these columns
ALTER TABLE "competition_schedules" DROP CONSTRAINT IF EXISTS "competition_schedules_entry_fee_positive";
ALTER TABLE "competition_schedules" DROP CONSTRAINT IF EXISTS "competition_schedules_max_participants_positive";
ALTER TABLE "competition_schedules" DROP CONSTRAINT IF EXISTS "competition_schedules_team_size_positive";

-- Drop the old columns
ALTER TABLE "competition_schedules" DROP COLUMN IF EXISTS "type" CASCADE;
ALTER TABLE "competition_schedules" DROP COLUMN IF EXISTS "entry_fee" CASCADE;
ALTER TABLE "competition_schedules" DROP COLUMN IF EXISTS "max_participants" CASCADE;
ALTER TABLE "competition_schedules" DROP COLUMN IF EXISTS "team_size" CASCADE;
ALTER TABLE "competition_schedules" DROP COLUMN IF EXISTS "prizes" CASCADE;
ALTER TABLE "competition_schedules" DROP COLUMN IF EXISTS "tournament_metric" CASCADE;

-- Step 8: Ensure competition_schedules has the correct timing columns and indices
-- These should already exist, but verify they're present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public."competition_schedules"'::regclass
      AND conname = 'competition_schedules_result_deadline_positive'
  ) THEN
    ALTER TABLE "competition_schedules"
      ADD CONSTRAINT "competition_schedules_result_deadline_positive"
      CHECK ("result_deadline_minutes" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public."competition_schedules"'::regclass
      AND conname = 'competition_schedules_manager_alert_nonnegative'
  ) THEN
    ALTER TABLE "competition_schedules"
      ADD CONSTRAINT "competition_schedules_manager_alert_nonnegative"
      CHECK ("manager_alert_after_minutes" >= 0);
  END IF;
END $$;

-- Create index for schedule queries
CREATE INDEX IF NOT EXISTS "competition_schedules_mode_status_idx" 
  ON "competition_schedules" ("mode_id", "status");

-- Step 9: Refresh updated_at timestamps
UPDATE "competition_modes" SET "updated_at" = now() WHERE "updated_at" < now();
UPDATE "competition_schedules" SET "updated_at" = now() WHERE "updated_at" < now();

COMMIT;

-- Verification queries (run after migration):
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name='competition_modes' ORDER BY column_name;
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name='competition_schedules' ORDER BY column_name;
