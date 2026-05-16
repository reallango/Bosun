export interface AuthResult {
  success: boolean;
  user?: { id: string; username: string; role: string };
  error?: string;
}

export interface AuthProvider {
  type: 'local' | 'oidc';
  authenticate(credentials: Record<string, string>): Promise<AuthResult>;
  getUser(userId: string): Promise<{ id: string; username: string; role: string } | null>;
}