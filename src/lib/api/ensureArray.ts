export function ensureArray<T>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}