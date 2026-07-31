import { withSentryConfig } from "@sentry/nextjs";

const htmlRoutes = [
  ["about", "about.html"],
  ["programs", "programs.html"],
  ["impact", "impact.html"],
  ["team", "team.html"],
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
  async rewrites() {
    return [
      { source: "/", destination: "/index.html" },
      ...htmlRoutes.map(([source, destination]) => ({
        source: `/${source}`,
        destination: `/${destination}`,
      })),
    ];
  },
};

export default withSentryConfig(nextConfig, {
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true,
  telemetry: false,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
});
