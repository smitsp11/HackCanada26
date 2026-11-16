/**
 * Auth header for proxy routes calling the backend.
 *
 * Server-only. The token authenticates this Next.js server to the backend and
 * must never reach the browser, so it is read from BACKEND_API_TOKEN - without
 * a NEXT_PUBLIC_ prefix, which would inline it into the client bundle.
 */
export function backendAuthHeaders(): Record<string, string> {
  const token = process.env.BACKEND_API_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
