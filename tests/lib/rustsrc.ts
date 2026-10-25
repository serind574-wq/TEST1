/**
 * Tiny reader for the Anchor sources in `programs/`.
 *
 * The harness deliberately derives its view of the on-chain interface (state layouts, account
 * orders, error codes, instruction names/arguments) from the *Rust source itself* instead of
 * keeping a hand-written copy. If a struct, an account list, or an error variant changes, the
 * TypeScript side changes with it - and if the two ever disagree, the encoding checks fail
 * loudly instead of silently testing something that is not deployed.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export type FieldType =
  | 'pubkey'
  | 'u64'
  | 'u32'
  | 'u16'
  | 'u8'
  | 'bool'
  | { enum: string };

export interface FieldDef {
  name: string;
  type: FieldType;
  /** `true` when the Rust type is an `Option<...>` (not used today, kept for completeness). */
  optional?: boolean;
}

export interface StateStruct {
  name: string;
  fields: FieldDef[];
  /** `pub const LEN` from the matching `impl` block, when present. */
  declaredLen?: number;
  source: string;
}

export interface AccountMetaDef {
  name: string;
  /** Rust type as written, e.g. `Account<'info, Quote>` or `Signer<'info>`. */
  rustType: string;
  writable: boolean;
  signer: boolean;
  /** `init` is present -> the account is created by this instruction. */
  init: boolean;
  /** PDA seeds, when the account is seed constrained. */
  seeds?: string[][];
}

export interface AccountsStruct {
  name: string;
  accounts: AccountMetaDef[];
  source: string;
}

export interface InstructionDef {
  name: string;
  /** Argument list in the order the Rust function declares it (ctx excluded). */
  args: FieldDef[];
  accounts: string;
}

export interface ProgramDef {
  dir: string;
  crateName: string;
  idlName: string;
  programId: string;
  state: Map<string, StateStruct>;
  errors: string[];
  accountsStructs: Map<string, AccountsStruct>;
  enums: Map<string, string[]>;
  events: Map<string, FieldDef[]>;
  instructions: InstructionDef[];
  argsStructs: Map<string, FieldDef[]>;
}

const ROOT = join(__dirname, '..', '..');

function stripComments(src: string): string {
  // Line comments only: the sources avoid block comments on purpose.
  return src
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      if (idx < 0) return line;
      // Do not strip inside string literals (error messages contain no `//`, but be safe).
      const before = line.slice(0, idx);
      const quotes = (before.match(/"/g) || []).length;
      if (quotes % 2 === 1) return line;
      return before;
    })
    .join('\n');
}

/** Remove `#[...]` attribute blocks (which may span lines) and return the attribute texts. */
function splitAttributes(body: string): { text: string; attributes: string[] } {
  let out = '';
  const attributes: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '#' && body[i + 1] === '[') {
      let depth = 0;
      let j = i + 1;
      for (; j < body.length; j++) {
        if (body[j] === '[') depth++;
        else if (body[j] === ']') {
          depth--;
          if (depth === 0) break;
        }
      }
      attributes.push(body.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    out += body[i];
    i++;
  }
  return { text: out, attributes };
}

function mapType(raw: string): FieldType {
  const t = raw.trim();
  switch (t) {
    case 'Pubkey':
      return 'pubkey';
    case 'u64':
      return 'u64';
    case 'u32':
      return 'u32';
    case 'u16':
      return 'u16';
    case 'u8':
      return 'u8';
    case 'bool':
      return 'bool';
    default:
      if (/^[A-Z]/.test(t)) return { enum: t };
      throw new Error(`rustsrc: unsupported field type "${t}"`);
  }
}

function parseFields(body: string): FieldDef[] {
  const { text } = splitAttributes(body);
  const fields: FieldDef[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('pub ')) continue;
    const m = /^pub\s+(\w+)\s*:\s*(.+?),\s*$/.exec(line);
    if (!m) continue;
    let typeText = m[2].trim();
    let optional = false;
    const opt = /^Option<(.+)>$/.exec(typeText);
    if (opt) {
      optional = true;
      typeText = opt[1].trim();
    }
    fields.push({ name: m[1], type: mapType(typeText), optional });
  }
  return fields;
}

