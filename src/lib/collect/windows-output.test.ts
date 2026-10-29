import { describe, it, expect } from 'vitest';
import { cleanPowerShellOutput, SCRIPT, buildCommand } from './windows';

describe('Windows Update check script', () => {
  it('reads the reboot-pending state from the registry, never from the COM class a remote session is refused', () => {
    expect(SCRIPT).not.toMatch(/New-Object -ComObject Microsoft.Update.SystemInfo/);
    expect(SCRIPT).toContain('WindowsUpdate\\Auto Update\\RebootRequired');
    expect(SCRIPT).toContain('Component Based Servicing\\RebootPending');
  });

  it('still fits in a single exec command', () => {
    expect(buildCommand(['updates']).length).toBeLessThan(8000);
  });
});

describe('cleanPowerShellOutput', () => {
  const clixml = '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
    + '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj>'
    + '<S S="Error">uptime : The term \'uptime\' is not recognized as the name of a cmdlet. _x000D__x000A_</S>'
    + '<S S="Error">At line:1 char:1_x000D__x000A_</S></Objs>';

  it('turns the CLIXML error stream into plain text and drops progress records', () => {
    const out = cleanPowerShellOutput(clixml);
    expect(out).toContain("uptime : The term 'uptime' is not recognized");
    expect(out).toContain('At line:1 char:1');
    expect(out).not.toMatch(/CLIXML|<Objs|Preparing modules/);
  });

  it('decodes XML entities and leaves ordinary output alone', () => {
    expect(cleanPowerShellOutput('<Objs><S S="Error">a &lt; b &amp; c_x000D__x000A_</S></Objs>')).toBe('a < b & c');
    expect(cleanPowerShellOutput('plain text\nline 2')).toBe('plain text\nline 2');
    expect(cleanPowerShellOutput('')).toBe('');
  });

  it('keeps text that was printed next to the XML', () => {
    expect(cleanPowerShellOutput('hello\n' + clixml)).toMatch(/^hello\n/);
  });
});
