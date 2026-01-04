import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { spawn } from 'child_process';
import { decryptFromBase64, encryptToBase64 } from './crypto.js';
import { memory } from './memory.js';
import {
  initServerKeys,
  getServerPublicKey,
  performKeyExchange,
  encryptForClient,
  decryptFromClient,
} from './keys.js';
import * as fs from 'fs';
import * as path from 'path';

const app = new Hono();

// Enable CORS for local development
app.use('/*', cors());

// Initialize server ECDH keys
initServerKeys();

// Legacy shared secret (will be deprecated)
const SHARED_SECRET = process.env.ENCRYPT_CHAT_SECRET || 'change-me-in-production';

// File processing interface
interface AttachedFile {
  name: string;
  type: string;
  data: string; // base64
}

// Extract text from various file types
async function extractFileContent(file: AttachedFile): Promise<string> {
  const buffer = Buffer.from(file.data, 'base64');

  try {
    if (file.type.startsWith('image/')) {
      // Images are handled separately via Claude CLI --image flag
      return `[Image: ${file.name}]`;
    }

    if (file.type === 'application/pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(buffer);
      console.log(`[File] Extracted ${result.text.length} chars from PDF: ${file.name}`);
      return `\n--- Content from ${file.name} ---\n${result.text}\n--- End of ${file.name} ---\n`;
    }

    if (file.type.includes('word') || file.name.endsWith('.docx') || file.name.endsWith('.doc')) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      console.log(`[File] Extracted ${result.value.length} chars from Word: ${file.name}`);
      return `\n--- Content from ${file.name} ---\n${result.value}\n--- End of ${file.name} ---\n`;
    }

    if (file.type.includes('excel') || file.type.includes('spreadsheet') || file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      let text = '';
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        text += `\nSheet: ${sheetName}\n${csv}\n`;
      }
      console.log(`[File] Extracted ${text.length} chars from Excel: ${file.name}`);
      return `\n--- Content from ${file.name} ---\n${text}\n--- End of ${file.name} ---\n`;
    }

    if (file.type.startsWith('text/') || file.name.endsWith('.txt') || file.name.endsWith('.csv')) {
      const text = buffer.toString('utf-8');
      console.log(`[File] Read ${text.length} chars from text file: ${file.name}`);
      return `\n--- Content from ${file.name} ---\n${text}\n--- End of ${file.name} ---\n`;
    }

    return `[Unsupported file type: ${file.name}]`;
  } catch (error: any) {
    console.error(`[File] Error processing ${file.name}:`, error.message);
    return `[Error reading ${file.name}: ${error.message}]`;
  }
}

