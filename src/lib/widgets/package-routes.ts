/**
 * Shared pieces of the widget package routes: the access check, the configured source branch,
 * and the listing shape the management page shows.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { TokenPayload } from '@/lib/auth/jwt';
import { requireUserLevel, clientIp } from '@/lib/auth/middleware';
import { getConfig } from '@/lib/db/migrations';
import { DEFAULT_REF, isAllowedRef, type SourceRef } from '@/lib/widgets/package-source';
import { systemPackages } from '@/lib/widgets/system-packages';
import { listInstalledPackages } from '@/lib/widgets/package-store';

/**
 * Managing widget packages changes what code-defined widgets, actions and permissions the
 * host exposes, so it is Full access (admin), signed-in users only: API keys are refused.
 */
export async function requirePackageAdmin(request: NextRequest): Promise<TokenPayload | NextResponse> {
  return requireUserLevel(request, 'admin');
}

export const requestIp = (request: NextRequest) => clientIp(request) ?? undefined;

export async function configuredRef(): Promise<SourceRef> {
  const v = await getConfig('widgets.source_ref');
  return isAllowedRef(v) ? v : DEFAULT_REF;
}

export interface PackageListItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  system: boolean;
  source: 'system' | 'github' | 'upload' | 'bundled';
  sourceRef: string | null;
  widgetTypes: string[];
  permissions: string[];
  installedAt: string | null;
  /** Secrets the package declares (never their values). */
  secrets: { id: string; label: string; description: string }[];
}

/** System widgets first (built in, non-upgradable), then installed packages. */
export async function listAllInstalled(): Promise<PackageListItem[]> {
  const system: PackageListItem[] = systemPackages().map(p => ({
    id: p.id, name: p.name, version: p.version, description: p.description, author: 'Bosun', system: true, source: 'system',
    sourceRef: null, widgetTypes: p.widgetTypes, permissions: p.permissions, installedAt: null, secrets: [],
  }));
  const installed: PackageListItem[] = (await listInstalledPackages()).map(p => ({
    id: p.id, name: p.name, version: p.version, description: p.description, author: p.author, system: false, source: p.source,
    sourceRef: p.sourceRef, widgetTypes: p.widgetTypes, permissions: p.permissions, installedAt: p.installedAt, secrets: p.manifest.secrets,
  }));
  return [...system, ...installed];
}
