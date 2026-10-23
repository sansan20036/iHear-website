const htmlRoutes = [
  ["about", "about.html"],
  ["programs", "programs.html"],
  ["impact", "impact.html"],
  ["submit-bio", "submit-bio.html"],
  ["stories", "stories.html"],
  ["get-involved", "get-involved.html"],
  ["academy", "academy.html"],
  ["donate", "donate.html"],
  ["resources", "resources.html"],
  ["faq", "faq.html"],
  ["contact", "contact.html"],
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Sharp loads its platform-specific libvips package dynamically. Include the
  // installed @img runtime files in media API functions so Vercel's output
  // tracing cannot omit the Linux shared library.
  outputFileTracingIncludes: {
    "/": ["./.private/index.html"],
    "/[publicPage]": ["./.private/*.html"],
    "/team": ["./.private/team.html"],
    "/academy/courses": ["./.private/academy/index.html"],
    "/academy/courses/zh": ["./.private/academy/zh/index.html"],
    "/api/academy-content/preview": ["./.private/academy/index.html", "./.private/academy/zh/index.html"],
    "/api/site-media/[slot]": ["./node_modules/@img/**/*"],
    "/api/media-galleries/[id]": ["./node_modules/@img/**/*"],
  },
  async redirects() {
    return [
      { source: "/index.html", destination: "/", permanent: true },
      { source: "/academy/index.html", destination: "/academy", permanent: true },
      { source: "/academy/en", destination: "/academy/courses?entry=official", permanent: false },
      { source: "/academy/en/index.html", destination: "/academy/courses?entry=official", permanent: false },
      { source: "/academy/courses/index.html", destination: "/academy/courses?entry=official", permanent: true },
      { source: "/academy/courses/zh/index.html", destination: "/academy/courses/zh?entry=official", permanent: true },
      ...htmlRoutes.map(([source, destination]) => ({
        source: `/${destination}`,
        destination: `/${source}`,
        permanent: true,
      })),
    ];
  },
  // Course HTML is served by request-time routes that read the published Academy
  // content; /academy remains the separate CMS introduction. No static HTML
  // rewrite may bypass the published prices.
};

export default nextConfig;
