export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}
const pending = new Map<string, string>();
// Kept in this page's memory only. Reloading a Mini App authenticates through
// Telegram again; credentials are never written to local/session storage.
let sessionToken: string | null = null;
export function setSessionToken(value: string | null) {
  sessionToken = value;
}
export async function api(
  path: string,
  body?: any,
  method = "POST",
  mutation = true,
) {
  const fingerprint = method + path + JSON.stringify(body);
  let key = pending.get(fingerprint);
  if (body !== undefined && mutation && !key) {
    key = crypto.randomUUID();
    pending.set(fingerprint, key);
  }
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      method: body === undefined ? "GET" : method,
      headers: {
        "Content-Type": "application/json",
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ApiError(
      0,
      "Нет связи с сервером. Результат не подтверждён; повторите действие после восстановления связи.",
    );
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status < 500) pending.delete(fingerprint);
    throw new ApiError(response.status, data.error, data.details);
  }
  pending.delete(fingerprint);
  return data;
}
