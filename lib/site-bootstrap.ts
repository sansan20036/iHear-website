import { isLayoutPage, readSiteLayouts, type LayoutRecord } from "./site-layout";
import { readSiteTheme } from "./site-theme-store";
import { publicSiteThemeSetting, type PublicSiteThemeSetting } from "./site-theme-types";

// The site theme and page layout scripts that must run before the first paint. Public pages carry
// them inline, so nothing has to wait for another request before the page shows; the
// /api/site-theme/bootstrap and /api/site-layout/bootstrap routes serve the same text to the React
// pages and to any older copy of a page that still links them.

/** JSON that can sit inside a <script>: "</script>", "<!--" and line separators cannot end or break it. */
export function scriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function themeBootstrapScript(state: PublicSiteThemeSetting) {
  return `(()=>{const s=${scriptJson(state)};document.documentElement.dataset.theme=s.theme;window.__IHEAR_SITE_THEME__=s;try{localStorage.setItem("ihear:site-theme",s.theme)}catch{}})();`;
}

/** No stored theme to read: keep this browser's valid last-known theme, otherwise warm. */
export function themeFallbackScript() {
  return `(()=>{const a=new Set(["warm","ocean","sage","lavender","slate"]);let t=document.documentElement.dataset.theme;try{const s=localStorage.getItem("ihear:site-theme");if(a.has(s))t=s}catch{}if(!a.has(t))t="warm";const s={theme:t,recordVersion:1,updatedAt:""};document.documentElement.dataset.theme=t;window.__IHEAR_SITE_THEME__=s;})();`;
}

/** Never throws: an unreadable theme gives the fallback script, as the bootstrap route always has. */
export async function readThemeBootstrap() {
  try {
    return themeBootstrapScript(publicSiteThemeSetting(await readSiteTheme()));
  } catch (error) {
    console.error("Site theme bootstrap fallback", error);
    return themeFallbackScript();
  }
}

/** A page without layout settings of its own is given the home page's, as the bootstrap route does. */
export function layoutBootstrapPage(requested: string) {
  return isLayoutPage(requested) ? requested : "/";
}

export function layoutBootstrapScript(page: string, records: LayoutRecord[]) {
  return `(()=>{const p=${scriptJson({ version: 1, page, records })};window.__IHEAR_SITE_LAYOUT__=p;const c={hiddenSections:[],orders:{},links:{}};for(const r of p.records||[]){for(const k of r.config?.hiddenSections||[])c.hiddenSections.push(k);Object.assign(c.orders,r.config?.orders||{});Object.assign(c.links,r.config?.links||{})}let s=document.getElementById('ihear-layout-bootstrap-style');if(!s){s=document.createElement('style');s.id='ihear-layout-bootstrap-style';document.head.appendChild(s)}const q=x=>String(x).replace(/[^a-zA-Z0-9_.-]/g,'');let css=c.hiddenSections.map(k=>'[data-layout-section="'+q(k)+'"]{display:none!important}').join('');for(const [g,a] of Object.entries(c.orders))a.forEach((id,i)=>css+='[data-layout-group="'+q(g)+'"]>[data-layout-item="'+q(id)+'"]{order:'+i+'}');s.textContent=css})();`;
}

/** Never throws: unreadable layouts give no layout changes, as the bootstrap route always has. */
export async function readLayoutBootstrap(requested: string) {
  const page = layoutBootstrapPage(requested);
  let records: LayoutRecord[];
  try { records = await readSiteLayouts(page); } catch { records = []; }
  return layoutBootstrapScript(page, records);
}

// The exact tags scripts/prepare-public.mjs writes into every public-page template.
const THEME_TAG = /<script src="\/api\/site-theme\/bootstrap" data-site-theme-bootstrap><\/script>/;
const LAYOUT_TAG = /<script src="\/api\/site-layout\/bootstrap\?page=([^"]*)" data-site-layout-bootstrap><\/script>/;

/** The page a template's layout tag asks for, or null if the template has no such tag. */
export function templateLayoutPage(html: string) {
  const match = LAYOUT_TAG.exec(html);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

/**
 * Put the two scripts in place of their tags, keeping the order the build checks. A null script, or
 * a template without the tag, leaves that tag as it is, so the browser still asks the route.
 */
export function inlineSiteBootstraps(html: string, scripts: { theme: string | null; layout: string | null }) {
  let result = html;
  // Replacer functions: the scripts are inserted literally, whatever "$" sequences they contain.
  if (scripts.theme !== null) result = result.replace(THEME_TAG, () => `<script data-site-theme-bootstrap>${scripts.theme}</script>`);
  if (scripts.layout !== null) result = result.replace(LAYOUT_TAG, () => `<script data-site-layout-bootstrap>${scripts.layout}</script>`);
  return result;
}
