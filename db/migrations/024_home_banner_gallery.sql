-- The runner wraps this upgrade in a transaction. Replace only the id check
-- created by migration 019; retain the existing version/items checks and rows.
ALTER TABLE public.media_galleries
  DROP CONSTRAINT media_galleries_id_check,
  ADD CONSTRAINT media_galleries_id_check
    CHECK (id IN ('tutoring','outreach','home','stories','impact','home-banner'));

-- Titles are optional nullable fields inside each existing items JSONB object:
-- { "title": { "en": "...", "zhHant": "...", "zhHans": "..." } } or null.
-- Do not backfill old items: missing titles are normalized only when read.
-- Seed once, by row absence. A saved empty items array must never be reseeded.
INSERT INTO public.media_galleries(id, items)
VALUES ('home-banner', jsonb_build_array(jsonb_build_object(
  'id', 'initial-home-banner',
  'kind', 'photo',
  'hidden', false,
  'assetSlot', 'home.hero',
  'caption', jsonb_build_object('en','','zhHant','','zhHans',''),
  'title', NULL
)))
ON CONFLICT (id) DO NOTHING;
