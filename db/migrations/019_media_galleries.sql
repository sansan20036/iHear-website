CREATE TABLE IF NOT EXISTS public.media_galleries (
  id TEXT PRIMARY KEY CHECK (id IN ('tutoring','outreach','home','stories','impact')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  items JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 20),
  updated_by TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.media_gallery_assets (
  slot TEXT PRIMARY KEY, payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS public.media_gallery_operations (
  id UUID PRIMARY KEY, gallery_id TEXT NOT NULL REFERENCES public.media_galleries(id),
  actor TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.media_galleries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_gallery_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_gallery_operations ENABLE ROW LEVEL SECURITY;

INSERT INTO public.media_galleries(id, items)
SELECT id, CASE WHEN id IN ('tutoring','outreach') THEN
  jsonb_build_array(jsonb_build_object('id','initial-' || id,'kind','photo','hidden',false,'assetSlot','services.' || id,'caption',jsonb_build_object('en','','zhHant','','zhHans','')))
  WHEN id = 'impact' THEN '[]'::jsonb ELSE
  jsonb_build_array(jsonb_build_object('id','initial-' || id,'kind','youtube','hidden',false,'videoId','LsQWwDBLKUc','caption',jsonb_build_object('en','','zhHant','','zhHans',''))) END
FROM unnest(ARRAY['tutoring','outreach','home','stories','impact']) AS ids(id)
ON CONFLICT (id) DO NOTHING;

CREATE TRIGGER media_galleries_live_revision AFTER INSERT OR UPDATE OR DELETE ON public.media_galleries
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('content');
