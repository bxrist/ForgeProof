/** Never log response bodies, credentials, query strings or concrete tenant IDs. */
export function requestLogLine(
  request: { method: string; route?: { path?: unknown } },
  status: number,
  duration: number,
): string {
  const route = typeof request.route?.path === "string" ? request.route.path : "(unmatched API route)";
  return `${request.method} ${route} ${status} in ${duration}ms`;
}
