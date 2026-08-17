import { readSiteTheme } from "../../../../lib/site-theme-store";
import { publicSiteThemeSetting } from "../../../../lib/site-theme-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function script(state: { theme: string; recordVersion: number; updatedAt: string }) {
  const payload = JSON.stringify(state).replace(/</g, "\\u003c");
  return `(()=>{const s=${payload};document.documentElement.dataset.theme=s.theme;window.__IHEAR_SITE_THEME__=s;try{localStorage.setItem("ihear:site-theme",s.theme)}catch{}})();`;
}

function fallbackScript() {
  return `(()=>{const a=new Set(["warm","ocean","sage","lavender","slate"]);let t=document.documentElement.dataset.theme;try{const s=localStorage.getItem("ihear:site-theme");if(a.has(s))t=s}catch{}if(!a.has(t))t="warm";const s={theme:t,recordVersion:1,updatedAt:""};document.documentElement.dataset.theme=t;window.__IHEAR_SITE_THEME__=s;})();`;
}

export async function GET() {
  try {
    const state = publicSiteThemeSetting(await readSiteTheme());
    return new Response(script(state), {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Site theme bootstrap fallback", error);
    return new Response(fallbackScript(), {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    });
  }
}
