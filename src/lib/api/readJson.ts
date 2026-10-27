// Safe JSON response reader. Calling `res.json()` on a non-JSON (e.g. HTML)
// body throws an opaque `SyntaxError: Unexpected token '<' ...` that surfaced
// in the UI as "Data Unavailable". This checks the status and Content-Type
// first and raises a clear, human-readable error for anything that is not JSON.

export async function readJson<T>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  if (!isJson) {
    // Non-JSON error bodies (HTML error pages, empty 5xx, redirects to /login)
    // are the failure mode we are guarding against.
    if (!res.ok) {
      const snippet = await res.text().catch(() => '');
      const short = snippet.replace(/\s+/g, ' ').trim().substring(0, 80);
      throw new Error(
        short
          ? `Request failed (HTTP ${res.status}): ${short}`
          : `Request failed (HTTP ${res.status})`
      );
    }
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status})`);
  }

  return (await res.json()) as T;
}
