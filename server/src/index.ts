import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { decryptFromBase64, encryptToBase64 } from './crypto.js';
import { memory } from './memory.js';

const app = new Hono();

// Enable CORS for local development
app.use('/*', cors());

// Shared secret - in production, load from env
const SHARED_SECRET = process.env.ENCRYPT_CHAT_SECRET || 'change-me-in-production';
const CLAUDE_API_URL = process.env.CLAUDE_API_URL || 'https://api.anthropic.com';
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AUTH_TYPE = process.env.AUTH_TYPE || 'x-api-key'; // 'x-api-key' or 'bearer'

function getAuthHeaders(): Record<string, string> {
  if (AUTH_TYPE === 'bearer') {
    return { 'Authorization': `Bearer ${CLAUDE_API_KEY}` };
  }
  return { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' };
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

    // If this is a messages request, add memory context
    if (request.endpoint === '/v1/messages' && request.body?.messages) {
      const lastUserMessage = request.body.messages
        .filter(m => m.role === 'user')
        .pop();

      if (lastUserMessage) {
        // Store the user message
        await memory.store(sessionId, 'user', lastUserMessage.content);

        // Recall relevant context
        const relevantMemories = await memory.recall(lastUserMessage.content, 5);

        if (relevantMemories.length > 0) {
          const memoryContext = relevantMemories
            .filter(m => m.score > 0.3) // Only include relevant memories
            .map(m => `[${m.payload.role}]: ${m.payload.content}`)
            .join('\n');

          if (memoryContext) {
            // Prepend memory context to system prompt
            const existingSystem = request.body.system || '';
            request.body.system = `You are Sage, a wise and helpful AI assistant. You have memory of past conversations.

Here are relevant memories from previous conversations:
${memoryContext}

${existingSystem}`;
          }
        }
      }
    }

    // Forward to Claude API
    const response = await fetch(`${CLAUDE_API_URL}${request.endpoint}`, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
        ...request.headers
      },
      body: request.body ? JSON.stringify(request.body) : undefined
    });

    const responseData = await response.text();

    // Store assistant response in memory
    if (request.endpoint === '/v1/messages' && response.ok) {
      try {
        const parsed = JSON.parse(responseData);
        const assistantContent = parsed.content?.[0]?.text;
        if (assistantContent) {
          await memory.store(sessionId, 'assistant', assistantContent);
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }

    // Encrypt the response
    const encryptedResponse = encryptToBase64(JSON.stringify({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
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

// Streaming endpoint for chat completions
app.post('/proxy/stream', async (c) => {
  try {
    const { data } = await c.req.json<EncryptedPayload>();

    // Decrypt the incoming request
    const decryptedJson = decryptFromBase64(data, SHARED_SECRET);
    const request: DecryptedRequest = JSON.parse(decryptedJson);

    console.log(`[Proxy/Stream] ${request.method} ${request.endpoint}`);

    // Forward to Claude API with streaming
    const response = await fetch(`${CLAUDE_API_URL}${request.endpoint}`, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
        ...request.headers
      },
      body: request.body ? JSON.stringify(request.body) : undefined
    });

    if (!response.body) {
      throw new Error('No response body');
    }

    // For streaming, we encrypt each chunk
    const reader = response.body.getReader();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          return;
        }

        // Encrypt each chunk
        const chunk = new TextDecoder().decode(value);
        const encryptedChunk = encryptToBase64(chunk, SHARED_SECRET);
        controller.enqueue(encoder.encode(encryptedChunk + '\n'));
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  } catch (error) {
    console.error('[Proxy/Stream] Error:', error);
    return c.json({ error: 'Stream proxy error' }, 500);
  }
});

// Health check (unencrypted, just for monitoring)
app.get('/health', (c) => c.json({ status: 'ok', service: 'sage-proxy' }));

const port = parseInt(process.env.PORT || '3100');
console.log(`[Sage Proxy] Starting on port ${port}`);
console.log(`[Sage Proxy] Claude API: ${CLAUDE_API_URL}`);

serve({ fetch: app.fetch, port });
