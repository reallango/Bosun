/**
 * Which commit an image tag in a container registry (the GitHub container registry by default) was built from: the
 * `org.opencontainers.image.revision` label the image workflow sets. Anonymous pull access (public images); the
 * Docker Registry v2 API with a bearer token from the registry's token service.
 */

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export class RegistryError extends Error {}

/** "ghcr.io/owner/bosun" -> { host, repo }. Only https registries with a host name. */
export function parseImage(image: string): { host: string; repo: string } {
  const m = /^([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)\/([a-z0-9._/-]+)$/.exec(image);
  if (!m) throw new RegistryError(`"${image}" is not an image name like ghcr.io/owner/bosun`);
  return { host: m[1], repo: m[2] };
}

async function token(host: string, repo: string): Promise<string | null> {
  const probe = await fetch(`https://${host}/v2/`, { signal: AbortSignal.timeout(15_000) });
  const challenge = probe.headers.get('www-authenticate') || '';
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
  if (!realm) return null;   // no auth needed
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  const url = new URL(realm);
  if (service) url.searchParams.set('service', service);
  url.searchParams.set('scope', `repository:${repo}:pull`);
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new RegistryError(`the registry refused anonymous access (${r.status}): is the package public?`);
  const j = await r.json() as { token?: string; access_token?: string };
  return j.token || j.access_token || null;
}

export async function imageRevision(image: string, tag: string): Promise<{ commit: string | null; digest: string | null }> {
  const { host, repo } = parseImage(image);
  const t = await token(host, repo);
  const auth: Record<string, string> = t ? { Authorization: `Bearer ${t}` } : {};
  const get = (path: string, accept = ACCEPT) => fetch(`https://${host}/v2/${repo}/${path}`, { headers: { ...auth, Accept: accept }, signal: AbortSignal.timeout(20_000) });
  let res = await get(`manifests/${encodeURIComponent(tag)}`);
  if (res.status === 404) return { commit: null, digest: null };
  if (!res.ok) throw new RegistryError(`the registry answered ${res.status} for ${image}:${tag}`);
  const digest = res.headers.get('docker-content-digest');
  let manifest = await res.json() as { manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[]; config?: { digest: string } };
  if (manifest.manifests) {
    const pick = manifest.manifests.find(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64') ?? manifest.manifests[0];
    if (!pick) return { commit: null, digest };
    res = await get(`manifests/${pick.digest}`);
    if (!res.ok) throw new RegistryError(`the registry answered ${res.status} for the linux/amd64 image`);
    manifest = await res.json();
  }
  if (!manifest.config?.digest) return { commit: null, digest };
  const blob = await get(`blobs/${manifest.config.digest}`, '*/*');
  if (!blob.ok) throw new RegistryError(`the registry answered ${blob.status} for the image configuration`);
  const cfg = await blob.json() as { config?: { Labels?: Record<string, string> } };
  const rev = cfg.config?.Labels?.['org.opencontainers.image.revision'] ?? null;
  return { commit: rev && /^[0-9a-f]{7,40}$/.test(rev) ? rev : null, digest };
}
