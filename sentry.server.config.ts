import * as Sentry from "@sentry/nextjs";

function tracesSampleRate() {
  const configured = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.05");
  return Number.isFinite(configured) && configured >= 0 && configured <= 1
    ? configured
    : 0.05;
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
  sendDefaultPii: false,
  tracesSampleRate: tracesSampleRate(),
  beforeSend(event) {
    if (event.user) {
      delete event.user.email;
      delete event.user.ip_address;
      delete event.user.username;
    }

    if (event.request) {
      delete event.request.cookies;
      delete event.request.query_string;
      if (event.request.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.Authorization;
        delete event.request.headers.cookie;
        delete event.request.headers.Cookie;
      }
    }

    return event;
  },
});
