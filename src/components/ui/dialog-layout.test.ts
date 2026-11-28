import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('dialog layout', () => {
  it('scrolls the body and keeps the footer outside the scroll area', () => {
    const src = read('src/components/ui/dialog.tsx');
    const body = src.slice(src.indexOf('function DialogBody'), src.indexOf('function DialogFooter'));
    expect(body).toContain('overflow-y-auto');
    expect(body).toMatch(/\bpb-[0-9]/);
    const footer = src.slice(src.indexOf('function DialogFooter'));
    expect(footer).toContain('sticky bottom-0');
    expect(src).toMatch(/DialogContent[\s\S]*?flex flex-col[\s\S]*?overflow-hidden/);
  });

  it('keeps the last help text inside the body, above the footer', () => {
    const src = read('src/components/dialogs/WidgetSettingsDialog.tsx');
    const bodyEnd = src.indexOf('</DialogBody>');
    const footerStart = src.indexOf('<DialogFooter>');
    const help = src.indexOf('Applies to the desktop (24-column) layout');
    expect(help).toBeGreaterThan(-1);
    expect(help).toBeLessThan(bodyEnd);
    expect(bodyEnd).toBeLessThan(footerStart);
    expect(src.slice(Math.max(0, help - 200), bodyEnd)).toContain('text-xs text-muted-foreground');
  });
});
