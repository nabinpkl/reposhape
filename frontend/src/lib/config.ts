/**
 * Every environment-dependent value the browser needs.
 *
 * The API is same-origin: Next rewrites `/api/*` to FastAPI (see next.config),
 * so the browser never learns the backend's port and no CORS preflight exists.
 */
export const config = {
  apiOrigin: "",
} as const;
