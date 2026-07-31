import * as Sentry from "@sentry/nextjs";

type ErrorContext = {
  route: string;
  operation: string;
  requestId?: string;
};

export function captureServerException(error: unknown, context: ErrorContext) {
  if (!process.env.SENTRY_DSN) return;

  Sentry.withScope((scope) => {
    scope.setLevel("error");
    scope.setTag("ihear.route", context.route);
    scope.setTag("ihear.operation", context.operation);
    if (context.requestId) scope.setTag("ihear.request_id", context.requestId);
    Sentry.captureException(error);
  });
}
