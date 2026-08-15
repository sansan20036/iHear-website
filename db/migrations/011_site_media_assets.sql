CREATE TABLE IF NOT EXISTS public.site_media_assets (
  slot TEXT PRIMARY KEY,
  alt_en TEXT NOT NULL,
  alt_zh_hant TEXT NOT NULL,
  alt_zh_hans TEXT NOT NULL,
  focal_x SMALLINT NOT NULL,
  focal_y SMALLINT NOT NULL,
  record_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL,
  CONSTRAINT site_media_assets_slot_length CHECK (char_length(slot) BETWEEN 1 AND 100),
  CONSTRAINT site_media_assets_alt_length CHECK (
    char_length(alt_en) BETWEEN 2 AND 300
    AND char_length(alt_zh_hant) BETWEEN 2 AND 300
    AND char_length(alt_zh_hans) BETWEEN 2 AND 300
  ),
  CONSTRAINT site_media_assets_focal_grid CHECK (
    focal_x IN (0, 50, 100) AND focal_y IN (0, 50, 100)
  ),
  CONSTRAINT site_media_assets_version_positive CHECK (record_version >= 1),
  CONSTRAINT site_media_assets_actor_length CHECK (
    char_length(created_by) BETWEEN 1 AND 320
    AND char_length(updated_by) BETWEEN 1 AND 320
  ),
  CONSTRAINT site_media_assets_timestamp_order CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS public.site_media_variants (
  slot TEXT NOT NULL,
  width INTEGER NOT NULL,
  pixel_width INTEGER NOT NULL,
  pixel_height INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  public_url TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  CONSTRAINT site_media_variants_pkey PRIMARY KEY (slot, width),
  CONSTRAINT site_media_variants_slot_fkey FOREIGN KEY (slot)
    REFERENCES public.site_media_assets(slot) ON DELETE CASCADE,
  CONSTRAINT site_media_variants_width_allowed CHECK (width IN (480, 800, 1200)),
  CONSTRAINT site_media_variants_dimensions_positive CHECK (
    pixel_width > 0 AND pixel_height > 0
  ),
  CONSTRAINT site_media_variants_byte_size_range CHECK (byte_size BETWEEN 1 AND 1048576),
  CONSTRAINT site_media_variants_mime_webp CHECK (mime_type = 'image/webp'),
  CONSTRAINT site_media_variants_public_url_https CHECK (public_url LIKE 'https://%'),
  CONSTRAINT site_media_variants_storage_path_length CHECK (
    char_length(storage_path) BETWEEN 1 AND 500
  ),
  CONSTRAINT site_media_variants_storage_path_unique UNIQUE (storage_path)
);

CREATE INDEX IF NOT EXISTS site_media_assets_updated_at_idx
  ON public.site_media_assets (updated_at DESC);

ALTER TABLE public.site_media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_media_variants ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS site_media_assets_live_revision ON public.site_media_assets;
CREATE TRIGGER site_media_assets_live_revision
AFTER INSERT OR UPDATE OR DELETE ON public.site_media_assets
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('content');
