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
  // Keep /academy as the CMS introduction. Visitors explicitly follow its
  // course button to these standalone pages on the same Vercel website.
  async rewrites() {
    return [
      { source: "/academy/courses", destination: "/academy/courses/index.html" },
      { source: "/academy/courses/zh", destination: "/academy/courses/zh/index.html" },
    ];
  },
};

export default nextConfig;
