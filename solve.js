// Faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Re-implemented from the makefun-site README + reference code in the kit:
// front matter, Markdown subset, template dialect, slug rule and report are
// makefun-site's own. run(input) returns exactly what build() returns.
//
// Speed plan: (1) Markdown rendered in one pass over the source with no
// token objects: lines classified by direct character tests, inline spans
// found with indexOf jumps, plain runs escaped whole. (2) Templates parsed
// once, then compiled to plain JS functions (new Function) so rendering is
// straight-line code: no node-tree walk, no per-node switch, loop scopes
// reused across iterations. (3) slugify/longDate memoised per run.

const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const RESERVED = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ text

const ESCMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** HTML-escape a whole string at once (one C++ regex pass; no match returns the string itself). */
function escStr(s) {
  return s.replace(ESC_RE, (c) => ESCMAP[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const slugCache = new Map();
const dateCache = new Map();

/** Slug of `text`, exactly as the reference: NFKD, marks dropped, A-Z lowered, runs of other chars one "-", cut to 64. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (/^[\x00-\x7F]*$/.test(text)) {
    // ASCII: NFKD is the identity and there are no combining marks.
    out = slugAscii(text);
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = slugAscii(plain);
  }
  slugCache.set(text, out);
  return out;
}

function slugAscii(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const r = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  dateCache.set(date, r);
  return r;
}

/** Words of a body: runs of characters other than whitespace. Counted by a
 * tight char loop when the body holds no Unicode whitespace (the usual
 * case); the regex path only when it does, so the count stays exact. */
const UNIWS_RE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
function wordsOf(text) {
  if (UNIWS_RE.test(text)) {
    const m = text.match(/\S+/g);
    return m === null ? 0 : m.length;
  }
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const w = c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 11;
    if (w) {
      if (!inWord) {
        words++;
        inWord = true;
      }
    } else inWord = false;
  }
  return words;
}

// ------------------------------------------------------------------ templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const BLANK_RE = /^[ \t]*$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Tokenize a template source: text, {{ }}, {{{ }}} and {% %} (a standalone tag's line taken with it). */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = BLANK_RE.test(src.slice(lineStart, open)) && BLANK_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Parse a template source into its node tree (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, number in JS digits, true/false, array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile a parsed template into a render function
 *   fn(esc, tof, lk, tr, scope, out, templatesMap, depth)
 * so rendering is straight-line code. Path arrays are hoisted to consts;
 * a for-loop's scope object and loop record are created once per loop
 * execution and mutated per iteration (rendering is synchronous, so reuse
 * is safe); includes pass the depth through so the 8-deep cap holds.
 * A leaf include (a template whose own tree holds no include at all) is
 * inlined at the include site under the same `d < 8` guard: the leaf's
 * code only pushes to `o` and reads the same scope, so the output is
 * identical and the Map lookup + call per include disappears.
 * `nodes` is this template's parsed tree; `all` maps every template
 * name that parsed to its tree.
 */
function compileTemplate(name, nodes, all) {
  const paths = [];
  const pathIdx = new Map();
  const pid = (arr) => {
    const k = arr.join('.');
    let i = pathIdx.get(k);
    if (i === undefined) {
      i = paths.length;
      paths.push(arr);
      pathIdx.set(k, i);
    }
    return i;
  };
  const leafCache = new Map();
  const isLeaf = (list) => {
    for (const n of list) {
      if (n.kind === 'include') return false;
      if (n.kind === 'for' && !isLeaf(n.body)) return false;
      if (n.kind === 'if' && (!isLeaf(n.then) || (n.else !== null && !isLeaf(n.else)))) return false;
    }
    return true;
  };
  let uid = 0;
  const gen = (list, sv) => {
    let code = '';
    for (const n of list) {
      if (n.kind === 'text') code += `o.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var') code += `o.push(esc(tof(lk(${sv},A${pid(n.path)}))));`;
      else if (n.kind === 'raw') code += `o.push(tof(lk(${sv},A${pid(n.path)})));`;
      else if (n.kind === 'if') {
        code += `if(tr(lk(${sv},A${pid(n.path)}))!==${n.not}){${gen(n.then, sv)}}`;
        if (n.else !== null) code += `else{${gen(n.else, sv)}}`;
      } else if (n.kind === 'for') {
        const u = uid++;
        const sc = `_c${u}`;
        code += `{var _x${u}=lk(${sv},A${pid(n.path)});if(Array.isArray(_x${u})){var ${sc}={vars:{},parent:${sv}};var _l${u}={index:0,first:false,last:false,length:_x${u}.length};${sc}.vars.loop=_l${u};for(var _k${u}=0;_k${u}<_x${u}.length;_k${u}++){${sc}.vars[${JSON.stringify(n.name)}]=_x${u}[_k${u}];_l${u}.index=_k${u}+1;_l${u}.first=_k${u}===0;_l${u}.last=_k${u}===_x${u}.length-1;${gen(n.body, sc)}}}}`;
      } else if (n.kind === 'include') {
        let leaf = leafCache.get(n.name);
        if (leaf === undefined) {
          const t = all.get(n.name);
          leaf = t !== undefined && n.name !== name && isLeaf(t) ? t : null;
          leafCache.set(n.name, leaf);
        }
        if (leaf !== null) code += `if(d<8){${gen(leaf, sv)}}`;
        else {
          const u = uid++;
          code += `if(d<8){var _f${u}=M.get(${JSON.stringify(n.name)});if(_f${u}!==undefined)_f${u}(esc,tof,lk,tr,${sv},o,M,d+1);}`;
        }
      }
    }
    return code;
  };
  const body = gen(nodes, 's');
  const head = paths.length > 0 ? `var ${paths.map((p, i) => `A${i}=${JSON.stringify(p)}`).join(',')};` : '';
  return new Function('esc', 'tof', 'lk', 'tr', 's', 'o', 'M', 'd', head + body);
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 'a' && c <= 'z') || c === '_';
}
function isNameChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-';
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) for (let i = 0; i < 10; i++) if (i !== 4 && i !== 7 && !isDigit(raw[i])) { ok = false; break; }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = [];
      let start = 0;
      for (let i = 0; i <= inner.length; i++) {
        if (i === inner.length || inner[i] === ',') {
          const t = inner.slice(start, i).trim();
          if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          tags.push(t);
          start = i + 1;
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) if (!isNameChar(raw[i])) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Lines scanned by indexOf, no split.
 */
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Find the closing line: the next line exactly '---'.
  let pos = firstEnd === text.length ? text.length : firstEnd + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const le = e === -1 ? text.length : e;
    if (text.slice(pos, le) === '---') { closeStart = pos; closeEnd = le; break; }
    if (e === -1) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1;
  pos = firstEnd === text.length ? text.length : firstEnd + 1;
  while (pos < closeStart) {
    const e = text.indexOf('\n', pos);
    const le = e === -1 ? closeStart : Math.min(e, closeStart);
    const line = text.slice(pos, le);
    lineNo++;
    pos = e === -1 ? text.length : e + 1;
    if (line.length === 0) continue;
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c !== ' ' && c !== '\t') { blank = false; break; }
    }
    if (blank || line[0] === '#') continue;
    const ci = line.indexOf(':');
    if (ci <= 0) return { error: `line ${lineNo} is not "key: value"` };
    let keyOk = true;
    for (let i = 0; i < ci; i++) if (!isKeyChar(line[i])) { keyOk = false; break; }
    if (!keyOk) return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, ci);
    let raw;
    if (line.length === ci + 1) raw = '';
    else if (line[ci + 1] === ' ') raw = line.slice(ci + 2);
    else return { error: `line ${lineNo} is not "key: value"` };
    let rlen = raw.length;
    while (rlen > 0 && (raw[rlen - 1] === ' ' || raw[rlen - 1] === '\t')) rlen--;
    raw = raw.slice(0, rlen);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ------------------------------------------------------------------ markdown

const SPECIAL_RE = /[\\`*\[]/;
const WS_RE = /\s/;

function isBlankLine(l) {
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A fence-open line: language ("" when none) or null when not a fence. */
function fenceOpen(l) {
  if (l[0] !== '`' || l[1] !== '`' || l[2] !== '`') return null;
  let i = 3;
  while (i < l.length) {
    const c = l[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = l.slice(3, i);
  while (i < l.length && (l[i] === ' ' || l[i] === '\t')) i++;
  return i === l.length ? lang : null;
}

function fenceClose(l) {
  if (l[0] !== '`' || l[1] !== '`' || l[2] !== '`') return false;
  for (let i = 3; i < l.length; i++) if (l[i] !== ' ' && l[i] !== '\t') return false;
  return true;
}

/** A heading line: { depth, text } or null. */
function headingOf(l) {
  let n = 0;
  while (n < 6 && l[n] === '#') n++;
  if (n === 0) return null;
  if (n >= 6 && l[6] === '#') return null;
  if (l[n] !== ' ' && l[n] !== '\t') return null;
  let s = n;
  while (l[s] === ' ' || l[s] === '\t') s++;
  let e = l.length;
  while (e > s && (l[e - 1] === ' ' || l[e - 1] === '\t')) e--;
  if (e <= s) return null;
  return { depth: n, text: l.slice(s, e) };
}

function isHr(l) {
  if (l.length < 3) return false;
  const p = l[0] === '-' && l[1] === '-' && l[2] === '-' ? 3 : l[0] === '*' && l[1] === '*' && l[2] === '*' ? 3 : 0;
  if (p === 0) return false;
  for (let i = 3; i < l.length; i++) if (l[i] !== ' ' && l[i] !== '\t') return false;
  return true;
}

/** A bullet line's item text, or null. */
function bulletOf(l) {
  if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') return l.slice(2);
  return null;
}

/** An ordered-list line: { num, text } or null. */
function orderedOf(l) {
  let n = 0;
  while (n < 10 && isDigit(l[n] || '')) n++;
  if (n === 0 || n > 9) return null;
  if (l[n] !== '.' || l[n + 1] !== ' ') return null;
  return { num: Number(l.slice(0, n)), text: l.slice(n + 2) };
}

/** A list-continuation line: two or more spaces then a non-space. */
function isContinued(l) {
  let n = 0;
  while (l[n] === ' ') n++;
  return n >= 2 && n < l.length && !WS_RE.test(l[n]);
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(l) {
  let a = 0;
  let b = l.length;
  while (a < b && (l[a] === ' ' || l[a] === '\t')) a++;
  while (b > a && (l[b - 1] === ' ' || l[b - 1] === '\t')) b--;
  return l.slice(a, b);
}

/** The line at [s, e) of `src`, trimmed of spaces and tabs at both ends (one slice). */
function trimSlice(src, s, e) {
  let a = s;
  let b = e;
  while (a < b && (src[a] === ' ' || src[a] === '\t')) a++;
  while (b > a && (src[b - 1] === ' ' || src[b - 1] === '\t')) b--;
  return src.slice(a, b);
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(l) {
  return isBlankLine(l) || fenceOpen(l) !== null || headingOf(l) !== null || isHr(l);
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const k = s.indexOf(what, from);
  if (k === -1) return -1;
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs >= k) return k;
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  if (s.indexOf('\\', from) === -1 && s.indexOf('**', from) === -1) return s.indexOf('*', from);
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** One regex pass over inline text: the next character that is an inline
 * construct or an HTML special. Plain runs are pushed raw (they hold no
 * special by construction); HTML specials emit their entity at once. This
 * replaces a separate escape pass over every run. */
const INLINE_RE = /[\\`*[&<>"']/g;
const HTML_RE = /[&<>"']/g;

/** `s` HTML-escaped into `out` (single regex pass, no intermediate string). */
function escInto(s, out) {
  let i = 0;
  let m;
  for (;;) {
    HTML_RE.lastIndex = i;
    m = HTML_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    out.push(ESCMAP[m[0]]);
    i = j + 1;
  }
  if (i < s.length) out.push(s.slice(i));
}

/** `s` rendered inline into `out`; `link(target)` resolves a link's href. */
function inlineStr(s, link, out) {
  let i = 0;
  const n = s.length;
  let m;
  for (;;) {
    INLINE_RE.lastIndex = i;
    m = INLINE_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = m[0];
    if (c === '&') { out.push('&amp;'); i = j + 1; continue; }
    if (c === '<') { out.push('&lt;'); i = j + 1; continue; }
    if (c === '>') { out.push('&gt;'); i = j + 1; continue; }
    if (c === '"') { out.push('&quot;'); i = j + 1; continue; }
    if (c === "'") { out.push('&#39;'); i = j + 1; continue; }
    i = j;
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) { out.push(s[i + 1]); i += 2; }
      else { out.push('\\'); i++; }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out.push('<code>');
        escInto(s.slice(i + 1, k), out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out.push('<strong>');
          inlineStr(s.slice(i + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out.push('<em>');
        inlineStr(s.slice(i + 1, k), link, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS_RE.test(target)) {
      out.push('<a href="', escStr(link(target)), '">');
      inlineStr(s.slice(i + 1, k), link, out);
      out.push('</a>');
      i = mm + 1;
      continue;
    }
    out.push('[');
    i++;
  }
  if (i < n) out.push(s.slice(i));
}

/** A fence-open line at [s, e): language ("" when none) or null. */
function lineFenceOpen(src, s, e) {
  if (src[s] !== '`' || src[s + 1] !== '`' || src[s + 2] !== '`') return null;
  let i = s + 3;
  while (i < e) {
    const c = src[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = src.slice(s + 3, i);
  while (i < e && (src[i] === ' ' || src[i] === '\t')) i++;
  return i === e ? lang : null;
}

function lineFenceClose(src, s, e) {
  if (src[s] !== '`' || src[s + 1] !== '`' || src[s + 2] !== '`') return false;
  for (let i = s + 3; i < e; i++) if (src[i] !== ' ' && src[i] !== '\t') return false;
  return true;
}

/** A heading line at [s, e): { depth, text } (text as a slice) or null. */
function lineHeading(src, s, e) {
  let n = 0;
  while (n < 6 && src[s + n] === '#') n++;
  if (n === 0) return null;
  if (n >= 6 && src[s + 6] === '#') return null;
  if (src[s + n] !== ' ' && src[s + n] !== '\t') return null;
  let a = s + n;
  while (src[a] === ' ' || src[a] === '\t') a++;
  let b = e;
  while (b > a && (src[b - 1] === ' ' || src[b - 1] === '\t')) b--;
  if (b <= a) return null;
  return { depth: n, text: src.slice(a, b) };
}

function lineIsHr(src, s, e) {
  if (e - s < 3) return false;
  if (!((src[s] === '-' && src[s + 1] === '-' && src[s + 2] === '-') || (src[s] === '*' && src[s + 1] === '*' && src[s + 2] === '*'))) return false;
  for (let i = s + 3; i < e; i++) if (src[i] !== ' ' && src[i] !== '\t') return false;
  return true;
}

/** A bullet line at [s, e): its item text, or null. */
function lineBullet(src, s, e) {
  if ((src[s] === '-' || src[s] === '*') && src[s + 1] === ' ') return src.slice(s + 2, e);
  return null;
}

/** An ordered-list line at [s, e): { num, text } or null. */
function lineOrdered(src, s, e) {
  let n = 0;
  while (n < 10 && src[s + n] >= '0' && src[s + n] <= '9') n++;
  if (n === 0 || n > 9) return null;
  if (src[s + n] !== '.' || src[s + n + 1] !== ' ') return null;
  return { num: Number(src.slice(s, s + n)), text: src.slice(s + n + 2, e) };
}

/** A list-continuation line at [s, e): two or more spaces then a non-space. */
function lineContinued(src, s, e) {
  let n = 0;
  while (src[s + n] === ' ') n++;
  return n >= 2 && s + n < e && !WS_RE.test(src[s + n]);
}

/**
 * `src` rendered: { html, toc, excerpt }. One pass over the lines, blocks
 * written straight into `out` (no token objects); lines are classified by
 * their first character, and sliced only when their content is needed.
 * nextLine reuses one bounds array (no allocation per line).
 */
function renderMarkdown(src, link) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const N = src.length;
  let pos = 0;
  const cur = [0, 0];
  // Next line bounds into cur [s, e) (e excludes '\n'); false at end of input.
  // The lines are the body's split on '\n': a body ending in '\n' holds one
  // trailing empty line, which a fence body (and only a fence body) can see.
  const nextLine = () => {
    if (pos > N) return false;
    if (pos === N) {
      if (N > 0 && src[N - 1] === '\n') {
        pos = N + 1;
        cur[0] = N;
        cur[1] = N;
        return true;
      }
      return false;
    }
    const e = src.indexOf('\n', pos);
    cur[1] = e === -1 ? N : e;
    cur[0] = pos;
    pos = e === -1 ? N + 1 : e + 1;
    return true;
  };
  let has = nextLine();
  let s = 0;
  let e = 0;
  while (has) {
    s = cur[0];
    e = cur[1];
    const c0 = s < e ? src[s] : '';
    let firstLine = null;
    if (s >= e || c0 === ' ' || c0 === '\t') {
      // Blank test and trimmed bounds in one scan (no helper call per line).
      let a = s, b = e;
      while (a < b && (src[a] === ' ' || src[a] === '\t')) a++;
      while (b > a && (src[b - 1] === ' ' || src[b - 1] === '\t')) b--;
      if (a >= b) { has = nextLine(); continue; }
      firstLine = src.slice(a, b);
    } else if (c0 === '`') {
      const fence = lineFenceOpen(src, s, e);
      if (fence !== null) {
        const parts = [];
        has = nextLine();
        while (has) {
          s = cur[0]; e = cur[1];
          if (lineFenceClose(src, s, e)) { has = nextLine(); break; }
          escInto(src.slice(s, e), parts);
          parts.push('\n');
          has = nextLine();
        }
        const cls = fence === '' ? '' : ` class="language-${fence}"`;
        out.push(`<pre><code${cls}>`, ...parts, '</code></pre>\n');
        continue;
      }
      firstLine = trimSlice(src, s, e);
    } else if (c0 === '#') {
      const hd = lineHeading(src, s, e);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        if (hd.depth === 2 || hd.depth === 3) {
          const tmp = [];
          inlineStr(hd.text, link, tmp);
          const html = tmp.join('');
          out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
          toc.push({ level: hd.depth, id, html });
        } else {
          out.push(`<h${hd.depth} id="${id}">`);
          inlineStr(hd.text, link, out);
          out.push(`</h${hd.depth}>\n`);
        }
        has = nextLine();
        continue;
      }
      firstLine = trimSlice(src, s, e);
    } else if (c0 === '-' || c0 === '*') {
      if (lineIsHr(src, s, e)) {
        out.push('<hr>\n');
        has = nextLine();
        continue;
      }
      const bullet = lineBullet(src, s, e);
      if (bullet !== null) {
        const items = [[trimLine(bullet)]];
        has = nextLine();
        while (has) {
          s = cur[0]; e = cur[1];
          const m = lineBullet(src, s, e);
          if (m !== null) { items.push([trimLine(m)]); has = nextLine(); }
          else if (lineContinued(src, s, e)) { items[items.length - 1].push(trimSlice(src, s, e)); has = nextLine(); }
          else break;
        }
        out.push('<ul>\n');
        for (const parts of items) {
          out.push('<li>');
          inlineStr(parts.length === 1 ? parts[0] : parts.join('\n'), link, out);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
      firstLine = trimSlice(src, s, e);
    } else if (c0 === '>') {
      const qlines = [];
      while (has) {
        s = cur[0]; e = cur[1];
        if (src[s] !== '>') break;
        qlines.push(src[s + 1] === ' ' ? src.slice(s + 2, e) : src.slice(s + 1, e));
        has = nextLine();
      }
      const kept = qlines.map(trimLine).filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineStr(kept.length === 1 ? kept[0] : kept.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const first = lineOrdered(src, s, e);
      if (first !== null) {
        const items = [[trimLine(first.text)]];
        has = nextLine();
        while (has) {
          s = cur[0]; e = cur[1];
          const m = lineOrdered(src, s, e);
          if (m !== null) { items.push([trimLine(m.text)]); has = nextLine(); }
          else if (lineContinued(src, s, e)) { items[items.length - 1].push(trimSlice(src, s, e)); has = nextLine(); }
          else break;
        }
        const open = first.num !== 1 ? `<ol start="${first.num}">` : '<ol>';
        out.push(`${open}\n`);
        for (const parts of items) {
          out.push('<li>');
          inlineStr(parts.length === 1 ? parts[0] : parts.join('\n'), link, out);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
      firstLine = trimSlice(src, s, e);
    } else {
      firstLine = trimSlice(src, s, e);
    }
    // Paragraph: the first line is `firstLine`; the lines after it up to a
    // paragraph end (blank, fence, heading or hr) join it. The end test is
    // inlined here: it is the hottest loop in the renderer.
    const parts = [firstLine];
    has = nextLine();
    while (has) {
      s = cur[0]; e = cur[1];
      let a = s, b = e;
      while (a < b && (src[a] === ' ' || src[a] === '\t')) a++;
      if (a >= b) break;
      const c = src[s];
      if (c === '`' && lineFenceOpen(src, s, e) !== null) break;
      if (c === '#' && lineHeading(src, s, e) !== null) break;
      if ((c === '-' || c === '*') && lineIsHr(src, s, e)) break;
      while (b > a && (src[b - 1] === ' ' || src[b - 1] === '\t')) b--;
      parts.push(src.slice(a, b));
      has = nextLine();
    }
    const text = parts.length === 1 ? parts[0] : parts.join('\n');
    if (excerpt === null) {
      const tmp = [];
      inlineStr(text, link, tmp);
      excerpt = tmp.join('');
      out.push(`<p>${excerpt}</p>\n`);
    } else {
      out.push('<p>');
      inlineStr(text, link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ build pipeline

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
const DOT_SEG_RE = /(^|\/)\.\.?(?=\/|$)/;
function resolvePath(dir, rel) {
  if (rel.indexOf('.') === -1) return dir === '' ? rel : `${dir}/${rel}`;
  if (!DOT_SEG_RE.test(rel)) return dir === '' ? rel : `${dir}/${rel}`;
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/**
 * A page as its layout reads it. This is a fresh object: the shared card
 * (also read by index, tag and recent listings) must NOT gain the page-only
 * fields — a listing's `{{ p.slug }}` renders empty in the reference, and
 * mutating the card would leak the slug into it.
 */
function pageOf(s, cards) {
  const c = s.post ? cards.get(s) : cardOf(s);
  return {
    ...c,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache.clear();
  dateCache.clear();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCU);
  const parsed = new Map();
  for (const name of names) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  for (const name of names) {
    if (!parsed.has(name)) continue;
    templates.set(name, compileTemplate(name, parsed.get(name), parsed));
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  // 1. Sources, in code-unit order of path; .md line ends made "\n".
  const files = [...input.files].sort((x, y) => byCU(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }
  // 2. Front matter, in the reference's check order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // 4. Markdown, links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if ((target.length >= 2 && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugify(name);
      let t = bySlug.get(sl);
      if (t === undefined) {
        t = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));
  // 7. Layouts.
  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // Scope objects are built once per shape and mutated per render (no
  // per-render object + spread allocation); the out array is reused too.
  const outArr = [];
  const scopePage = { vars: { site, tags: allTags, recent, page: null }, parent: null };
  const scopeIndex = { vars: { site, tags: allTags, recent, posts: null, pager: null }, parent: null };
  const scopeTag = { vars: { site, tags: allTags, recent, tag: null }, parent: null };
  const scopeTags = { vars: { site, tags: allTags, recent }, parent: null };
  const renderWith = (fn, scope) => {
    if (fn === undefined) return null;
    outArr.length = 0;
    fn(escStr, textOf, lookup, truthy, scope, outArr, templates, 0);
    return outArr.join('');
  };
  for (const s of kept) {
    scopePage.vars.page = pageOf(s, cards);
    output[`${s.outDir}/index.html`] = renderWith(templates.get(s.layout), scopePage);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    scopeIndex.vars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    scopeIndex.vars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = renderWith(templates.get('index'), scopeIndex);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    scopeTag.vars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = renderWith(templates.get('tag'), scopeTag);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderWith(templates.get('tags'), scopeTags);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  // 8. Report.
  const lines = [...report, ...broken].sort(byCU);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
