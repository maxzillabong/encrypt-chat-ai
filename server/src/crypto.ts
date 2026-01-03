import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Derives a 256-bit key from a passphrase using PBKDF2 (matches WebCrypto client)
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
}

/**
 * Encrypts plaintext with AES-256-GCM
 * Output format: salt (16) + iv (12) + ciphertext + tag (16)
 * This matches WebCrypto format where tag is appended to ciphertext
 */
export function encrypt(plaintext: string, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  // Format: salt + iv + ciphertext + tag (matches WebCrypto output)
  return Buffer.concat([salt, iv, encrypted, tag]);
}

/**
 * Decrypts ciphertext encrypted with encrypt() or WebCrypto
 * Input format: salt (16) + iv (12) + ciphertext + tag (16)
 */
export function decrypt(data: Buffer, passphrase: string): string {
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  // Tag is the last 16 bytes
  const tag = data.subarray(data.length - TAG_LENGTH);
  // Ciphertext is between iv and tag
  const ciphertext = data.subarray(SALT_LENGTH + IV_LENGTH, data.length - TAG_LENGTH);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString('utf8');
}

/**
 * Encrypts and returns as base64 for transport
 */
export function encryptToBase64(plaintext: string, passphrase: string): string {
  return encrypt(plaintext, passphrase).toString('base64');
}

/**
 * Decrypts from base64
 */
export function decryptFromBase64(base64Data: string, passphrase: string): string {
  return decrypt(Buffer.from(base64Data, 'base64'), passphrase);
}
