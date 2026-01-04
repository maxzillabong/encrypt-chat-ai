import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { spawn } from 'child_process';
import { decryptFromBase64, encryptToBase64 } from './crypto.js';
import { memory } from './memory.js';

const app = new Hono();

// Enable CORS for local development
app.use('/*', cors());

// Shared secret - in production, load from env
const SHARED_SECRET = process.env.ENCRYPT_CHAT_SECRET || 'change-me-in-production';

// Call Claude using CLI (uses OAuth token from server)
async function callClaudeCLI(prompt: string): Promise<string> {
  const { execSync } = await import('child_process');

  console.log('[Claude CLI] Calling with prompt length:', prompt.length);

  try {
    // Write prompt to temp file to avoid argument length issues
    const fs = await import('fs');
    const tmpFile = `/tmp/prompt-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, prompt);

    const result = execSync(`claude -p --output-format text "$(cat ${tmpFile})"`, {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env
    });

    fs.unlinkSync(tmpFile);
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
}

app.post('/proxy', async (c) => {
  try {
    const { data, sessionId = 'default' } = await c.req.json<EncryptedPayload>();

    // Decrypt the incoming request
    const decryptedJson = decryptFromBase64(data, SHARED_SECRET);
    const request: DecryptedRequest = JSON.parse(decryptedJson);

    console.log(`[Proxy] ${request.method} ${request.endpoint}`);

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

    // Add conversation history
    fullPrompt += messages.map(m => `${m.role}: ${m.content}`).join('\n\n');

    console.log(`[Proxy] Calling Claude CLI...`);

    // Call Claude using CLI with OAuth token
    const assistantResponse = await callClaudeCLI(fullPrompt);

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
app.get('/health', (c) => c.json({ status: 'ok', service: 'sage-proxy' }));

const port = parseInt(process.env.PORT || '3100');
console.log(`[Sage Proxy] Starting on port ${port}`);
console.log(`[Sage Proxy] Using Claude CLI with OAuth token`);

serve({ fetch: app.fetch, port });
