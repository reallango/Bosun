/* eslint-disable @typescript-eslint/no-explicit-any */
export interface QueryResult {
    columns: string[];
    types: string[];
    values: any[][];
}

export interface ExecuteResult {
    last_insert_id: string;
    rows_affected: number;
}

export interface NodeStatus {
    id: string;
    address: string;
    reachable: boolean;
    is_leader: boolean;
    follower?: string;
    leader?: string;
}

export interface ClusterStatus {
    node: string;
    address: string;
    is_leader: boolean;
    followers: NodeStatus[];
    raft_index: number;
}

/** A cluster node as reported by rqlite's /nodes. */
export interface ClusterNode {
    id: string;
    api_addr: string | null;
    addr: string;
    voter: boolean;
    reachable: boolean;
    leader: boolean;
    error?: string;
}

/**
 * Thrown for writes (and reads that cannot be served at all) while the cluster
 * has no leader, i.e. fewer than a majority of voting nodes are up.
 */
export class NoQuorumError extends Error {
    status = 503;
    code = 'NO_QUORUM';
    constructor(detail?: string) {
        super('The database cluster has no leader (not enough nodes are online), so changes cannot be saved right now.' +
            (detail ? ` (${detail.trim()})` : ''));
        this.name = 'NoQuorumError';
    }
}

const RQLITE_HTTP_PORT = process.env.RQLITE_HTTP_PORT || '4001';

/** Does an rqlite response mean "there is no leader to serve this"? */
export function isNoLeaderResponse(status: number, body: string): boolean {
    if (status === 503) return true;
    return /leader not found|not leader|no leader|ErrNotLeader|unavailable/i.test(body);
}

/**
 * rqlite HTTP client.
 *
 * Reads use rqlite's default (weak) consistency: on a follower they are
 * answered via the leader, so every node shows the same data. When the
 * cluster has no leader (lost quorum), a read is retried with level=none,
 * i.e. from this node's local copy, and the client is marked degraded: data
 * is readable but frozen at the moment quorum was lost. Writes always need a
 * leader and raise NoQuorumError in that state.
 */
export class RqliteClient {
    private baseUrl: string;
    private staleReadAt = 0;

    constructor() {
        this.baseUrl = `http://localhost:${RQLITE_HTTP_PORT}`;
    }

    /** True if a read in the last minute had to be served from the local (possibly stale) copy. */
    isDegraded(): boolean {
        return Date.now() - this.staleReadAt < 60_000;
    }

