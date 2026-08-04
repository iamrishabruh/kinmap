/**
 * Byte and text encodings the Cognito handshakes need.
 *
 * Hand-rolled rather than pulled from `Buffer`, `TextEncoder` or `atob` for the
 * same reason `features/location/internal/bytes.ts` gives: none of those are
 * guaranteed to exist in the Hermes runtime that ships in the release binary,
 * and a silently-missing global here would mean "sign-in fails only in the
 * production build". Everything below is pure arithmetic with no runtime
 * dependency at all.
 *
 * SRP is specified over big-endian byte strings written as hex; OAuth 2.0 PKCE
 * and JWT are specified over base64url. Neither is interchangeable with the
 * base64 helper the location feature already has, which is why this module
 * exists rather than reaching across features for it.
 */

const HEX_DIGITS = '0123456789abcdef';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Reverse table shared by base64 and base64url; -1 marks an invalid character. */
const BASE64_LOOKUP: number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  const standard = `${BASE64_ALPHABET}+/`;
  for (let index = 0; index < standard.length; index += 1) {
    table[standard.charCodeAt(index)] = index;
  }
  // base64url substitutes the two non-alphanumeric characters.
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

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

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    out += `${HEX_DIGITS.charAt(byte >> 4)}${HEX_DIGITS.charAt(byte & 0x0f)}`;
  }
  return out;
}

/** @throws Error when the input is not an even-length run of hex digits. */
export function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) {
    throw new Error('Malformed hex payload.');
  }
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const high = HEX_DIGITS.indexOf(value.charAt(index * 2).toLowerCase());
    const low = HEX_DIGITS.indexOf(value.charAt(index * 2 + 1).toLowerCase());
    if (high < 0 || low < 0) {
      throw new Error('Malformed hex payload.');
    }
    out[index] = (high << 4) | low;
  }
  return out;
}

function encodeBase64(bytes: Uint8Array, alphabet: string, padding: string): string {
  const digit = (sextet: number): string => alphabet.charAt(sextet & 0x3f);
  let out = '';
  let index = 0;
  while (index + 2 < bytes.length) {
    const chunk =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out += digit(chunk >> 18) + digit(chunk >> 12) + digit(chunk >> 6) + digit(chunk);
    index += 3;
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = (bytes[index] ?? 0) << 16;
    out += `${digit(chunk >> 18)}${digit(chunk >> 12)}${padding}${padding}`;
  } else if (remaining === 2) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    out += `${digit(chunk >> 18)}${digit(chunk >> 12)}${digit(chunk >> 6)}${padding}`;
  }
  return out;
}

/** RFC 4648 §4, padded. The form Cognito expects for `PASSWORD_CLAIM_SIGNATURE`. */
export function toBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes, `${BASE64_ALPHABET}+/`, '=');
}

/** RFC 4648 §5 without padding — the form PKCE and JWT both require. */
export function toBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes, `${BASE64_ALPHABET}-_`, '');
}

/**
 * Decodes base64 and base64url alike, with or without padding. Cognito hands
 * back a padded, standard-alphabet `SECRET_BLOCK`; JWT segments are unpadded
 * base64url. Accepting both keeps the caller from having to know which.
 *
 * @throws Error when the input is not well-formed.
 */
export function fromBase64(value: string): Uint8Array {
  const trimmed = value.replace(/=+$/u, '');
  const out = new Uint8Array(Math.floor((trimmed.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let cursor = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    const sextet = code < 128 ? (BASE64_LOOKUP[code] ?? -1) : -1;
    if (sextet < 0) {
      throw new Error('Malformed base64 payload.');
    }
    accumulator = (accumulator << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[cursor] = (accumulator >> bits) & 0xff;
      cursor += 1;
    }
  }
  return out.subarray(0, cursor);
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
