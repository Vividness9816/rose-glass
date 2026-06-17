import { describe, expect, it } from 'vitest';
import { siblingMdPath, toVaultRelative } from './fileOpen';

describe('toVaultRelative', () => {
  const root = 'C:\\Users\\me\\vault';

  it('relativizes a file inside the vault (backslashes → forward slashes)', () => {
    expect(toVaultRelative('C:\\Users\\me\\vault\\docs\\report.pdf', root)).toBe('docs/report.pdf');
  });

  it('is case-insensitive on the root but preserves the relative case', () => {
    expect(toVaultRelative('c:\\users\\me\\VAULT\\A\\B.docx', root)).toBe('A/B.docx');
  });

  it('rejects a path outside the vault', () => {
    expect(toVaultRelative('C:\\Users\\me\\other\\x.pdf', root)).toBeNull();
  });

  it('rejects a sibling-prefix trick (vault-evil is not inside vault)', () => {
    expect(toVaultRelative('C:\\Users\\me\\vault-evil\\x.pdf', root)).toBeNull();
  });

  it('rejects the vault root itself (not a file)', () => {
    expect(toVaultRelative('C:\\Users\\me\\vault', root)).toBeNull();
    expect(toVaultRelative('C:\\Users\\me\\vault\\', root)).toBeNull();
  });

  it('handles a forward-slash root (cross-platform)', () => {
    expect(toVaultRelative('/home/me/vault/a/b.pdf', '/home/me/vault')).toBe('a/b.pdf');
    expect(toVaultRelative('/home/me/elsewhere/b.pdf', '/home/me/vault')).toBeNull();
  });
});

describe('siblingMdPath', () => {
  it('appends .md so it stays distinct from a hand-authored sibling', () => {
    expect(siblingMdPath('docs/report.docx')).toBe('docs/report.docx.md');
  });
});
