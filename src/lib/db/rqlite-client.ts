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


const RQLITE_HTTP_PORT = process.env.RQLITE_HTTP_PORT || '4001';


export class RqliteClient {
    private baseUrl: string;


    constructor() {
        this.baseUrl = `http://localhost:${RQLITE_HTTP_PORT}`;
    }


    async query(sql: string, params?: any[]): Promise<QueryResult> {
        // rqlite expects POST to /db/query with body: [[sql, p1, p2, ...]]
        const statement = params && params.length > 0 ? [sql, ...params] : [sql];
        const res = await fetch(`${this.baseUrl}/db/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([statement]),
        });
        if (!res.ok) throw new Error(`rqlite query failed: ${res.status}`);
        const json = await res.json();
        const result = json.results?.[0];
        if (result?.error) throw new Error(`rqlite query error: ${result.error}`);
        return {
            columns: result?.columns || [],
            types: result?.types || [],
            values: result?.values || [],
        };
    }


    async execute(sql: string, params?: any[]): Promise<ExecuteResult> {
        // rqlite expects POST to /db/execute with body: [[sql, p1, p2, ...]]
        const statement = params && params.length > 0 ? [sql, ...params] : [sql];
        const res = await fetch(`${this.baseUrl}/db/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([statement]),
        });
        if (!res.ok) throw new Error(`rqlite execute failed: ${res.status}`);
        const json = await res.json();
        const result = json.results?.[0];
        if (result?.error) throw new Error(`rqlite execute error: ${result.error}`);
        return {
            last_insert_id: result?.last_insert_id || '',
            rows_affected: result?.rows_affected || 0,
        };
    }


    async executeBatch(statements: { sql: string; params?: any[] }[]): Promise<ExecuteResult[]> {
        // rqlite expects: [[sql1, p1], [sql2, p2], ...]
        const body = statements.map(s =>
            s.params && s.params.length > 0 ? [s.sql, ...s.params] : [s.sql]
        );
        const res = await fetch(`${this.baseUrl}/db/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`rqlite batch failed: ${res.status}`);
        const json = await res.json();
        return (json.results || []).map((r: any) => ({
            last_insert_id: r?.last_insert_id || '',
            rows_affected: r?.rows_affected || 0,
        }));
    }


    async getStatus(): Promise<any> {
        const res = await fetch(`${this.baseUrl}/status`);
        if (!res.ok) throw new Error(`rqlite status failed: ${res.status}`);
        return res.json();
    }


    async isReady(): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/readyz`);
            return res.ok;
        } catch {
            return false;
        }
    }
}


export const rqlite = new RqliteClient();


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