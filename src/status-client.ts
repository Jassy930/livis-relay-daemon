export const DEFAULT_STATUS_TIMEOUT_MS = 3_000;

export type DaemonStatusFetch = (
  input: string | URL | Request,
  init: RequestInit & { unix: string },
) => Promise<Response>;

export async function fetchDaemonStatus(
  socketPath: string,
  connectorToken: string,
  options: {
    timeoutMs?: number;
    fetchImpl?: DaemonStatusFetch;
  } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as DaemonStatusFetch);
  return fetchImpl("http://localhost/v1/status", {
    unix: socketPath,
    headers: { Authorization: `Bearer ${connectorToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
}