function findBlockBody(src: string, header: RegExp): { name: string; body: string }[] {
  const results: { name: string; body: string }[] = [];
  const re = new RegExp(header.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = src.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    let end = start;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    results.push({ name: m[1], body: src.slice(start + 1, end) });
  }
  return results;
}

/** Extract the seed arrays of a `seeds = [...]` attribute, as string token lists. */
function parseSeeds(attribute: string | undefined): string[][] | undefined {
  if (!attribute) return undefined;
  const m = /seeds\s*=\s*\[([\s\S]*?)\]/.exec(attribute);
  if (!m) return undefined;
  const inner = m[1];
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((p) => {
    const tokens: string[] = [];
    const re = /"([^"]*)"|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/g;
    let t: RegExpExecArray | null;
    while ((t = re.exec(p))) {
      tokens.push(t[1] !== undefined ? t[1] : t[0]);
    }
    return tokens;
  });
}

function parseAccountsStructs(dir: string): Map<string, AccountsStruct> {
  const out = new Map<string, AccountsStruct>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.rs')) continue;
    const src = stripComments(readFileSync(join(dir, file), 'utf8'));
    for (const block of findBlockBody(
      src,
      /#\[derive\(Accounts\)\](?:\s*#\[[^\]]*\])*\s*pub struct\s+(\w+)/,
    )) {
      // Pre-split attributes per field by walking lines and remembering pending attributes.
      const accounts: AccountMetaDef[] = [];
      let pending: string[] = [];
      let buffer = '';
      let depth = 0;
      const flushField = () => {
        const line = buffer.trim();
        buffer = '';
        if (!line) return;
        const m = /^pub\s+(\w+)\s*:\s*([^,]+),?$/.exec(line);
        if (!m) return;
        const attributeText = pending.join(' ');
        const rustType = m[2].trim();
        accounts.push({
          name: m[1],
          rustType,
          writable: /\bmut\b/.test(attributeText),
          signer: /Signer</.test(rustType),
          init: /\binit\b/.test(attributeText),
          seeds: parseSeeds(attributeText),
        });
        pending = [];
      };
      for (let i = 0; i < block.body.length; i++) {
        const ch = block.body[i];
        if (ch === '#' && block.body[i + 1] === '[') {
          if (buffer.trim()) flushField();
          let d = 0;
          let j = i + 1;
          for (; j < block.body.length; j++) {
            if (block.body[j] === '[') d++;
            else if (block.body[j] === ']') {
              d--;
              if (d === 0) break;
            }
          }
          pending.push(block.body.slice(i, j + 1));
          i = j;
          continue;
        }
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          flushField();
          continue;
        }
        buffer += ch;
      }
      flushField();
      out.set(block.name, { name: block.name, accounts, source: file });
    }
  }
  return out;
}

function parseStateStructs(src: string): Map<string, StateStruct> {
  const out = new Map<string, StateStruct>();
  const cleaned = stripComments(src);
  for (const block of findBlockBody(cleaned, /#\[account\]\s*pub struct\s+(\w+)/)) {
    out.set(block.name, {
      name: block.name,
      fields: parseFields(block.body),
      source: 'state.rs',
    });
  }
  // `pub const LEN` declarations from `impl` blocks, e.g. `pub const LEN: usize = 32 * 7 + 2;`
  const implRe = /impl\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = implRe.exec(cleaned))) {
    const lenMatch = /pub const LEN:\s*usize\s*=\s*([^;]+);/.exec(m[2]);
    if (!lenMatch) continue;
    const expr = lenMatch[1].replace(/usize/g, '').replace(/\s+/g, ' ').trim();
    // The expressions are pure integer arithmetic; evaluate them without `eval`.
    const value = evalArithmetic(expr);
    const target = out.get(m[1]);
    if (target) target.declaredLen = value;
  }
  return out;
}

function evalArithmetic(expr: string): number {
  if (!/^[0-9+\-*/() ]+$/.test(expr)) {
    throw new Error(`rustsrc: refusing to evaluate non-arithmetic expression "${expr}"`);
  }
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict";return (${expr});`)() as number;
  if (!Number.isFinite(value)) throw new Error(`rustsrc: bad LEN expression "${expr}"`);
  return value;
}

