import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;

/**
 * Derives a 256-bit key from a passphrase using scrypt
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

/**
 * Encrypts plaintext with AES-256-GCM
 * Output format: salt (16) + iv (12) + tag (16) + ciphertext
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

  // Combine: salt + iv + tag + ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]);
}

/**
 * Decrypts ciphertext encrypted with encrypt()
 */
export function decrypt(data: Buffer, passphrase: string): string {
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

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
