/**
 * Anchor serialisation primitives: discriminators, Borsh (de)serialisation, and a data-driven
 * account codec built on top of the layouts parsed out of the Rust sources.
 *
 * The discriminator scheme is verified against the official Jupiter Lend IDL in
 * `tests/run_encoding_checks.ts` (`global:<snake_case>`, `account:<Struct>`, `event:<Event>`).
 */
import { createHash } from 'crypto';
import { FieldDef } from './rustsrc';

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export type DiscriminatorKind = 'global' | 'account' | 'event';

export function discriminator(kind: DiscriminatorKind, name: string): Buffer {
  return sha256(`${kind}:${name}`).subarray(0, 8);
}

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

export class BorshWriter {
  private chunks: Buffer[] = [];

  u8(value: number): this {
    this.chunks.push(Buffer.from([value & 0xff]));
    return this;
  }

  u16(value: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value);
    this.chunks.push(b);
    return this;
  }

  u32(value: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    this.chunks.push(b);
    return this;
  }

  u64(value: bigint): this {
    if (value < 0n || value > 0xffffffffffffffffn) throw new Error(`u64 out of range: ${value}`);
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value);
    this.chunks.push(b);
    return this;
  }

  bool(value: boolean): this {
    this.chunks.push(Buffer.from([value ? 1 : 0]));
    return this;
  }

  pubkey(base58: string): this {
    this.chunks.push(base58ToBytes(base58));
    return this;
  }

  bytes(data: Buffer): this {
    this.chunks.push(data);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class BorshReader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}

  u8(): number {
    return this.data.readUInt8(this.offset++);
  }

  u16(): number {
    const v = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    const v = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  pubkey(): string {
    const bytes = this.data.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return bytesToBase58(bytes);
  }

  remaining(): number {
    return this.data.length - this.offset;
  }
}

// ---------------------------------------------------------------------------- base58 (minimal)

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map<string, number>(
  ALPHABET.split('').map((c, i) => [c, i] as [string, number]),
);

export function base58ToBytes(value: string): Buffer {
  if (value.length === 0) return Buffer.alloc(0);
  let zeros = 0;
  while (zeros < value.length && value[zeros] === '1') zeros++;
  const bytes: number[] = [];
  for (const char of value) {
    const num = ALPHABET_MAP.get(char);
    if (num === undefined) throw new Error(`invalid base58 character "${char}"`);
    let carry = num;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

export function bytesToBase58(bytes: Buffer): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

// --------------------------------------------------------------------------- data-driven codec

export function fieldSize(field: FieldDef): number {
  if (field.optional) throw new Error(`optional field ${field.name} is not supported by the codec`);
  const t = field.type;
  if (typeof t === 'object') return 1; // fieldless enum tag
  switch (t) {
    case 'pubkey':
      return 32;
    case 'u64':
      return 8;
    case 'u32':
      return 4;
    case 'u16':
      return 2;
    case 'u8':
    case 'bool':
      return 1;
    default:
      throw new Error(`unsupported field type ${JSON.stringify(t)}`);
  }
}

export function encodeFields(
  fields: FieldDef[],
  value: Record<string, unknown>,
  enums: Map<string, string[]>,
): Buffer {
  const w = new BorshWriter();
  for (const field of fields) {
    const v = value[field.name];
    if (v === undefined) throw new Error(`missing value for field ${field.name}`);
    if (typeof field.type === 'object') {
      const variants = enums.get(field.type.enum);
      if (!variants) throw new Error(`unknown enum ${field.type.enum}`);
      const index = variants.indexOf(String(v));
      if (index < 0) throw new Error(`unknown variant ${String(v)} for ${field.type.enum}`);
      w.u8(index);
      continue;
    }
    switch (field.type) {
      case 'pubkey':
        w.pubkey(String(v));
        break;
      case 'u64':
        w.u64(BigInt(v as bigint));
        break;
      case 'u32':
        w.u32(Number(v));
        break;
      case 'u16':
        w.u16(Number(v));
        break;
      case 'u8':
        w.u8(Number(v));
        break;
      case 'bool':
        w.bool(Boolean(v));
        break;
      default:
        throw new Error(`unsupported field type ${JSON.stringify(field.type)}`);
    }
  }
  return w.build();
}

export function decodeFields(
  fields: FieldDef[],
  data: Buffer,
  enums: Map<string, string[]>,
): Record<string, unknown> {
  const r = new BorshReader(data);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (typeof field.type === 'object') {
      const variants = enums.get(field.type.enum);
      if (!variants) throw new Error(`unknown enum ${field.type.enum}`);
      const tag = r.u8();
      if (tag >= variants.length) throw new Error(`bad enum tag ${tag} for ${field.type.enum}`);
      out[field.name] = variants[tag];
      continue;
    }
    switch (field.type) {
      case 'pubkey':
        out[field.name] = r.pubkey();
        break;
      case 'u64':
        out[field.name] = r.u64();
        break;
      case 'u32':
        out[field.name] = r.u32();
        break;
      case 'u16':
        out[field.name] = r.u16();
        break;
      case 'u8':
        out[field.name] = r.u8();
        break;
      case 'bool':
        out[field.name] = r.bool();
        break;
      default:
        throw new Error(`unsupported field type ${JSON.stringify(field.type)}`);
    }
  }
  if (r.remaining() !== 0) {
    throw new Error(`account data has ${r.remaining()} trailing bytes`);
  }
  return out;
}
