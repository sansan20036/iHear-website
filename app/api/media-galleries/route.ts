import { NextResponse } from 'next/server';
import { authorizeAdminRequest } from '../../../lib/admin-auth';
import { listGalleries } from '../../../lib/media-gallery-store';
import { publicGalleries } from '../../../lib/media-gallery-public';
import { NO_STORE_HEADERS } from '../../../lib/response-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  const admin = new URL(request.url).searchParams.get('admin') === '1';
  if (admin) { const access = await authorizeAdminRequest(request); if ('response' in access) return access.response; }
  try { return NextResponse.json({ items: await publicGalleries(await listGalleries(), admin) }, { headers: NO_STORE_HEADERS }); }
  catch (error) { console.error('Gallery read failed', error); return NextResponse.json({ error: 'Could not load galleries' }, { status: 503, headers: NO_STORE_HEADERS }); }
}
