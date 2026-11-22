// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Move targets: each new path maps to the path it was moved from (chained moves compose). */
  readonly moves = new Map<string, string>();
  /** Set a path's content (null deletes it); deleting a path forgets any move that produced it. */
  put(p: string, text: string | null): void {
    if (text === null) this.moves.delete(p);
    this.now.set(p, text);
  }
  /** Move a file, composing with any earlier move that produced `from`. */
  relocate(from: string, to: string, text: string): void {
    this.moves.set(to, this.moves.get(from) ?? from);
    this.moves.delete(from);
    this.now.set(from, null);
    this.now.set(to, text);
  }
}

type Edit = (tree: Tree) => void;

/** A file's text, split the way SPEC.md section 3 splits it. */
interface SplitFile {
  lines: string[];
  br: string;
  eol: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const tailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Whether two lines are equal at a matching tier (SPEC.md section 5). */
function tierEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return tailTrim(a) === tailTrim(b);
  return bothTrim(a) === bothTrim(b);
}

/** Every position at or after `from` where `old` matches `lines` at `tier`. */
function tierHits(lines: string[], old: string[], tier: number, from: number): number[] {
  const hits: number[] = [];
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < old.length; k += 1) {
      if (!tierEq(tier, lines[i + k]!, old[k]!)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier at which `old` occurs at or after `from` (tier 0 only under --strict). */
function firstTier(lines: string[], old: string[], from: number, strict: boolean): { tier: number; hits: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const hits = tierHits(lines, old, tier, from);
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

/** One line of a replacement: `ctx` is its index in the old lines when it is a context line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines a match at `pos` is replaced with, per SPEC.md section 5. */
function renderNew(fileLines: string[], pos: number, old: string[], next: NewLine[], tier: number): string[] {
  if (tier !== 2 || old.length === 0) {
    return next.map((n) => (n.ctx !== null ? fileLines[pos + n.ctx]! : n.text));
  }
  const fileLead = leadWs(fileLines[pos]!);
  const oldLead = leadWs(old[0]!);
  return next.map((n) => {
    if (n.ctx !== null) return fileLines[pos + n.ctx]!;
    if (n.text !== '' && n.text.trim() !== '' && n.text.startsWith(oldLead)) return fileLead + n.text.slice(oldLead.length);
    return n.text;
  });
}

/** The nearest hit to `hint` (ties go to the earlier one). */
function nearestHit(hits: number[], hint: number): number {
  let best = hits[0]!;
  for (const h of hits) {
    if (Math.abs(h - hint) < Math.abs(best - hint)) best = h;
  }
  return best;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: its old start line (A) and its body lines (trailing blank lines removed). */
interface Hunk {
  start: number;
  body: string[];
}

/** One unified section, as parsed from its header and hunks. */
interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  paired: boolean;
  gitOld: string | null;
  gitNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  created: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

const isBodyLine = (l: string): boolean =>
  l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');

/** The path a `--- ` or `+++ ` line names (null for /dev/null). */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** A hunk body's old lines, new lines (with context marks) and whether a `\` line follows its last new line. */
function hunkParts(h: Hunk): { old: string[]; next: NewLine[]; noEol: boolean } {
  const old: string[] = [];
  const next: NewLine[] = [];
  let lastNew = -1;
  h.body.forEach((line, j) => {
    if (line === '' || line.startsWith(' ')) {
      old.push(line.slice(1));
      next.push({ text: line.slice(1), ctx: old.length - 1 });
      lastNew = j;
    } else if (line.startsWith('-')) {
      old.push(line.slice(1));
    } else if (line.startsWith('+')) {
      next.push({ text: line.slice(1), ctx: null });
      lastNew = j;
    }
  });
  const noEol = lastNew >= 0 && lastNew + 1 < h.body.length && h.body[lastNew + 1]!.startsWith('\\');
  return { old, next, noEol };
}

/** Whether a created file ends with a line break: no, when a `\` line follows its last `+` line. */
function createdEndsWithBreak(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h -= 1) {
    const body = hunks[h]!.body;
    for (let j = body.length - 1; j >= 0; j -= 1) {
      if (body[j]!.startsWith('+')) return !(j + 1 < body.length && body[j + 1]!.startsWith('\\'));
    }
  }
  return true;
}

/** One unified section's edit (SPEC.md section 6). */
function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldPath = s.pairOld ?? s.renameFrom ?? s.gitOld;
  const newPath = s.pairNew ?? s.renameTo ?? s.gitNew;
  const isCreate = oldPath === null || s.created;
  const isDelete = newPath === null || s.deleted;
  if (isCreate) {
    const target = newPath;
    return (tree) => {
      if (target === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const made: string[] = [];
      for (const h of s.hunks) for (const l of h.body) if (l.startsWith('+')) made.push(l.slice(1));
      tree.put(target, joinFile({ lines: made, br: '\n', eol: createdEndsWithBreak(s.hunks) }));
    };
  }
  const from = oldPath!;
  const to = newPath!;
  return (tree) => {
    if (!safe(from)) throw new Fail('unsafe', from);
    if (isDelete) {
      if (tree.get(from) === null) throw new Fail('missing', from);
      tree.put(from, null);
      return;
    }
    if (!safe(to)) throw new Fail('unsafe', to);
    const moving = from !== to;
    const current = tree.get(from);
    if (current === null) throw new Fail('missing', from);
    if (moving && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitFile(current);
    let drift = 0;
    for (const h of s.hunks) {
      const { old, next, noEol } = hunkParts(h);
      if (old.length === 0) {
        const at = Math.min(h.start + drift, f.lines.length);
        f.lines.splice(at, 0, ...next.map((n) => n.text));
        if (at === f.lines.length) f.eol = !noEol;
        drift += next.length;
        continue;
      }
      const found = firstTier(f.lines, old, 0, strict);
      if (found === null) throw new Fail('no-match', from);
      const pos = nearestHit(found.hits, h.start - 1 + drift);
      const wrote = renderNew(f.lines, pos, old, next, found.tier);
      if (pos + old.length === f.lines.length) f.eol = !noEol;
      f.lines.splice(pos, old.length, ...wrote);
      drift += next.length - old.length;
    }
    const out = joinFile(f);
    if (moving) tree.relocate(from, to, out);
    else tree.put(from, out);
  };
}

/** Read a unified diff patch (SPEC.md section 6) into its section edits. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let header = false;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && blank(hunk.body[hunk.body.length - 1]!)) hunk.body.pop();
    cur!.hunks.push(hunk);
    hunk = null;
  };
  const fresh = (gitOld: string | null, gitNew: string | null, paired: boolean): UniSection => ({
    pairOld: null,
    pairNew: null,
    paired,
    gitOld,
    gitNew,
    renameFrom: null,
    renameTo: null,
    created: false,
    deleted: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) closeHunk();
    if (hunk !== null && isBodyLine(line)) {
      hunk.body.push(line);
      i += 1;
      continue;
    }
    if (hunk !== null) closeHunk();
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(m[1]!, m[2]!, false);
      sections.push(cur);
      header = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { start: Number(m[1]!), body: [] };
      header = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        const oldP = dashPath(line);
        const newP = dashPath(next);
        if (cur !== null && header) {
          if (!cur.paired) {
            cur.pairOld = oldP;
            cur.pairNew = newP;
            cur.paired = true;
          }
        } else {
          cur = fresh(null, null, true);
          cur.pairOld = oldP;
          cur.pairNew = newP;
          sections.push(cur);
          header = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && header) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && header) {
      if (line.startsWith('rename from ')) {
        if (cur.renameFrom === null) cur.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (cur.renameTo === null) cur.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.created = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deleted = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  closeHunk();
  return sections.map((s) => uniSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block. */
interface SrBlock {
  path: string;
  old: string[];
  next: string[];
}

/** One SEARCH/REPLACE block's edit (SPEC.md section 7). */
function srBlockEdit(b: SrBlock, strict: boolean): Edit {
  const p = b.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.put(p, joinFile({ lines: b.next, br: '\n', eol: b.next.length > 0 }));
      return;
    }
    const current = tree.get(p);
    if (current === null) throw new Fail('missing', p);
    const f = splitFile(current);
    const found = firstTier(f.lines, b.old, 0, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.hits.length > 1) throw new Fail('ambiguous', p);
    const pos = found.hits[0]!;
    const wrote = renderNew(
      f.lines,
      pos,
      b.old,
      b.next.map((t) => ({ text: t, ctx: null })),
      found.tier,
    );
    f.lines.splice(pos, b.old.length, ...wrote);
    tree.put(p, joinFile(f));
  };
}

/** Read a SEARCH/REPLACE patch (SPEC.md section 7) into its block edits. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, old: lines.slice(searchIdx + 1, sep), next: lines.slice(sep + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  return blocks.map((b) => srBlockEdit(b, strict));
}

/** One V4A chunk: its anchor (null: none), whether it is anchored to the file's end, and its lines. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  old: string[];
  next: NewLine[];
}

/** One V4A section. */
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

/** A V4A chunk body's old lines and new lines (with context marks). */
function chunkParts(body: string[]): { old: string[]; next: NewLine[] } {
  const old: string[] = [];
  const next: NewLine[] = [];
  for (const line of body) {
    if (line === '' || line.startsWith(' ')) {
      old.push(line.slice(1));
      next.push({ text: line.slice(1), ctx: old.length - 1 });
    } else if (line.startsWith('-')) {
      old.push(line.slice(1));
    } else if (line.startsWith('+')) {
      next.push({ text: line.slice(1), ctx: null });
    }
  }
  return { old, next };
}

/** One V4A section's edit (SPEC.md section 8). */
function v4aSectionEdit(s: V4aSection, strict: boolean): Edit {
  const p = s.path;
  if (s.kind === 'add') {
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.put(p, joinFile({ lines: s.lines, br: '\n', eol: s.lines.length > 0 }));
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.put(p, null);
    };
  }
  const to = s.moveTo;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (to !== null && !safe(to)) throw new Fail('unsafe', to);
    const current = tree.get(p);
    if (current === null) throw new Fail('missing', p);
    if (to !== null && to !== p && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitFile(current);
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null) {
        const found = firstTier(f.lines, [c.anchor], cursor, strict);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.hits[0]! + 1;
      }
      if (c.old.length === 0) {
        const at = c.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...c.next.map((n) => n.text));
        cursor = at + c.next.length;
        continue;
      }
      const found = firstTier(f.lines, c.old, cursor, strict);
      if (found === null) throw new Fail('no-match', p);
      let pos = -1;
      for (const h of found.hits) {
        if (c.eof && h + c.old.length !== f.lines.length) continue;
        pos = h;
        break;
      }
      if (pos < 0) throw new Fail('no-match', p);
      const wrote = renderNew(f.lines, pos, c.old, c.next, found.tier);
      f.lines.splice(pos, c.old.length, ...wrote);
      cursor = pos + wrote.length;
    }
    const out = joinFile(f);
    if (to !== null && to !== p) tree.relocate(p, to, out);
    else tree.put(p, out);
  };
}

