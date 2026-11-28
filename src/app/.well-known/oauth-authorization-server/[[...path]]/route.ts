import { oauthNotSupported } from '@/lib/mcp/discovery';

export const dynamic = 'force-static';

/** RFC 8414 authorization-server metadata, including the path-suffixed forms clients try. */
export function GET() {
  return oauthNotSupported();
}
