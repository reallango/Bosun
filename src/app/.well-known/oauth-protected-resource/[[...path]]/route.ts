import { oauthNotSupported } from '@/lib/mcp/discovery';

export const dynamic = 'force-static';

/** RFC 9728 protected-resource metadata, also requested for a specific resource (/.well-known/oauth-protected-resource/api/mcp). */
export function GET() {
  return oauthNotSupported();
}
