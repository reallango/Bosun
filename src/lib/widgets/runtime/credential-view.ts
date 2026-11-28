/** The shape of a credential kind as the credentials block and the credential selects see it (public fields only). */
export interface CredentialFieldView {
  id: string;
  label: string;
  type: 'string' | 'secret';
  public: boolean;
  optional: boolean;
  pattern?: string;
  help?: string;
}

export interface CredentialSecretView { set: boolean; hint: string | null }

/** One entry of a kind: never a secret value, only whether each secret is set and its last four characters. */
export interface CredentialEntryView {
  id: string;
  name: string;
  fields: Record<string, string>;
  servers: string[];
  isDefault: boolean;
  secrets: Record<string, CredentialSecretView>;
  lastUsedAt: string | null;
  lastUsedBy: string | null;
  lastUsedAction: string | null;
}

export interface CredentialKindView {
  id: string;
  label: string;
  permission: string;
  viewPermission: string;
  fields: CredentialFieldView[];
  servers: 'required' | 'optional';
  defaultPerServer: boolean;
  canManage: boolean;
  entries: CredentialEntryView[];
}

export interface CredentialWriteView {
  id?: string;
  name: string;
  fields: Record<string, string>;
  /** A secret left out stays unchanged; null clears it. */
  secrets: Record<string, string | null>;
  servers: string[];
  isDefault: boolean;
}

export type CredentialResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
