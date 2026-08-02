/**
 * Byte primitives used by the on-device encryption layer.
 *
 * Hand-rolled rather than pulled from `Buffer`, `TextEncoder` or `btoa`
 * because none of those are guaranteed to exist in the Hermes runtime that
 * ships in the release binary, and a silently-missing global here would mean
 * "sensitive field written to SQLite in the clear". Everything below is pure
 * arithmetic with no runtime dependency at all.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup table for base64 decoding; -1 marks an invalid character. */
const BASE64_LOOKUP: number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

const HEX_DIGITS = '0123456789abcdef';

export function utf8Encode(value: string): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < value.length) {
    let codePoint = value.charCodeAt(index);
    index += 1;
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index < value.length) {
      const low = value.charCodeAt(index);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = ((codePoint - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  const at = (offset: number): number => bytes[offset] ?? 0;
  while (index < bytes.length) {
    const first = at(index);
    let codePoint: number;
    if (first < 0x80) {
      codePoint = first;
      index += 1;
    } else if ((first & 0xe0) === 0xc0) {
      codePoint = ((first & 0x1f) << 6) | (at(index + 1) & 0x3f);
      index += 2;
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = ((first & 0x0f) << 12) | ((at(index + 1) & 0x3f) << 6) | (at(index + 2) & 0x3f);
      index += 3;
    } else {
      codePoint =
        ((first & 0x07) << 18) |
        ((at(index + 1) & 0x3f) << 12) |
        ((at(index + 2) & 0x3f) << 6) |
        (at(index + 3) & 0x3f);
      index += 4;
    }
    if (codePoint > 0xffff) {
      const surrogate = codePoint - 0x10000;
      out += String.fromCharCode(0xd800 + (surrogate >> 10), 0xdc00 + (surrogate & 0x3ff));
    } else {
      out += String.fromCharCode(codePoint);
    }
  }
  return out;
}

/** `charAt` (not indexing) so the result is `string`, never `string | undefined`. */
function base64Digit(sextet: number): string {
  return BASE64_ALPHABET.charAt(sextet & 0x3f);
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  while (index + 2 < bytes.length) {
    const chunk =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out +=
      base64Digit(chunk >> 18) +
      base64Digit(chunk >> 12) +
      base64Digit(chunk >> 6) +
      base64Digit(chunk);
    index += 3;
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = (bytes[index] ?? 0) << 16;
    out += `${base64Digit(chunk >> 18)}${base64Digit(chunk >> 12)}==`;
  } else if (remaining === 2) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    out += `${base64Digit(chunk >> 18)}${base64Digit(chunk >> 12)}${base64Digit(chunk >> 6)}=`;
  }
  return out;
}

/** @throws Error when the input is not well-formed base64. */
export function fromBase64(value: string): Uint8Array {
  const trimmed = value.replace(/=+$/u, '');
  const out = new Uint8Array(Math.floor((trimmed.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let cursor = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    const digit = code < 128 ? (BASE64_LOOKUP[code] ?? -1) : -1;
    if (digit < 0) {
      throw new Error('Malformed base64 payload.');
    }
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[cursor] = (accumulator >> bits) & 0xff;
      cursor += 1;
    }
  }
  return out.subarray(0, cursor);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    out += `${HEX_DIGITS.charAt(byte >> 4)}${HEX_DIGITS.charAt(byte & 0x0f)}`;
  }
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function uint32BE(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/**
 * Length is compared first and therefore leaks; the *content* comparison is
 * constant time, which is the property that matters for an authentication tag.
 */
export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
