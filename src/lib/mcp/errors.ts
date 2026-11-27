/** Turn the REST API's error bodies into MCP tool errors, keeping the access-request hint. */

export interface RestError {
  message?: string;
  code?: string;
  permission?: string;
  resource?: unknown;
  request?: { endpoint?: string; body?: unknown };
}

export function toolErrorFromBody(body: unknown, fallback: string): string {
  const error = body && typeof body === 'object' ? (body as { error?: RestError }).error : undefined;
  const message = error?.message || fallback;
  if (!error?.request) return message;
  const endpoint = error.request.endpoint || 'POST /api/access-requests';
  const requestBody = error.request.body === undefined ? '' : `\n${JSON.stringify(error.request.body)}`;
  return `${message}\nTo request access, ${endpoint} with:${requestBody}`;
}

/** The same, for a NextResponse/Response returned by requirePermission or a route helper. */
export async function toolErrorFromResponse(response: Response, fallback: string): Promise<string> {
  try {
    return toolErrorFromBody(await response.json(), fallback);
  } catch {
    return fallback;
  }
}

/** A thrown error as a short tool error (no stack, no request headers). */
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}
