import { NextResponse } from 'next/server';
import { authorizeAdminRequest } from '../../../lib/admin-auth';
import { listGalleries } from '../../../lib/media-gallery-store';
import { publicGalleries } from '../../../lib/media-gallery-public';
import { isGalleryId } from '../../../lib/media-gallery-types';
import { NO_STORE_HEADERS } from '../../../lib/response-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const admin = params.get('admin') === '1';
  if (admin) { const access = await authorizeAdminRequest(request); if ('response' in access) return access.response; }
  const gallery = params.get('gallery'), legacyFilter = params.get('gallery_id');
  const filter = gallery ?? legacyFilter;
  if (params.getAll('gallery').length > 1 || params.getAll('gallery_id').length > 1
    || (gallery !== null && legacyFilter !== null && gallery !== legacyFilter)
    || (filter !== null && !isGalleryId(filter))) {
    return NextResponse.json({ error: 'Unknown or ambiguous gallery filter' }, { status: 400, headers: NO_STORE_HEADERS });
  }
  try {
    const galleries = await listGalleries();
    return NextResponse.json({ items: await publicGalleries(filter === null ? galleries : galleries.filter(g => g.id === filter), admin) }, { headers: NO_STORE_HEADERS });
  }
  catch (error) { console.error('Gallery read failed', error); return NextResponse.json({ error: 'Could not load galleries' }, { status: 503, headers: NO_STORE_HEADERS }); }
}
