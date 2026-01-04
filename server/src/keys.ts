/**
 * Server-side ECDH key management
 * Server generates a key pair on startup
 * Derives per-client shared secrets
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const KEY_FILE = '/tmp/sage-server-keys.json';

interface ServerKeys {
  publicKey: string;  // base64 encoded raw public key
  privateKey: string; // base64 encoded private key (PEM)
}

interface ClientSession {
  sharedSecret: Buffer;
  createdAt: number;
}

// In-memory cache of client sessions
const clientSessions = new Map<string, ClientSession>();

let serverKeyPair: crypto.KeyPairKeyObjectResult | null = null;
let serverPublicKeyBase64: string | null = null;

// Initialize server key pair
export function initServerKeys(): void {
  // Try to load existing keys
  if (fs.existsSync(KEY_FILE)) {
    try {
      const stored = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8')) as ServerKeys;

      // Import the private key
      const privateKey = crypto.createPrivateKey({
        key: Buffer.from(stored.privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });

      // Derive public key from private
      const publicKey = crypto.createPublicKey(privateKey);

      serverKeyPair = { publicKey, privateKey };
      serverPublicKeyBase64 = stored.publicKey;

      console.log('[Keys] Loaded existing server key pair');
      return;
    } catch (e) {
      console.log('[Keys] Failed to load existing keys, generating new ones');
    }
  }

  // Generate new key pair
  console.log('[Keys] Generating new server ECDH key pair...');
  serverKeyPair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1', // P-256
  });

  // Export public key as raw bytes (uncompressed point format)
  const publicKeyBuffer = serverKeyPair.publicKey.export({
    type: 'spki',
    format: 'der',
  });

  // Extract raw public key (last 65 bytes of SPKI for P-256)
  // SPKI format: SEQUENCE { SEQUENCE { OID, OID }, BIT STRING { raw key } }
  const rawPublicKey = publicKeyBuffer.slice(-65);
  serverPublicKeyBase64 = rawPublicKey.toString('base64');

  // Export private key for storage
  const privateKeyDer = serverKeyPair.privateKey.export({
    type: 'pkcs8',
    format: 'der',
  });

  // Store keys
  const stored: ServerKeys = {
    publicKey: serverPublicKeyBase64,
    privateKey: privateKeyDer.toString('base64'),
  };

  fs.writeFileSync(KEY_FILE, JSON.stringify(stored));
  console.log('[Keys] Server key pair generated and stored');
}

// Get server's public key for client
export function getServerPublicKey(): string {
  if (!serverPublicKeyBase64) {
    throw new Error('Server keys not initialized');
  }
  return serverPublicKeyBase64;
}

// Perform key exchange with client
export function performKeyExchange(clientPublicKeyBase64: string): string {
  if (!serverKeyPair) {
    throw new Error('Server keys not initialized');
  }

  // Import client's public key
  const clientPublicKeyRaw = Buffer.from(clientPublicKeyBase64, 'base64');

  // Build SPKI format for the client's raw public key
  // P-256 SPKI header
  const spkiHeader = Buffer.from([
    0x30, 0x59, // SEQUENCE, length 89
    0x30, 0x13, // SEQUENCE, length 19
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID prime256v1
    0x03, 0x42, 0x00, // BIT STRING, length 66, no unused bits
  ]);

  const clientPublicKeySpki = Buffer.concat([spkiHeader, clientPublicKeyRaw]);

  const clientPublicKey = crypto.createPublicKey({
    key: clientPublicKeySpki,
    format: 'der',
    type: 'spki',
  });

  // Derive shared secret using ECDH
  const sharedSecret = crypto.diffieHellman({
    privateKey: serverKeyPair.privateKey,
    publicKey: clientPublicKey,
  });

  // Hash the shared secret to get a proper AES key
  const aesKey = crypto.createHash('sha256').update(sharedSecret).digest();

  // Store session (use client public key as session ID)
  const sessionId = clientPublicKeyBase64.slice(0, 32);
  clientSessions.set(sessionId, {
    sharedSecret: aesKey,
    createdAt: Date.now(),
  });

  console.log(`[Keys] Key exchange completed for session ${sessionId.slice(0, 8)}...`);

  return sessionId;
}

// Get shared secret for a session
export function getSharedSecret(sessionId: string): Buffer | null {
  const session = clientSessions.get(sessionId);
  return session?.sharedSecret || null;
}

// Encrypt data for client
export function encryptForClient(plaintext: string, sessionId: string): string {
  const sharedSecret = getSharedSecret(sessionId);
  if (!sharedSecret) {
    throw new Error('Session not found');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sharedSecret, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Combine: iv (12) + authTag (16) + ciphertext
  const result = Buffer.concat([iv, authTag, encrypted]);
  return result.toString('base64');
}

// Decrypt data from client
export function decryptFromClient(base64Data: string, sessionId: string): string {
  const sharedSecret = getSharedSecret(sessionId);
  if (!sharedSecret) {
    throw new Error('Session not found');
  }

  const data = Buffer.from(base64Data, 'base64');

  const iv = data.slice(0, 12);
  const authTag = data.slice(12, 28);
  const ciphertext = data.slice(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', sharedSecret, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

// Clean up old sessions (call periodically)
export function cleanupSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  const now = Date.now();
  for (const [sessionId, session] of clientSessions) {
    if (now - session.createdAt > maxAgeMs) {
      clientSessions.delete(sessionId);
      console.log(`[Keys] Cleaned up expired session ${sessionId.slice(0, 8)}...`);
    }
  }
}
