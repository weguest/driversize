// Exclusion patterns shared by the root enumeration (main process) and the scan
// workers. One pattern per line in the settings:
//   - an absolute path (`C:\Jogos\Steam`) skips that folder/file and everything below;
//   - anything else is a name glob, case-insensitive (`node_modules`, `*.iso`,
//     `Temp*`). `#` starts a comment and blank lines are ignored.
export type ExcludeRule = { path: string } | { re: RegExp };

function normalize(p: string): string {
  return p.trim().replace(/\//g, '\\').replace(/\\+$/, '');
}

function isAbsolutePattern(p: string): boolean {
  return /^[a-zA-Z]:\\/.test(p) || p.startsWith('\\\\');
}

function globToRe(glob: string): RegExp {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$', 'i');
}

/** Builds the predicate used while walking the tree. */
export function makeExcluder(patterns: readonly string[]): (full: string, name: string) => boolean {
  const rules: ExcludeRule[] = [];
  for (const raw of patterns) {
    const p = normalize(raw);
    if (!p || p.startsWith('#')) continue;
    if (isAbsolutePattern(p)) rules.push({ path: p.toLowerCase() });
    else rules.push({ re: globToRe(p) });
  }
  if (!rules.length) return () => false;
  return (full: string, name: string): boolean => {
    const f = full.toLowerCase();
    const n = (name || '').toLowerCase();
    for (const r of rules) {
      if ('path' in r) {
        if (f === r.path || f.startsWith(r.path + '\\')) return true;
      } else if (r.re.test(n)) {
        return true;
      }
    }
    return false;
  };
}
