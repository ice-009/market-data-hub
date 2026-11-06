import { createHmac } from "node:crypto";

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what Fyers' login asks for. Pure:
// time is passed in. (Ported from Tradex, MIT.)

export function base32Decode(b32: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of b32.replace(/=+$/, "").toUpperCase().replace(/\s/g, "")) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The 6-digit code for `now`, shifted by `skew` 30-second steps. */
export function totp(secret: string, now: number, skew = 0): string {
  let counter = Math.floor(now / 1000 / 30) + skew;
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}
