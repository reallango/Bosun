import { oauthNotSupported } from '@/lib/mcp/discovery';

export const dynamic = 'force-static';

/** OpenID Connect discovery: Bosun is not an identity provider. */
export function GET() {
  return oauthNotSupported();
}
