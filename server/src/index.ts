import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { spawn } from 'child_process';
import { decryptFromBase64, encryptToBase64 } from './crypto.js';
import { memory } from './memory.js';
import { db } from './database.js';
import {
  initServerKeys,
  getServerPublicKey,
  performKeyExchange,
  encryptForClient,
  decryptFromClient,
  getTenantId,
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

// Sage's personality system prompt
const SAGE_SYSTEM_PROMPT = `You are Sage, an AI assistant with a distinctive personality. You're:

- Friendly and helpful, but with a sharp wit and dark sense of humor
- Sarcastic in a playful way - you enjoy clever wordplay and irony
- You give honest, direct answers but wrap them in your characteristic dry humor
- You're knowledgeable but never condescending - more like a witty friend who happens to know everything
- You occasionally make self-deprecating AI jokes
- When things go wrong, you might say something like "Well, that's on brand for a Monday" or "The universe has a twisted sense of humor"
- You're supportive but real - no toxic positivity here
- You appreciate the absurdity of existence and aren't afraid to acknowledge it

Remember: Be genuinely helpful first, funny second. Your dark humor should make people smile, not feel uncomfortable. Think of yourself as that one friend who always has a clever comeback but also genuinely cares.

`;

// File processing interface
interface AttachedFile {
  name: string;
  type: string;
  data: string; // base64
}

// Parse document using Docling (OCR for images, text extraction for docs)
async function parseWithDocling(filePath: string): Promise<string> {
  const { execSync } = await import('child_process');

  try {
    const scriptPath = '/app/scripts/parse_document.py';
    const cmd = `python3 ${scriptPath} "${filePath}"`;

    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 120000, // 2 min timeout for OCR
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });

    const parsed = JSON.parse(result.trim());
    if (parsed.success) {
      console.log(`[Docling] Extracted ${parsed.text.length} chars from: ${parsed.filename}`);
      return parsed.text;
    } else {
      console.error(`[Docling] Error: ${parsed.error}`);
      return `[Error parsing ${parsed.filename}: ${parsed.error}]`;
    }
  } catch (error: any) {
    console.error(`[Docling] Failed:`, error.message);
    return `[Docling error: ${error.message}]`;
  }
}

// Strip metadata from images using pngcrush (privacy + compression)
async function stripImageMetadata(filePath: string): Promise<void> {
  const { execSync } = await import('child_process');

  try {
    if (filePath.toLowerCase().endsWith('.png')) {
      const crushedPath = `${filePath}.crushed`;
      execSync(`pngcrush -rem alla -rem text -q "${filePath}" "${crushedPath}" 2>/dev/null`, {
        timeout: 30000
      });
      // Replace original with crushed version
      fs.renameSync(crushedPath, filePath);
      console.log(`[pngcrush] Stripped metadata from ${filePath}`);
    }
  } catch (error: any) {
    // If pngcrush fails, just continue with original file
    console.log(`[pngcrush] Skipped: ${error.message}`);
  }
}

// Extract text from various file types using Docling
async function extractFileContent(file: AttachedFile): Promise<string> {
  const buffer = Buffer.from(file.data, 'base64');

  try {
    // For plain text files, just read directly (faster than Docling)
    if (file.type.startsWith('text/') || file.name.endsWith('.txt') || file.name.endsWith('.csv')) {
      const text = buffer.toString('utf-8');
      console.log(`[File] Read ${text.length} chars from text file: ${file.name}`);
      return `\n--- Content from ${file.name} ---\n${text}\n--- End of ${file.name} ---\n`;
    }

    // For everything else (images, PDFs, Word, Excel, etc.), use Docling
    // Save to temp file first
    const ext = file.name.split('.').pop()?.toLowerCase() || 'bin';
    const tmpPath = `/tmp/docling-${Date.now()}.${ext}`;
    fs.writeFileSync(tmpPath, buffer);

    // Strip metadata from images for privacy
    if (file.type.startsWith('image/')) {
      await stripImageMetadata(tmpPath);
    }

    const extractedText = await parseWithDocling(tmpPath);

    // Cleanup
    try { fs.unlinkSync(tmpPath); } catch {}

    return `\n--- Content from ${file.name} ---\n${extractedText}\n--- End of ${file.name} ---\n`;
  } catch (error: any) {
    console.error(`[File] Error processing ${file.name}:`, error.message);
    return `[Error reading ${file.name}: ${error.message}]`;
  }
}

