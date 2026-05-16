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
    const url = `${this.baseUrl}/db/query?q=${encodeURIComponent(sql)}${params?.length ? `&params=${encodeURIComponent(JSON.stringify(params))}` : ''}&level=weak`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`rqlite query failed: ${res.status}`);
    return res.json();
  }

  async execute(sql: string, params?: any[]): Promise<ExecuteResult> {
    const res = await fetch(`${this.baseUrl}/db/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params })
    });
    if (!res.ok) throw new Error(`rqlite execute failed: ${res.status}`);
    const results = await res.json();
    return results[0];
  }

  async executeBatch(statements: { sql: string; params?: any[] }[]): Promise<ExecuteResult[]> {
    const res = await fetch(`${this.baseUrl}/db/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statements)
    });
    if (!res.ok) throw new Error(`rqlite batch failed: ${res.status}`);
    return res.json();
  }

  async getStatus(): Promise<ClusterStatus> {
    const res = await fetch(`${this.baseUrl}/status`);
    if (!res.ok) throw new Error(`rqlite status failed: ${res.status}`);
    const data = await res.json();
    const store = data.store || {};
    const nodes: NodeStatus[] = Object.entries(data.cluster?.nodes || {}).map(([id, node]: [string, any]) => ({
      id,
      address: node.addr,
      reachable: node.since > 0,
      is_leader: node.leader
    }));

    return {
      node: store.node_id || process.env.NODE_NAME || 'unknown',
      address: store.api_addr?.split(':')[0] || 'localhost',
      is_leader: store.is_leader || false,
      followers: nodes.filter(n => !n.is_leader),
      raft_index: store.raft_index || 0
    };
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