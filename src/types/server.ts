export interface Server {
  id: string;
  name: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_id: string | null;
  os_type: string | null;
  os_version: string | null;
  os_codename: string | null;
  kernel_version: string | null;
  notes: string | null;
  is_online: boolean;
  last_seen: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  total_ram_mb: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ServerWithKey extends Server {
  sshKeyName?: string;
}

export type ServerCreateInput = Omit<Server, 'id' | 'created_at' | 'updated_at' | 'is_online' | 'last_seen'>;
export type ServerUpdateInput = Partial<ServerCreateInput>;