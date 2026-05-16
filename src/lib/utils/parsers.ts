export function parseKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  text.split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) {
      result[key.trim()] = rest.join('=').replace(/"/g, '').trim();
    }
  });
  return result;
}

export function parseSizeToMB(size: string): number {
  const match = size.match(/^([\d.]+)\s*(KB|MB|GB|TB|kB)?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  switch (unit) {
    case 'KB': return value / 1024;
    case 'MB': return value;
    case 'GB': return value * 1024;
    case 'TB': return value * 1024 * 1024;
    default: return value / (1024 * 1024);
  }
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}