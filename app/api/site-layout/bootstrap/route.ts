import { readSiteLayouts, isLayoutPage, type LayoutRecord } from "../../../../lib/site-layout";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("page") || "/";
  const page = isLayoutPage(requested) ? requested : "/";
  let records: LayoutRecord[];
  try { records = await readSiteLayouts(page); } catch { records = []; }
  const payload = JSON.stringify({ version: 1, page, records }).replace(/</g, "\\u003c");
  const body = `(()=>{const p=${payload};window.__IHEAR_SITE_LAYOUT__=p;const c={hiddenSections:[],orders:{},links:{}};for(const r of p.records||[]){for(const k of r.config?.hiddenSections||[])c.hiddenSections.push(k);Object.assign(c.orders,r.config?.orders||{});Object.assign(c.links,r.config?.links||{})}let s=document.getElementById('ihear-layout-bootstrap-style');if(!s){s=document.createElement('style');s.id='ihear-layout-bootstrap-style';document.head.appendChild(s)}const q=x=>String(x).replace(/[^a-zA-Z0-9_.-]/g,'');let css=c.hiddenSections.map(k=>'[data-layout-section="'+q(k)+'"]{display:none!important}').join('');for(const [g,a] of Object.entries(c.orders))a.forEach((id,i)=>css+='[data-layout-group="'+q(g)+'"]>[data-layout-item="'+q(id)+'"]{order:'+i+'}');s.textContent=css})();`;
  return new Response(body, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" } });
}
