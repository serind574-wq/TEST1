/**
 * Data-driven account codecs.
 *
 * Layouts are parsed from `programs/*\/src/state.rs`, so the bytes the harness reads and writes
 * are exactly the bytes the Rust program will see: the 8-byte Anchor discriminator followed by
 * Borsh fields in declaration order. `space` is cross-checked against the `pub const LEN` in the
 * Rust `impl` block by `tests/run_encoding_checks.ts`.
 */
import { FieldDef, ProgramDef } from './rustsrc';
import { decodeFields, discriminator, encodeFields, fieldSize } from './anchor';

export interface AccountLayout {
  name: string;
  owner: string;
  fields: FieldDef[];
  enums: Map<string, string[]>;
  /** Bytes excluding the 8-byte discriminator (what `pub const LEN` declares). */
  space: number;
  /** `pub const LEN` from the Rust source, if declared. */
  declaredSpace?: number;
}

export function buildLayouts(program: ProgramDef): Map<string, AccountLayout> {
  const layouts = new Map<string, AccountLayout>();
  for (const [name, struct] of program.state) {
    layouts.set(name, {
      name,
      owner: program.programId,
      fields: struct.fields,
      enums: program.enums,
      space: struct.fields.reduce((total, field) => total + fieldSize(field), 0),
      declaredSpace: struct.declaredLen,
    });
  }
  return layouts;
}

export function layoutOf(program: ProgramDef, name: string): AccountLayout {
  const layouts = buildLayouts(program);
  const layout = layouts.get(name);
  if (!layout) throw new Error(`no state struct named ${name} in ${program.crateName}`);
  return layout;
}

export function encodeAccount(layout: AccountLayout, value: Record<string, unknown>): Buffer {
  return Buffer.concat([
    discriminator('account', layout.name),
    encodeFields(layout.fields, value, layout.enums),
  ]);
}

export function decodeAccount(layout: AccountLayout, data: Buffer): Record<string, unknown> {
  const disc = discriminator('account', layout.name);
  if (!data.subarray(0, 8).equals(disc)) {
    throw new Error(`${layout.name}: account discriminator mismatch`);
  }
  return decodeFields(layout.fields, data.subarray(8), layout.enums);
}

export function accountSpace(layout: AccountLayout): number {
  return 8 + layout.space;
}
