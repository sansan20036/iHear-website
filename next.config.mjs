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
      ...htmlRoutes.map(([source, destination]) => ({
        source: `/${destination}`,
        destination: `/${source}`,
        permanent: true,
      })),
    ];
  },
};

export default nextConfig;
