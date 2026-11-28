/**
 * MCP/OAuth discovery probes (/.well-known/oauth-*, /.well-known/openid-configuration).
 *
 * When an MCP client gets a 401 it asks for the protected-resource and authorization-server metadata. Bosun's MCP
 * endpoint is authenticated with a static API key, so there is nothing to discover: these paths answer a JSON 404
 * instead of the sign-in redirect, which a client would try to parse as JSON ("Unrecognized token '<'").
 */
import { NextResponse } from 'next/server';

export const OAUTH_NOT_SUPPORTED_DESCRIPTION =
  "Bosun's MCP endpoint uses a static API key (Authorization: Bearer <key>); OAuth is not offered.";

export function oauthNotSupported(): NextResponse {
  return NextResponse.json(
    { error: 'not_supported', error_description: OAUTH_NOT_SUPPORTED_DESCRIPTION },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  );
}
