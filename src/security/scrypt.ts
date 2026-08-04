/**
 * Channel-key scrypt hashing (v0.56.0) — the ONE implementation.
 * Was duplicated in memory.ts and store-postgres.ts. Both fed the same stored
 * format ("scrypt:v1:N:r:p:salt:hash"); a drift in either half means operators
 * locked out of their own broadcast channel with no error naming why. The
 * memory.ts variant is canonical because its verify validates parsed
 * parameters before use.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Config } from "../config.js";

export const SCRYPT_PREFIX = "scrypt:v1";

export function hashChannelKeyScrypt(key: string): string {
  const { SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN, SCRYPT_SALT_BYTES, SCRYPT_MAXMEM } = Config;
  const saltBuf = randomBytes(SCRYPT_SALT_BYTES);
  const hashBuf = scryptSync(key, saltBuf, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `${SCRYPT_PREFIX}:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${saltBuf.toString("hex")}:${hashBuf.toString("hex")}`;
}

export function verifyScryptHash(key: string, stored: string): boolean {
  try {
    // Format: "scrypt:v1:{N}:{r}:{p}:{salt_hex}:{hash_hex}"
    if (!stored.startsWith(`${SCRYPT_PREFIX}:`)) return false;
    const parts = stored.split(":");
    // ["scrypt", "v1", N, r, p, salt_hex, hash_hex] = 7 parts
    if (parts.length !== 7) return false;

    const N        = parseInt(parts[2]!, 10);
    const r        = parseInt(parts[3]!, 10);
    const p        = parseInt(parts[4]!, 10);
    const saltHex  = parts[5]!;
    const hashHex  = parts[6]!;

    // Validate parsed parameters — reject implausible values
    if (!Number.isInteger(N) || N < 1024 || N > 2 ** 20) return false;
    if (!Number.isInteger(r) || r < 1   || r > 64)       return false;
    if (!Number.isInteger(p) || p < 1   || p > 64)       return false;
    if (saltHex.length < 32 || !/^[0-9a-f]+$/.test(saltHex)) return false;
    if (hashHex.length < 32 || !/^[0-9a-f]+$/.test(hashHex)) return false;

    const saltBuf    = Buffer.from(saltHex, "hex");
    const storedHash = Buffer.from(hashHex, "hex");
    // Cap maxmem based on parsed N/r but never exceed Config.SCRYPT_MAXMEM.
    // Prevents DoS if an attacker stores a hash with extreme N/r parameters.
    const requiredMem = 128 * N * r * p;
    if (requiredMem > Config.SCRYPT_MAXMEM) return false; // parameter too large — reject
    const candidate  = scryptSync(key, saltBuf, storedHash.length, {
      N, r, p,
      maxmem: Config.SCRYPT_MAXMEM,
    });

    if (candidate.length !== storedHash.length) return false;
    return timingSafeEqual(candidate, storedHash);
  } catch {
    return false;
  }
}
