/**
 * Ollama settings that Bosun shows and changes (environment variables of the Ollama service or container).
 * No imports: shared by the server and the widget.
 */

export interface OllamaSetting {
  name: 'OLLAMA_CONTEXT_LENGTH' | 'OLLAMA_MAX_LOADED_MODELS';
  label: string;
  description: string;
  /** What Ollama does when the variable is not set. */
  defaultText: string;
  min: number;
  max: number;
  placeholder: string;
}

export const OLLAMA_SETTINGS: readonly OllamaSetting[] = [
  {
    name: 'OLLAMA_CONTEXT_LENGTH',
    label: 'Context length',
    description: 'Tokens of context a model gets unless a request asks for another size. Bigger uses more memory.',
    defaultText: 'Ollama default',
    min: 512,
    max: 4_194_304,
    placeholder: 'e.g. 16384',
  },
  {
    name: 'OLLAMA_MAX_LOADED_MODELS',
    label: 'Max loaded models',
    description: 'How many models may stay loaded at the same time. 0 lets Ollama decide from the available memory.',
    defaultText: 'Ollama default (automatic)',
    min: 0,
    max: 64,
    placeholder: 'e.g. 1',
  },
];

export const SETTING_NAMES: readonly string[] = OLLAMA_SETTINGS.map(s => s.name);

export function settingDef(name: string): OllamaSetting | undefined {
  return OLLAMA_SETTINGS.find(s => s.name === name);
}

/**
 * Check a value for a setting. An empty value means "not set" (back to Ollama's default). Returns the normalised
 * value (digits only, no leading zeros) or an error message.
 */
export function validateSetting(name: unknown, value: unknown): { ok: true; name: OllamaSetting['name']; value: string } | { ok: false; error: string } {
  const def = typeof name === 'string' ? settingDef(name) : undefined;
  if (!def) return { ok: false, error: 'Unknown setting' };
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, name: def.name, value: '' };
  const text = String(value).trim();
  if (!/^\d{1,9}$/.test(text)) return { ok: false, error: `${def.label} must be a whole number` };
  const n = Number(text);
  if (n < def.min || n > def.max) return { ok: false, error: `${def.label} must be between ${def.min} and ${def.max}` };
  return { ok: true, name: def.name, value: String(n) };
}