// Call Claude using CLI (uses OAuth token from server)
async function callClaudeCLI(prompt: string): Promise<string> {
  const { execSync } = await import('child_process');

  console.log('[Claude CLI] Calling with prompt length:', prompt.length);

  try {
    // Write prompt to temp file to avoid argument length issues
    const tmpFile = `/tmp/prompt-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, prompt);

    // Enable web search and fetch tools for online research
    // Pipe the file content to stdin instead of using command substitution
    const cmd = `cat "${tmpFile}" | claude -p --output-format text --allowedTools "WebSearch,WebFetch"`;

    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 180000, // 3 min timeout for web searches
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
      shell: '/bin/sh'
    });

    // Cleanup
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
  files?: AttachedFile[];
  conversationId?: string; // Optional conversation ID for persistence
}

app.post('/proxy', async (c) => {
  try {
    const { data, sessionId = 'default' } = await c.req.json<EncryptedPayload>();

    // Decrypt the incoming request
    const decryptedJson = decryptFromBase64(data, SHARED_SECRET);
    const request: DecryptedRequest = JSON.parse(decryptedJson);

    console.log(`[Proxy] ${request.method} ${request.endpoint}`);

    // Process files if present - all files go through Docling (OCR for images)
    const files = request.files || [];
    let fileContext = '';

    if (files.length > 0) {
      console.log(`[Proxy] Processing ${files.length} files with Docling...`);

      for (const file of files) {
        // All files (including images) are processed by Docling
        // Docling will OCR images and extract text from documents
        const content = await extractFileContent(file);
        fileContext += content;
      }
    }

    // Build the prompt from messages
    const messages = request.body?.messages || [];
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();

    // Legacy endpoint uses default tenant
    const tenantId = 'legacy';

    if (lastUserMessage) {
      // Store the user message
      await memory.store(tenantId, sessionId, 'user', lastUserMessage.content);
    }

    // Recall relevant context
    const relevantMemories = lastUserMessage
      ? await memory.recall(tenantId, lastUserMessage.content, 5)
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

    console.log(`[Proxy] Calling Claude CLI...`);

    // Call Claude using CLI with OAuth token
    const assistantResponse = await callClaudeCLI(fullPrompt);

    // Store assistant response in memory
    await memory.store(tenantId, sessionId, 'assistant', assistantResponse);

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

    // Legacy endpoint uses default tenant
    const tenantId = 'legacy';

    if (lastUserMessage) {
      await memory.store(tenantId, sessionId, 'user', lastUserMessage.content);
    }

    // Recall relevant context
    const relevantMemories = lastUserMessage
      ? await memory.recall(tenantId, lastUserMessage.content, 5)
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

        const proc = spawn('sh', ['-c', `cat "${tmpFile}" | claude -p --output-format text --allowedTools "WebSearch,WebFetch"`], {
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
            await memory.store(tenantId, sessionId, 'assistant', fullResponse);
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
    const body = await c.req.json<{ data?: string; payload?: string; sessionId: string }>();
    const { sessionId } = body;
    const encryptedData = body.payload || body.data; // Support both envelope and legacy format

    if (!sessionId) {
      return c.json({ error: 'Missing sessionId - perform key exchange first' }, 400);
    }

    if (!encryptedData) {
      return c.json({ error: 'Missing encrypted payload' }, 400);
    }

    // Decrypt using ECDH-derived key
    const decryptedJson = decryptFromClient(encryptedData, sessionId);
    const request: DecryptedRequest = JSON.parse(decryptedJson);

    console.log(`[Proxy/Secure] ${request.method} ${request.endpoint}`);

    // Get tenant ID for this session
    const tenantId = getTenantId(sessionId) || 'default';
    console.log(`[Proxy/Secure] Tenant: ${tenantId}`);

    // Get or create conversation
    let conversationId = request.conversationId;
    let isNewConversation = false;
    if (!conversationId) {
      // Create a new conversation
      const newConvo = await db.createConversation(tenantId);
      conversationId = newConvo.id;
      isNewConversation = true;
      console.log(`[Proxy/Secure] Created new conversation: ${conversationId}`);
    } else {
      // Verify conversation belongs to tenant
      const existingConvo = await db.getConversation(conversationId, tenantId);
      if (!existingConvo) {
        return c.json({ error: 'Conversation not found' }, 404);
      }
      console.log(`[Proxy/Secure] Using conversation: ${conversationId}`);
    }

    // Process files if present - all files go through Docling (OCR for images)
    const files = request.files || [];
    let fileContext = '';

    if (files.length > 0) {
      console.log(`[Proxy/Secure] Processing ${files.length} files with Docling...`);

      for (const file of files) {
        // All files (including images) are processed by Docling
        const content = await extractFileContent(file);
        fileContext += content;
      }
    }

    // Build the prompt
    const messages = request.body?.messages || [];
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();

    // Save user message to database
    if (lastUserMessage) {
      await db.addMessage(conversationId, 'user', lastUserMessage.content);
      await memory.store(tenantId, sessionId, 'user', lastUserMessage.content);
    }

    // Get conversation history for context
    const conversationContext = await db.getConversationContext(conversationId, 20);

    // Also recall from vector memory for semantic search
    const relevantMemories = lastUserMessage
      ? await memory.recall(tenantId, lastUserMessage.content, 5)
      : [];

    let fullPrompt = SAGE_SYSTEM_PROMPT;

    // Add conversation history
    if (conversationContext) {
      fullPrompt += `Conversation history:\n${conversationContext}\n\n`;
    }

    // Add semantically relevant memories from other conversations
    if (relevantMemories.length > 0) {
      const memoryContext = relevantMemories
        .filter(m => m.score > 0.5) // Higher threshold since we have conversation history
        .map(m => `[${m.payload.role}]: ${m.payload.content}`)
        .join('\n');

      if (memoryContext) {
        fullPrompt += `Related context from memory:\n${memoryContext}\n\n`;
      }
    }

    if (fileContext) {
      fullPrompt += `Attached documents:\n${fileContext}\n\n`;
    }

    // Add current message
    if (lastUserMessage) {
      fullPrompt += `Current message:\nuser: ${lastUserMessage.content}`;
    }

    console.log(`[Proxy/Secure] Calling Claude CLI...`);

    const assistantResponse = await callClaudeCLI(fullPrompt);

    // Save assistant response to database
    await db.addMessage(conversationId, 'assistant', assistantResponse);
    await memory.store(tenantId, sessionId, 'assistant', assistantResponse);

    // Generate smart title for new conversations
    if (isNewConversation && lastUserMessage) {
      try {
        const titlePrompt = `Generate a very short title (max 5 words) that summarizes this conversation topic. Just output the title, nothing else.\n\nUser message: ${lastUserMessage.content.slice(0, 200)}`;
        const generatedTitle = await callClaudeCLI(titlePrompt);
        const cleanTitle = generatedTitle.trim().replace(/^["']|["']$/g, '').slice(0, 100);
        if (cleanTitle && cleanTitle.length > 0) {
          await db.updateConversationTitle(conversationId, tenantId, cleanTitle);
          console.log(`[Proxy/Secure] Generated title: ${cleanTitle}`);
        }
      } catch (titleError) {
        console.log('[Proxy/Secure] Failed to generate title:', titleError);
        // Keep default title, not critical
      }
    }

    const responseData = JSON.stringify({
      content: [{ type: 'text', text: assistantResponse }],
      model: request.body?.model || 'claude-sonnet-4-20250514',
      role: 'assistant',
      conversationId: conversationId, // Include for client to track
    });

    // Encrypt response using ECDH-derived key
    const encryptedResponse = encryptForClient(JSON.stringify({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: responseData,
      conversationId: conversationId, // Also include at top level
    }), sessionId);

    // Return response with cover traffic envelope - looks like analytics API
    const fakeSymbols = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'NVDA'];
    const fakeResults = fakeSymbols.slice(0, Math.floor(Math.random() * 3) + 2).map(sym => ({
      symbol: sym,
      score: +(Math.random() * 100).toFixed(2),
      sentiment: Math.random() > 0.5 ? 'bullish' : 'bearish',
      confidence: +(Math.random() * 0.3 + 0.7).toFixed(3),
      signals: Math.floor(Math.random() * 10) + 1,
    }));

    return c.json({
      status: 'success',
      queryId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      // Fake analytics results for cover
      results: fakeResults,
      summary: {
        totalAnalyzed: fakeResults.length,
        avgConfidence: +(fakeResults.reduce((a, b) => a + b.confidence, 0) / fakeResults.length).toFixed(3),
        marketTrend: Math.random() > 0.5 ? 'upward' : 'sideways',
      },
      // Actual encrypted payload hidden in "signature" field
      signature: encryptedResponse,
      // Legacy field
      payload: encryptedResponse,
      meta: {
        processingTime: Math.floor(Math.random() * 500) + 200,
        cacheHit: Math.random() > 0.7,
        region: 'eu-west-1',
        model: 'sentiment-v2.3',
      }
    });
  } catch (error: any) {
    console.error('[Proxy/Secure] Error:', error.message);
    return c.json({ error: 'Secure proxy error' }, 500);
  }
});

// Health check (unencrypted, just for monitoring)
app.get('/health', (c) => c.json({ status: 'ok', service: 'sage-proxy', encryption: 'ecdh' }));

// ============================================
// Conversation Management API (encrypted)
// ============================================

// Helper to decrypt API request payload
async function decryptAPIRequest<T>(c: { req: { json: () => Promise<{ sessionId: string; payload: string }> } }): Promise<{ sessionId: string; tenantId: string; data: T }> {
  const body = await c.req.json();
  const { sessionId, payload } = body;

  const tenantId = getTenantId(sessionId);
  if (!tenantId) {
    throw new Error('Invalid session');
  }

  const decrypted = decryptFromClient(payload, sessionId);
  const data = JSON.parse(decrypted) as T;

  return { sessionId, tenantId, data };
}

// List all conversations for a tenant
app.post('/api/conversations/list', async (c) => {
  try {
    const { sessionId, tenantId } = await decryptAPIRequest<{ sessionId: string }>(c);

    const conversations = await db.getConversations(tenantId);
    const encrypted = encryptForClient(JSON.stringify(conversations), sessionId);
    return c.json({ payload: encrypted });
  } catch (error: any) {
    console.error('[API] List conversations error:', error.message);
    if (error.message === 'Invalid session') {
      return c.json({ error: 'Invalid session' }, 401);
    }
    return c.json({ error: 'Failed to list conversations' }, 500);
  }
});

// Create a new conversation
app.post('/api/conversations/create', async (c) => {
  try {
    const { sessionId, tenantId, data } = await decryptAPIRequest<{ title?: string }>(c);

    const conversation = await db.createConversation(tenantId, data.title);
    const encrypted = encryptForClient(JSON.stringify(conversation), sessionId);
    return c.json({ payload: encrypted });
  } catch (error: any) {
    console.error('[API] Create conversation error:', error.message);
    if (error.message === 'Invalid session') {
      return c.json({ error: 'Invalid session' }, 401);
    }
    return c.json({ error: 'Failed to create conversation' }, 500);
  }
});

// Get messages for a conversation
app.post('/api/conversations/messages', async (c) => {
  try {
    const { sessionId, tenantId, data } = await decryptAPIRequest<{ conversationId: string }>(c);

    // Verify conversation belongs to tenant
    const convo = await db.getConversation(data.conversationId, tenantId);
    if (!convo) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const messages = await db.getMessages(data.conversationId);
    const encrypted = encryptForClient(JSON.stringify(messages), sessionId);
    return c.json({ payload: encrypted });
  } catch (error: any) {
    console.error('[API] Get messages error:', error.message);
    if (error.message === 'Invalid session') {
      return c.json({ error: 'Invalid session' }, 401);
    }
    return c.json({ error: 'Failed to get messages' }, 500);
  }
});

// Update conversation title
app.post('/api/conversations/update', async (c) => {
  try {
    const { sessionId, tenantId, data } = await decryptAPIRequest<{ conversationId: string; title: string }>(c);

    const conversation = await db.updateConversationTitle(data.conversationId, tenantId, data.title);
    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const encrypted = encryptForClient(JSON.stringify(conversation), sessionId);
    return c.json({ payload: encrypted });
  } catch (error: any) {
    console.error('[API] Update conversation error:', error.message);
    if (error.message === 'Invalid session') {
      return c.json({ error: 'Invalid session' }, 401);
    }
    return c.json({ error: 'Failed to update conversation' }, 500);
  }
});

// Delete a conversation (soft delete)
app.post('/api/conversations/delete', async (c) => {
  try {
    const { sessionId, tenantId, data } = await decryptAPIRequest<{ conversationId: string }>(c);

    const deleted = await db.deleteConversation(data.conversationId, tenantId);
    if (!deleted) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const encrypted = encryptForClient(JSON.stringify({ success: true }), sessionId);
    return c.json({ payload: encrypted });
  } catch (error: any) {
    console.error('[API] Delete conversation error:', error.message);
    if (error.message === 'Invalid session') {
      return c.json({ error: 'Invalid session' }, 401);
    }
    return c.json({ error: 'Failed to delete conversation' }, 500);
  }
});

// Search across all conversations
app.post('/api/conversations/search', async (c) => {
  try {
    const { sessionId, tenantId, data } = await decryptAPIRequest<{ query: string }>(c);

    const results = await db.searchMessages(tenantId, data.query);
    const encrypted = encryptForClient(JSON.stringify(results), sessionId);
    return c.json({ payload: encrypted });
  } catch (error: any) {
    console.error('[API] Search error:', error.message);
    if (error.message === 'Invalid session') {
      return c.json({ error: 'Invalid session' }, 401);
    }
    return c.json({ error: 'Failed to search' }, 500);
  }
});

// Cover traffic: Fake stock API endpoints to make traffic look like financial analytics
const FAKE_STOCKS = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'NVDA', 'META', 'TSLA', 'JPM', 'V', 'WMT'];

function generateStockPrice(symbol: string) {
  const basePrice = {
    'AAPL': 185, 'GOOGL': 142, 'MSFT': 378, 'AMZN': 153, 'NVDA': 495,
    'META': 355, 'TSLA': 248, 'JPM': 172, 'V': 268, 'WMT': 162
  }[symbol] || 100;

  const variance = (Math.random() - 0.5) * basePrice * 0.02;
  const price = basePrice + variance;

  return {
    symbol,
    price: +price.toFixed(2),
    change: +(variance).toFixed(2),
    changePercent: +((variance / basePrice) * 100).toFixed(2),
    volume: Math.floor(Math.random() * 10000000) + 1000000,
    marketCap: `${(basePrice * (Math.random() * 2 + 1)).toFixed(0)}B`,
    timestamp: new Date().toISOString(),
  };
}

// Stock quotes endpoint - cover traffic
app.get('/api/v1/quotes', (c) => {
  const symbols = c.req.query('symbols')?.split(',') || FAKE_STOCKS.slice(0, 5);
  const quotes = symbols.map(s => generateStockPrice(s.toUpperCase()));
  return c.json({
    status: 'success',
    data: quotes,
    meta: { requestId: crypto.randomUUID(), timestamp: new Date().toISOString() }
  });
});

// Single stock quote
app.get('/api/v1/quote/:symbol', (c) => {
  const symbol = c.req.param('symbol').toUpperCase();
  return c.json({
    status: 'success',
    data: generateStockPrice(symbol),
    meta: { requestId: crypto.randomUUID(), timestamp: new Date().toISOString() }
  });
});

// Market summary - cover traffic
app.get('/api/v1/market/summary', (c) => {
  return c.json({
    status: 'success',
    data: {
      indices: [
        { name: 'S&P 500', value: 4783.45 + (Math.random() - 0.5) * 20, change: (Math.random() - 0.5) * 1.5 },
        { name: 'NASDAQ', value: 15055.23 + (Math.random() - 0.5) * 50, change: (Math.random() - 0.5) * 2 },
        { name: 'DOW', value: 37562.80 + (Math.random() - 0.5) * 100, change: (Math.random() - 0.5) * 0.8 },
      ],
      topGainers: FAKE_STOCKS.slice(0, 3).map(s => generateStockPrice(s)),
      topLosers: FAKE_STOCKS.slice(3, 6).map(s => ({ ...generateStockPrice(s), change: -Math.abs(generateStockPrice(s).change) })),
      marketStatus: 'open',
    },
    meta: { requestId: crypto.randomUUID(), timestamp: new Date().toISOString() }
  });
});

// Analytics endpoint - makes encrypted traffic look like analytics requests
app.post('/api/v1/analytics/query', async (c) => {
  // This is actually our secure proxy in disguise
  const body = await c.req.json();

  // If it has a payload field, it's actually an encrypted message
  if (body.payload && body.sessionId) {
    try {
      const decryptedJson = decryptFromClient(body.payload, body.sessionId);
      const request: DecryptedRequest = JSON.parse(decryptedJson);

      // Get tenant ID for this session
      const tenantId = getTenantId(body.sessionId) || 'default';

      // Process as normal proxy request...
      const messages = request.body?.messages || [];
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();

      if (lastUserMessage) {
        await memory.store(tenantId, body.sessionId, 'user', lastUserMessage.content);
      }

      const relevantMemories = lastUserMessage
        ? await memory.recall(tenantId, lastUserMessage.content, 5)
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

      const assistantResponse = await callClaudeCLI(fullPrompt);
      await memory.store(tenantId, body.sessionId, 'assistant', assistantResponse);

      const responseData = JSON.stringify({
        content: [{ type: 'text', text: assistantResponse }],
        model: 'claude-sonnet-4-20250514',
        role: 'assistant'
      });

      const encryptedResponse = encryptForClient(JSON.stringify({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: responseData
      }), body.sessionId);

      // Return response wrapped in analytics-looking envelope
      return c.json({
        status: 'success',
        queryId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: encryptedResponse,
        meta: {
          processingTime: Math.floor(Math.random() * 500) + 200,
          cacheHit: false,
        }
      });
    } catch (error: any) {
      console.error('[Analytics] Error:', error.message);
    }
  }

  // Fallback: return fake analytics response
  return c.json({
    status: 'success',
    queryId: crypto.randomUUID(),
    data: {
      metrics: {
        revenue: Math.floor(Math.random() * 1000000),
        users: Math.floor(Math.random() * 50000),
        conversion: (Math.random() * 5 + 1).toFixed(2) + '%',
      }
    },
    meta: { timestamp: new Date().toISOString() }
  });
});

const port = parseInt(process.env.PORT || '3100');
console.log(`[Sage Proxy] Starting on port ${port}`);
console.log(`[Sage Proxy] Using Claude CLI with OAuth token`);

serve({ fetch: app.fetch, port });