    private async post(path: string, body: unknown): Promise<{ status: number; text: string }> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        return { status: res.status, text: await res.text() };
    }

    async query(sql: string, params?: any[]): Promise<QueryResult> {
        // rqlite expects POST to /db/query with body: [[sql, p1, p2, ...]]
        const statement = params && params.length > 0 ? [sql, ...params] : [sql];
        let r = await this.post('/db/query', [statement]);
        let json: any = null;
        try { json = JSON.parse(r.text); } catch { /* handled below */ }
        const err = json?.results?.[0]?.error || json?.error || (r.status >= 300 ? r.text : '');
        if (err && isNoLeaderResponse(r.status, String(err))) {
            // No leader: serve from this node's local copy (stale but available).
            r = await this.post('/db/query?level=none', [statement]);
            try { json = JSON.parse(r.text); } catch { json = null; }
            this.staleReadAt = Date.now();
        }
        if (r.status >= 300 && !json) throw new Error(`rqlite query failed: ${r.status} ${r.text.slice(0, 200)}`);
        const result = json?.results?.[0];
        if (result?.error || json?.error) throw new Error(`rqlite query error: ${result?.error || json?.error}`);
        return {
            columns: result?.columns || [],
            types: result?.types || [],
            values: result?.values || [],
        };
    }

    private async executeRaw(body: unknown, transaction: boolean): Promise<any[]> {
        const r = await this.post(`/db/execute${transaction ? '?transaction' : ''}`, body);
        let json: any = null;
        try { json = JSON.parse(r.text); } catch { /* handled below */ }
        const err = json?.error || (json?.results || []).find((x: any) => x?.error)?.error || (r.status >= 300 ? r.text : '');
        if (err && isNoLeaderResponse(r.status, String(err))) throw new NoQuorumError(String(err).slice(0, 120));
        if (r.status >= 300) throw new Error(`rqlite execute failed: ${r.status} ${String(err).slice(0, 200)}`);
        if (json?.error) throw new Error(`rqlite execute error: ${json.error}`);
        return json?.results || [];
    }

    async execute(sql: string, params?: any[]): Promise<ExecuteResult> {
        const statement = params && params.length > 0 ? [sql, ...params] : [sql];
        const results = await this.executeRaw([statement], false);
        const result = results[0];
        if (result?.error) throw new Error(`rqlite execute error: ${result.error}`);
        return {
            last_insert_id: result?.last_insert_id || '',
            rows_affected: result?.rows_affected || 0,
        };
    }

    /**
     * Execute several statements in one request. With `transaction: true`
     * rqlite applies them atomically (all or nothing). Throws if any
     * statement reports an error.
     */
    async executeBatch(
        statements: { sql: string; params?: any[] }[],
        options: { transaction?: boolean } = {},
    ): Promise<ExecuteResult[]> {
        if (statements.length === 0) return [];
        // rqlite expects: [[sql1, p1], [sql2, p2], ...]
        const body = statements.map(s =>
            s.params && s.params.length > 0 ? [s.sql, ...s.params] : [s.sql]
        );
        const results = await this.executeRaw(body, !!options.transaction);
        const failed = results.findIndex((r: any) => r?.error);
        if (failed >= 0) {
            throw new Error(`rqlite batch error in statement ${failed + 1}: ${results[failed].error}`);
        }
        return results.map((r: any) => ({
            last_insert_id: r?.last_insert_id || '',
            rows_affected: r?.rows_affected || 0,
        }));
    }

    async getStatus(): Promise<any> {
        const res = await fetch(`${this.baseUrl}/status`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`rqlite status failed: ${res.status}`);
        return res.json();
    }

    /** Cluster membership with reachability, as seen from this node. */
    async getNodes(): Promise<ClusterNode[]> {
        const res = await fetch(`${this.baseUrl}/nodes?nonvoters&ver=2&timeout=2s`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`rqlite nodes failed: ${res.status}`);
        const json = await res.json();
        const list: any[] = Array.isArray(json?.nodes) ? json.nodes : Object.entries(json || {}).map(([id, n]: [string, any]) => ({ id, ...n }));
        return list.map(n => ({
            id: String(n.id),
            api_addr: n.api_addr || null,
            addr: n.addr || '',
            voter: n.voter !== false,
            reachable: !!n.reachable,
            leader: !!n.leader,
            error: n.error || undefined,
        }));
    }

    /** Is this node's rqlite up and serving with a known leader? */
    async isReady(): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/readyz`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
            return res.ok;
        } catch {
            return false;
        }
    }

    /** Is this node's rqlite process up (leader or not)? */
    async isUp(): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/readyz?noleader`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
            return res.ok;
        } catch {
            return false;
        }
    }

    // Hot backup of the underlying SQLite database (rqlite's recommended backup).
    async backup(): Promise<ArrayBuffer> {
        const res = await fetch(`${this.baseUrl}/db/backup`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`rqlite backup failed: ${res.status}`);
        return res.arrayBuffer();
    }

    // Load a SQLite file (application/octet-stream) or SQL dump (text/plain) into the node.
    async load(data: Uint8Array | string, contentType: string): Promise<void> {
        const res = await fetch(`${this.baseUrl}/db/load`, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': contentType },
            body: data as any,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`rqlite load failed: ${res.status} ${body}`);
        }
    }
}

// One client per server process (survives HMR in dev).
const g = globalThis as unknown as { __bosunRqlite?: RqliteClient };
export const rqlite: RqliteClient = g.__bosunRqlite ?? (g.__bosunRqlite = new RqliteClient());

export function rowsToObjects(result: QueryResult): Record<string, unknown>[] {
    if (!result.values || result.values.length === 0) return [];
    return result.values.map((row: unknown[]) => {
        const obj: Record<string, unknown> = {};
        result.columns.forEach((col: string, i: number) => {
            obj[col] = row[i];
        });
        return obj;
    });
}

/**
 * Is this a "cluster has no leader" error? Checks the code rather than
 * instanceof: the shared client lives on globalThis and may have been created
 * by another Next.js bundle with its own copy of the class.
 */
export function isNoQuorumError(err: unknown): err is NoQuorumError {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'NO_QUORUM';
}
