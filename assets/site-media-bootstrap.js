(function () {
  "use strict";
  document.documentElement.classList.add("site-media-loading");
  // Start the authoritative lookup before the blocking theme/layout scripts.
  // Reuse only this navigation's response; never show a previous page's data.
  window.iHearInitialSiteMedia = fetch("/api/site-media", {
    credentials: "same-origin", cache: "no-store",
  }).then((response) => {
    if (!response.ok) throw new Error("site media unavailable");
    return response.json();
  }).then((data) => {
    // Banner SSR already prioritizes its first photo. Keep the legacy preload
    // only on pages without that snapshot; the intro photo is now below it.
    if ((location.pathname === "/" || location.pathname === "/index.html") && !document.getElementById("ihear-home-banner")) {
      const hero = data?.items?.["home.hero"];
      if (hero?.src && hero.srcSet) {
        const link = document.createElement("link");
        link.rel = "preload";
        link.as = "image";
        link.href = hero.src;
        link.imageSrcset = hero.srcSet;
        link.imageSizes = "(max-width: 900px) calc(100vw - 48px), 520px";
        link.fetchPriority = "high";
        document.head.appendChild(link);
      }
    }
    return data;
  }).catch(() => null);
})();
