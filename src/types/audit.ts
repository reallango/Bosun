export type AuditAction = 
  | 'login' | 'logout' | 'create' | 'update' | 'delete' 
  | 'execute' | 'start' | 'stop' | 'restart';

export interface AuditLog {
  id: string;
  user_id: string;
  user_email: string;
  action: AuditAction;
  resource_type: string;
  resource_id?: string;
  details?: Record<string, any>;
  ip_address?: string;
  user_agent?: string;
  status: 'success' | 'failure';
  error_message?: string;
  created_at: string;
}