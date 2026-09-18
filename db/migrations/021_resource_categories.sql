-- Existing records remain forms; no content or publication state is rewritten.
ALTER TABLE public.resource_links
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'form'
  CHECK (category IN ('form', 'article'));

CREATE INDEX IF NOT EXISTS resource_links_category_order
  ON public.resource_links (category, status, sort_order, id);
