export function sanitizeShellArg(value: string): string {
  return value.replace(/[;&|`$(){}[\]!#~<>\\'\"*?\n\r]/g, '');
}

export function isValidDockerName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._\-/:]*$/.test(name);
}

export function isValidPackageName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._\-+]*$/.test(name);
}

export function isValidServiceName(name: string): boolean {
  return /^[a-zA-Z0-9._\-@]+\.service$/.test(name) ||
         /^[a-zA-Z0-9._\-@]+$/.test(name);
}