// Save image to temp file and return path
function saveImageToTemp(file: AttachedFile): string {
  const buffer = Buffer.from(file.data, 'base64');
  const ext = file.type.split('/')[1] || 'png';
  const tmpPath = `/tmp/image-${Date.now()}.${ext}`;
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

// Call Claude using CLI (uses OAuth token from server)
async function callClaudeCLI(prompt: string, imagePaths: string[] = []): Promise<string> {
  const { execSync } = await import('child_process');

  console.log('[Claude CLI] Calling with prompt length:', prompt.length, 'images:', imagePaths.length);

  try {
    // Write prompt to temp file to avoid argument length issues
    const tmpFile = `/tmp/prompt-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, prompt);

    // Build command with optional image flags
    let cmd = `claude -p --output-format text`;
    for (const imgPath of imagePaths) {
      cmd += ` --image "${imgPath}"`;
    }
    cmd += ` "$(cat ${tmpFile})"`;

    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env
    });

    // Cleanup
    fs.unlinkSync(tmpFile);
    for (const imgPath of imagePaths) {
      try { fs.unlinkSync(imgPath); } catch (e) {}
    }

    console.log('[Claude CLI] Got response length:', result.length);
    return result.trim();
  } catch (error: any) {
    console.log('[Claude CLI] Error:', error.message);
    throw error;
  }
}

interface EncryptedPayload {
  data: string; // base64 encrypted data
  sessionId?: string;
}

interface DecryptedRequest {
  endpoint: string;
  method: string;
  headers?: Record<string, string>;
  body?: {
    model?: string;
    max_tokens?: number;
    system?: string;
    messages?: Array<{ role: string; content: string }>;
    [key: string]: unknown;
  };
  files?: AttachedFile[];
}

app.post('/proxy', async (c) => {
  try {
    const { data, sessionId = 'default' } = await c.req.json<EncryptedPayload>();

    // Decrypt the incoming request
    const decryptedJson = decryptFromBase64(data, SHARED_SECRET);
    const request: DecryptedRequest = JSON.parse(decryptedJson);

    console.log(`[Proxy] ${request.method} ${request.endpoint}`);

    // Process files if present
    const files = request.files || [];
    const imagePaths: string[] = [];
    let fileContext = '';

    if (files.length > 0) {
      console.log(`[Proxy] Processing ${files.length} files...`);

      for (const file of files) {
        if (file.type.startsWith('image/')) {
          // Save images to temp files for Claude CLI
          const imgPath = saveImageToTemp(file);
          imagePaths.push(imgPath);
          console.log(`[Proxy] Saved image: ${file.name} -> ${imgPath}`);
        } else {
          // Extract text from documents
          const content = await extractFileContent(file);
          fileContext += content;
        }
      }
    }

    // Build the prompt from messages
    const messages = request.body?.messages || [];
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();

    if (lastUserMessage) {
      // Store the user message
      await memory.store(sessionId, 'user', lastUserMessage.content);
    }

    // Recall relevant context
    const relevantMemories = lastUserMessage
      ? await memory.recall(lastUserMessage.content, 5)
      : [];

    // Build full prompt with context
    let fullPrompt = '';

    if (relevantMemories.length > 0) {
      const memoryContext = relevantMemories
        .filter(m => m.score > 0.3)
        .map(m => `[${m.payload.role}]: ${m.payload.content}`)
        .join('\n');

      if (memoryContext) {
        fullPrompt += `Previous conversation context:\n${memoryContext}\n\n`;
      }
    }

    // Add file context if any
    if (fileContext) {
      fullPrompt += `Attached documents:\n${fileContext}\n\n`;
    }

    // Add conversation history
    fullPrompt += messages.map(m => `${m.role}: ${m.content}`).join('\n\n');

    console.log(`[Proxy] Calling Claude CLI with ${imagePaths.length} images...`);

    // Call Claude using CLI with OAuth token and images
    const assistantResponse = await callClaudeCLI(fullPrompt, imagePaths);

    // Store assistant response in memory
    await memory.store(sessionId, 'assistant', assistantResponse);

    // Format response like Claude API
    const responseData = JSON.stringify({
      content: [{ type: 'text', text: assistantResponse }],
      model: request.body?.model || 'claude-sonnet-4-20250514',
      role: 'assistant'
    });

    // Encrypt the response
    const encryptedResponse = encryptToBase64(JSON.stringify({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: responseData
    }), SHARED_SECRET);

    return c.json({ data: encryptedResponse });
  } catch (error) {
    console.error('[Proxy] Error:', error);

    // Encrypt error response too
    const encryptedError = encryptToBase64(JSON.stringify({
      status: 500,
      body: JSON.stringify({ error: 'Proxy error' })
    }), SHARED_SECRET);

    return c.json({ data: encryptedError }, 500);
  }
});


// Streaming endpoint using SSE
app.post('/proxy/stream', async (c) => {
  try {
    const { data, sessionId = 'default' } = await c.req.json<EncryptedPayload>();

    // Decrypt the incoming request
    const decryptedJson = decryptFromBase64(data, SHARED_SECRET);
    const request: DecryptedRequest = JSON.parse(decryptedJson);

    console.log(`[Proxy/Stream] ${request.method} ${request.endpoint}`);

    // Build the prompt from messages
    const messages = request.body?.messages || [];
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();

    if (lastUserMessage) {
      await memory.store(sessionId, 'user', lastUserMessage.content);
    }

    // Recall relevant context
    const relevantMemories = lastUserMessage
      ? await memory.recall(lastUserMessage.content, 5)
      : [];

    let fullPrompt = '';
    if (relevantMemories.length > 0) {
      const memoryContext = relevantMemories
        .filter(m => m.score > 0.3)
        .map(m => `[${m.payload.role}]: ${m.payload.content}`)
        .join('\n');
      if (memoryContext) {
        fullPrompt += `Previous conversation context:\n${memoryContext}\n\n`;
      }
    }
    fullPrompt += messages.map(m => `${m.role}: ${m.content}`).join('\n\n');

    // Write prompt to temp file
    const fs = await import('fs');
    const tmpFile = `/tmp/prompt-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, fullPrompt);

    console.log(`[Proxy/Stream] Starting Claude CLI stream...`);

    // Create SSE stream
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let fullResponse = '';

        const proc = spawn('sh', ['-c', `claude -p --output-format text "$(cat ${tmpFile})"`], {
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        proc.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          fullResponse += text;

          // Encrypt and send chunk
          const encryptedChunk = encryptToBase64(text, SHARED_SECRET);
          controller.enqueue(encoder.encode(`data: ${encryptedChunk}\n\n`));
        });

        proc.stderr.on('data', (chunk: Buffer) => {
          console.log('[Proxy/Stream] stderr:', chunk.toString());
        });

        proc.on('close', async (code) => {
          console.log(`[Proxy/Stream] Claude CLI closed with code ${code}`);

          // Clean up temp file
          try { fs.unlinkSync(tmpFile); } catch (e) {}

          // Store full response in memory
          if (fullResponse) {
            await memory.store(sessionId, 'assistant', fullResponse);
          }

          // Send done event
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        });

        proc.on('error', (err) => {
          console.log('[Proxy/Stream] Error:', err.message);
          controller.error(err);
        });
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('[Proxy/Stream] Error:', error);
    return c.json({ error: 'Stream error' }, 500);
  }
});

