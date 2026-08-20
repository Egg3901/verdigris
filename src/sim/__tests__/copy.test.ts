// Player-facing copy rules. Standing owner rule: no em or en dashes in shipped
// strings. Comments may use them, string literals may not, so comments are
// stripped and then the characters are banned wholesale across src/.
//
// This test is load-bearing for the narrative layer, not decorative: every
// authored fragment in lexicon.ts has to be punctuated with commas, colons,
// semicolons or parentheses, and it is far easier to enforce that from the first
// commit than to sweep it later.
import { describe, expect, it } from 'vitest';

const files = import.meta.glob('../../**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const sources = Object.entries(files).filter(([path]) => !path.endsWith('.test.ts'));

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/[^'"`\n]*$/gm, '');
}

describe('shipped copy', () => {
  it('contains no em or en dashes outside comments', () => {
    const offenders: string[] = [];
    for (const [path, code] of sources) {
      stripComments(code).split('\n').forEach((line, i) => {
        if (line.includes('—') || line.includes('–')) {
          offenders.push(`${path}:${i + 1}: ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('carries no Rialto or Foreshore vocabulary into the district', () => {
    const banned = /Tidehall|Great Beacon|fondamenta|Venetian|lagoon/i;
    const offenders: string[] = [];
    for (const [path, code] of sources) {
      stripComments(code).split('\n').forEach((line, i) => {
        if (banned.test(line)) offenders.push(`${path}:${i + 1}`);
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