const v4aSectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
  if (l.startsWith('*** Add File: ')) return 'add';
  if (l.startsWith('*** Delete File: ')) return 'delete';
  if (l.startsWith('*** Update File: ')) return 'update';
  return null;
};

const v4aBodyLine = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');

/** Read a V4A patch (SPEC.md section 8) into its section edits. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = v4aSectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const sec: V4aSection = { kind, path, moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    i += 1;
    if (kind === 'add') {
      const raw: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('+')) {
          raw.push(l);
          i += 1;
          continue;
        }
        if (blank(l)) {
          raw.push(l);
          i += 1;
          continue;
        }
        break;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      sec.lines = raw.map((l) => (l.startsWith('+') ? l.slice(1) : ''));
      sections.push(sec);
      continue;
    }
    if (kind === 'delete') {
      sections.push(sec);
      continue;
    }
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i += 1;
    }
    let chunk: { anchor: string | null; eof: boolean; body: string[] } | null = null;
    let opened = 0;
    const closeChunk = (atSectionEnd: boolean): void => {
      if (chunk === null) return;
      if (atSectionEnd) {
        while (chunk.body.length > 0 && blank(chunk.body[chunk.body.length - 1]!)) chunk.body.pop();
      }
      const parts = chunkParts(chunk.body);
      sec.chunks.push({ anchor: chunk.anchor, eof: chunk.eof, old: parts.old, next: parts.next });
      opened += 1;
      chunk = null;
    };
    while (i < last) {
      const l = lines[i]!;
      if (v4aSectionStart(l) !== null) {
        closeChunk(true);
        break;
      }
      if (l.trim() === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
        chunk.eof = true;
        closeChunk(false);
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        closeChunk(false);
        const anchor = l.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        i += 1;
        continue;
      }
      if (v4aBodyLine(l)) {
        if (chunk === null) {
          if (opened > 0) throw new Exit2(`error: parse ${i + 1}`);
          chunk = { anchor: null, eof: false, body: [] };
        }
        chunk.body.push(l);
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    closeChunk(true);
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
    sections.push(sec);
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; line: string }[] = [];
  const movedFrom = new Set<string>();
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const from = tree.moves.get(p);
    if (from !== undefined && from !== p && was === null && tree.original(from) !== null && tree.get(from) === null) {
      rows.push({ key: p, line: `R ${from} -> ${p}` });
      movedFrom.add(from);
      continue;
    }
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const kept = rows
    .filter((r) => !(r.line.startsWith('D ') && movedFrom.has(r.line.slice(2))))
    .sort((a, b) => byteOrder(a.key, b.key))
    .map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...kept, `ok: ${kept.length} ${kept.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
