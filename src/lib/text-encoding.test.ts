import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { widgetsDir } from '@/lib/widgets/bundled';

const ROOT = process.cwd();
const TEXT = /\.(ts|tsx|js|jsx|json|md)$/;
/** UTF-8 read as Latin-1 and written back: U+201C becomes the three characters U+00E2 U+20AC U+0153. */
const MOJIBAKE = /\u00e2\u20ac|\u00c2[\u0080-\u00bf]|\u00c3[\u0080-\u00bf]/;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (TEXT.test(entry.name)) out.push(full);
  }
  return out;
}

describe('no user-facing text is double-encoded', () => {
  // A curly quote pasted into a source file through a tool that read UTF-8 as Latin-1 shows up in the UI
  // as three stray characters, not as the quote its author meant. TypeScript cannot see that, so this
  // walks the sources instead.
  it('has no mojibake in the sources or the bundled packages', () => {
    const files = [...sources(path.join(ROOT, 'src')), ...sources(widgetsDir())];
    expect(files.length).toBeGreaterThan(50);
    const bad = files.filter(f => MOJIBAKE.test(fs.readFileSync(f, 'utf8')));
    expect(bad.map(f => path.relative(ROOT, f))).toEqual([]);
  });
});
