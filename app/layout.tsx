import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "iHear Initiative",
  icons: { icon: "/favicon.ico" },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const themeInit = `(function(){var a={warm:1,ocean:1,sage:1,lavender:1,slate:1},t="warm";try{var s=localStorage.getItem("ihear:site-theme");if(a[s])t=s}catch(e){}document.documentElement.setAttribute("data-theme",t)})()`;
  return (
    <html lang="en" data-theme="warm" suppressHydrationWarning>
      <head>
        <script data-site-theme-init dangerouslySetInnerHTML={{ __html: themeInit }} />
        {/* This must remain parser-blocking so the published theme wins before first paint. */}
        <script src="/api/site-theme/bootstrap" data-site-theme-bootstrap="" />
        <link rel="stylesheet" href="/assets/theme.css?v=20260823-content-layout-v1" />
        <link rel="stylesheet" href="/assets/site.css?v=20260827-admin-avatar-menu-v1" />
      </head>
      <body style={{ margin: 0 }}>
        {children}
        <script src="/assets/site.js?v=20260823-content-layout-v1" defer />
        <script src="/assets/auth.js?v=20260827-admin-avatar-menu-v1" defer />
        <script src="/assets/live-content.js?v=20260823-content-layout-v1" defer />
        <script src="/assets/site-theme.js?v=20260823-content-layout-v1" defer />
        <script src="/assets/site-layout.js?v=20260823-content-layout-v1" defer />
        <script src="/assets/inline-edit.js?v=20260823-content-layout-v1" defer />
        <script src="/assets/avatar-cropper.js?v=20260825-avatar-crop-v1" defer />
      </body>
    </html>
  );
}