// Health check (unencrypted, just for monitoring)
// Key exchange endpoint - client sends public key, server responds with its public key
app.post('/key-exchange', async (c) => {
  try {
    const { clientPublicKey } = await c.req.json<{ clientPublicKey: string }>();

    if (!clientPublicKey) {
      return c.json({ error: 'Missing clientPublicKey' }, 400);
    }

    // Perform ECDH key exchange
    const sessionId = performKeyExchange(clientPublicKey);
    const serverPublicKey = getServerPublicKey();

    console.log(`[KeyExchange] New session established: ${sessionId.slice(0, 8)}...`);

    return c.json({
      serverPublicKey,
      sessionId,
    });
  } catch (error: any) {
    console.error('[KeyExchange] Error:', error.message);
    return c.json({ error: 'Key exchange failed' }, 500);
  }
});

// New secure proxy endpoint using ECDH-derived keys
app.post('/proxy/secure', async (c) => {
  try {
    const { data, sessionId } = await c.req.json<{ data: string; sessionId: string }>();

    if (!sessionId) {
      return c.json({ error: 'Missing sessionId - perform key exchange first' }, 400);
    }

    // Decrypt using ECDH-derived key
    const decryptedJson = decryptFromClient(data, sessionId);
    const request: DecryptedRequest = JSON.parse(decryptedJson);

    console.log(`[Proxy/Secure] ${request.method} ${request.endpoint}`);

    // Process files if present
    const files = request.files || [];
    const imagePaths: string[] = [];
    let fileContext = '';

    if (files.length > 0) {
      console.log(`[Proxy/Secure] Processing ${files.length} files...`);

      for (const file of files) {
        if (file.type.startsWith('image/')) {
          const imgPath = saveImageToTemp(file);
          imagePaths.push(imgPath);
        } else {
          const content = await extractFileContent(file);
          fileContext += content;
        }
      }
    }

    // Build the prompt
    const messages = request.body?.messages || [];
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();

    if (lastUserMessage) {
      await memory.store(sessionId, 'user', lastUserMessage.content);
    }

    const relevantMemories = lastUserMessage
      ? await memory.recall(lastUserMessage.content, 5)
      : [];

    let fullPrompt = '';

    if (relevantMemories.length > 0) {
      const memoryContext = relevantMemories
        .filter(m => m.score > 0.3)
        .map(m => `[${m.payload.role}]: ${m.payload.content}`)
        .join('\n');

      if (memoryContext) {
        fullPrompt += `Previous conversation context:\n${memoryContext}\n\n`;
      }
    }

    if (fileContext) {
      fullPrompt += `Attached documents:\n${fileContext}\n\n`;
    }

    fullPrompt += messages.map(m => `${m.role}: ${m.content}`).join('\n\n');

    console.log(`[Proxy/Secure] Calling Claude CLI...`);

    const assistantResponse = await callClaudeCLI(fullPrompt, imagePaths);
    await memory.store(sessionId, 'assistant', assistantResponse);

    const responseData = JSON.stringify({
      content: [{ type: 'text', text: assistantResponse }],
      model: request.body?.model || 'claude-sonnet-4-20250514',
      role: 'assistant'
    });

    // Encrypt response using ECDH-derived key
    const encryptedResponse = encryptForClient(JSON.stringify({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: responseData
    }), sessionId);

    return c.json({ data: encryptedResponse });
  } catch (error: any) {
    console.error('[Proxy/Secure] Error:', error.message);
    return c.json({ error: 'Secure proxy error' }, 500);
  }
});

// Health check (unencrypted, just for monitoring)
app.get('/health', (c) => c.json({ status: 'ok', service: 'sage-proxy', encryption: 'ecdh' }));

const port = parseInt(process.env.PORT || '3100');
console.log(`[Sage Proxy] Starting on port ${port}`);
console.log(`[Sage Proxy] Using Claude CLI with OAuth token`);

serve({ fetch: app.fetch, port });