function parseErrors(src: string): string[] {
  const cleaned = stripComments(src);
  const m = /#\[error_code\]\s*pub enum\s+\w+\s*\{([\s\S]*?)\n\}/.exec(cleaned);
  if (!m) throw new Error('rustsrc: no #[error_code] enum found');
  const names: string[] = [];
  for (const line of m[1].split('\n')) {
    const v = /^\s{4}([A-Z][A-Za-z0-9]*),?\s*$/.exec(line);
    if (v) names.push(v[1]);
  }
  return names;
}

function parseEvents(src: string): Map<string, FieldDef[]> {
  const out = new Map<string, FieldDef[]>();
  const cleaned = stripComments(src);
  for (const block of findBlockBody(cleaned, /#\[event\]\s*pub struct\s+(\w+)/)) {
    out.set(block.name, parseFields(block.body));
  }
  return out;
}

function parseArgsStructs(dir: string): Map<string, FieldDef[]> {
  const out = new Map<string, FieldDef[]>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.rs')) continue;
    const src = stripComments(readFileSync(join(dir, file), 'utf8'));
    for (const block of findBlockBody(
      src,
      /#\[derive\([^)]*AnchorSerialize[^)]*\)\]\s*pub struct\s+(\w+Args)/,
    )) {
      out.set(block.name, parseFields(block.body));
    }
  }
  return out;
}

function parseInstructions(libSrc: string, argsStructs: Map<string, FieldDef[]>): InstructionDef[] {
  const cleaned = stripComments(libSrc);
  const out: InstructionDef[] = [];
  const re = /pub fn (\w+)\s*\(\s*ctx:\s*Context<(\w+)>\s*([\s\S]*?)\)\s*->\s*Result<\(\)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const name = m[1];
    const accountsStruct = m[2];
    const rest = m[3].trim();
    const args: FieldDef[] = [];
    if (rest.length > 0) {
      const params = rest.replace(/^\s*,\s*/, '');
      for (const param of params.split(',')) {
        const p = param.trim();
        if (!p) continue;
        const pm = /^(\w+)\s*:\s*(.+)$/.exec(p);
        if (!pm) throw new Error(`rustsrc: cannot parse argument "${p}" of ${name}`);
        const typeName = pm[2].trim();
        const structFields = argsStructs.get(typeName);
        if (structFields) {
          args.push(...structFields);
        } else if (/^[A-Z]/.test(typeName)) {
          // e.g. `Pubkey` argument
          args.push({ name: pm[1], type: mapType(typeName) });
        } else {
          args.push({ name: pm[1], type: mapType(typeName) });
        }
      }
    }
    out.push({ name, args, accounts: accountsStruct });
  }
  // `snake_case` instruction names in Rust map to `camelCase` in the IDL/JS clients.
  return out;
}

/** Fieldless enums used as `#[account]` fields: 1-byte Borsh tags in declaration order. */
export function parseEnums(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const cleaned = stripComments(src);
  const re = /pub enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const variants: string[] = [];
    for (const line of m[2].split('\n')) {
      const v = /^\s{4}([A-Z][A-Za-z0-9]*),?\s*$/.exec(line);
      if (v) variants.push(v[1]);
    }
    if (variants.length > 0) out.set(m[1], variants);
  }
  return out;
}

export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export function loadProgram(crateDir: string): ProgramDef {
  const dir = join(ROOT, 'programs', crateDir);
  const src = join(dir, 'src');
  const libSrc = readFileSync(join(src, 'lib.rs'), 'utf8');
  const stateSrc = readFileSync(join(src, 'state.rs'), 'utf8');

  const idMatch = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(libSrc);
  if (!idMatch) throw new Error(`rustsrc: no declare_id! in ${crateDir}/src/lib.rs`);

  const argsStructs = parseArgsStructs(join(src, 'instructions'));

  return {
    dir,
    crateName: crateDir,
    idlName: camel(libSrc.match(/pub mod (\w+) \{/)?.[1] ?? crateDir.replace(/-/g, '_')),
    programId: idMatch[1],
    state: parseStateStructs(stateSrc),
    errors: parseErrors(readFileSync(join(src, 'errors.rs'), 'utf8')),
    accountsStructs: parseAccountsStructs(join(src, 'instructions')),
    enums: parseEnums(stateSrc),
    events: parseEvents(readFileSync(join(src, 'events.rs'), 'utf8')),
    instructions: parseInstructions(libSrc, argsStructs),
    argsStructs,
  };
}

function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export const ROOT_DIR = ROOT;

export function readRepoFile(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}
