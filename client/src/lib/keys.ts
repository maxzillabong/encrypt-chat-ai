/**
 * Signal-style asymmetric key management using ECDH
 * Keys are generated once and stored in IndexedDB
 */

const DB_NAME = 'sage-keys';
const STORE_NAME = 'keypair';
const KEY_ID = 'identity';

interface StoredKeyPair {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  createdAt: number;
}

// Open IndexedDB
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

// Generate new ECDH key pair
async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true, // extractable - needed to store in IndexedDB
    ['deriveKey', 'deriveBits']
  );
}

// Export key to JWK format for storage
async function exportKeyPair(keyPair: CryptoKeyPair): Promise<StoredKeyPair> {
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey('jwk', keyPair.publicKey),
    crypto.subtle.exportKey('jwk', keyPair.privateKey),
  ]);

  return {
    publicKey,
    privateKey,
    createdAt: Date.now(),
  };
}

// Import key from JWK format
async function importKeyPair(stored: StoredKeyPair): Promise<CryptoKeyPair> {
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.importKey(
      'jwk',
      stored.publicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    ),
    crypto.subtle.importKey(
      'jwk',
      stored.privateKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    ),
  ]);

  return { publicKey, privateKey };
}

// Store key pair in IndexedDB
async function storeKeyPair(stored: StoredKeyPair): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put({ id: KEY_ID, ...stored });

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Load key pair from IndexedDB
async function loadKeyPair(): Promise<StoredKeyPair | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(KEY_ID);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (request.result) {
        const { id, ...keyPair } = request.result;
        resolve(keyPair as StoredKeyPair);
      } else {
        resolve(null);
      }
    };
  });
}

// Get or create identity key pair
export async function getOrCreateKeyPair(): Promise<CryptoKeyPair> {
  // Try to load existing key pair
  const stored = await loadKeyPair();

  if (stored) {
    console.log('[Keys] Loaded existing key pair from IndexedDB');
    return importKeyPair(stored);
  }

  // Generate new key pair
  console.log('[Keys] Generating new ECDH key pair...');
  const keyPair = await generateKeyPair();
  const exported = await exportKeyPair(keyPair);
  await storeKeyPair(exported);
  console.log('[Keys] Key pair stored in IndexedDB');

  return keyPair;
}

// Get public key as base64 for transmission
export async function getPublicKeyBase64(keyPair: CryptoKeyPair): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const bytes = new Uint8Array(exported);

  // Convert to base64 without stack overflow
  const CHUNK_SIZE = 0x8000;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    result += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(result);
}

// Import server's public key from base64
export async function importServerPublicKey(base64: string): Promise<CryptoKey> {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

// Derive shared secret using ECDH
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  serverPublicKey: CryptoKey
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: serverPublicKey,
    },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable
    ['encrypt', 'decrypt']
  );
}

// Encrypt with derived key
export async function encryptWithKey(plaintext: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  );

  // Combine iv + ciphertext
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);

  // Convert to base64 without stack overflow
  const CHUNK_SIZE = 0x8000;
  let base64 = '';
  for (let i = 0; i < result.length; i += CHUNK_SIZE) {
    const chunk = result.subarray(i, i + CHUNK_SIZE);
    base64 += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(base64);
}

// Decrypt with derived key
export async function decryptWithKey(base64Data: string, key: CryptoKey): Promise<string> {
  const binaryString = atob(base64Data);
  const data = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    data[i] = binaryString.charCodeAt(i);
  }

  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}
