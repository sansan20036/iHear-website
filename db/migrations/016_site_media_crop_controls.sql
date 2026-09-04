ALTER TABLE public.site_media_assets
  ADD COLUMN IF NOT EXISTS zoom SMALLINT NOT NULL DEFAULT 100;

ALTER TABLE public.site_media_assets
  DROP CONSTRAINT IF EXISTS site_media_assets_focal_grid;

ALTER TABLE public.site_media_assets
  DROP CONSTRAINT IF EXISTS site_media_assets_focal_range;

ALTER TABLE public.site_media_assets
  ADD CONSTRAINT site_media_assets_focal_range
  CHECK (focal_x BETWEEN 0 AND 100 AND focal_y BETWEEN 0 AND 100);

ALTER TABLE public.site_media_assets
  DROP CONSTRAINT IF EXISTS site_media_assets_zoom_range;

ALTER TABLE public.site_media_assets
  ADD CONSTRAINT site_media_assets_zoom_range
  CHECK (zoom BETWEEN 100 AND 250);
