import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM encryption for each user's OpenServ API key at rest. The key
// comes from OPENSERV_KEY_ENC_KEY (32 bytes, base64) and lives only in the
// server environment. Ciphertext is stored as iv.tag.data, all base64url.
//
// This module is server only. It imports node:crypto, which Next will refuse
// to bundle for the browser, so an accidental client import fails the build
// rather than leaking anything.

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.OPENSERV_KEY_ENC_KEY;
  if (!raw) throw new Error("OPENSERV_KEY_ENC_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("OPENSERV_KEY_ENC_KEY must decode to 32 bytes");
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 3) throw new Error("malformed ciphertext");
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}