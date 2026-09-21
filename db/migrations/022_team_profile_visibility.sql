-- Additive only: existing placements remain visible; drafts/trash stay unpublished.
ALTER TABLE public.team_profiles
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
