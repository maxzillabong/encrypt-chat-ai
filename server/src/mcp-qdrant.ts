#!/usr/bin/env node
/**
 * MCP Server for Qdrant memory
 * Allows Claude CLI to save/recall memories on command
 *
 * Usage: Configure in ~/.claude/settings.json:
 * {
 *   "mcpServers": {
 *     "memory": {
 *       "command": "node",
 *       "args": ["/path/to/mcp-qdrant.js"],
 *       "env": { "QDRANT_URL": "http://localhost:6333" }
 *     }
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = 'sage_memories';
const VECTOR_SIZE = 1536;

// Simple embedding function (same as memory.ts)
function embed(text: string): number[] {
  const vector = new Array(VECTOR_SIZE).fill(0);
  const words = text.toLowerCase().split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    for (let j = 0; j < word.length; j++) {
      const idx = (word.charCodeAt(j) * (i + 1) * (j + 1)) % VECTOR_SIZE;
      vector[idx] += 1 / (i + 1);
    }
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map(v => v / magnitude);
}

// Ensure collection exists
async function ensureCollection(): Promise<void> {
  try {
    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
    if (response.status === 404) {
      await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vectors: { size: VECTOR_SIZE, distance: 'Cosine' }
        })
      });
    }
  } catch (error) {
    console.error('[MCP-Qdrant] Failed to ensure collection:', error);
  }
}

// Save a memory
async function saveMemory(content: string, tags: string[] = []): Promise<string> {
  await ensureCollection();

  const id = crypto.randomUUID();
  const vector = embed(content);

  await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [{
        id,
        vector,
        payload: {
          content,
          tags,
          type: 'explicit', // Marks this as explicitly saved by user
          timestamp: new Date().toISOString(),
        }
      }]
    })
  });

  return id;
}

// Search memories
async function searchMemories(query: string, limit = 5): Promise<any[]> {
  await ensureCollection();

  const vector = embed(query);

  const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true
    })
  });

  const data = await response.json();
  return data.result || [];
}

// List recent memories
async function listMemories(limit = 10): Promise<any[]> {
  await ensureCollection();

  const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit,
      with_payload: true,
    })
  });

  const data = await response.json();
  return data.result?.points || [];
}

// Delete a memory by ID
async function deleteMemory(id: string): Promise<boolean> {
  await ensureCollection();

  const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [id]
    })
  });

  return response.ok;
}

// Create MCP server
const server = new Server(
  { name: 'qdrant-memory', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'remember',
      description: 'Save information to long-term memory. Use this when the user asks you to remember something, or when you encounter important information worth saving for future reference.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The information to remember'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for categorization (e.g., ["project", "deadline"])'
          }
        },
        required: ['content']
      }
    },
    {
      name: 'recall',
      description: 'Search long-term memory for relevant information. Use this to find previously saved memories related to a topic.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for in memory'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 5)'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'list_memories',
      description: 'List recent memories. Use this to see what has been saved.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 10)'
          }
        }
      }
    },
    {
      name: 'forget',
      description: 'Delete a specific memory by its ID. Use this when asked to forget something.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The memory ID to delete'
          }
        },
        required: ['id']
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'remember': {
        const { content, tags = [] } = args as { content: string; tags?: string[] };
        const id = await saveMemory(content, tags);
        return {
          content: [{ type: 'text', text: `Saved to memory (ID: ${id})` }]
        };
      }

      case 'recall': {
        const { query, limit = 5 } = args as { query: string; limit?: number };
        const results = await searchMemories(query, limit);

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No relevant memories found.' }]
          };
        }

        const formatted = results.map((r, i) =>
          `${i + 1}. [Score: ${r.score.toFixed(2)}] ${r.payload.content}${r.payload.tags?.length ? ` (tags: ${r.payload.tags.join(', ')})` : ''}`
        ).join('\n');

        return {
          content: [{ type: 'text', text: `Found ${results.length} memories:\n${formatted}` }]
        };
      }

      case 'list_memories': {
        const { limit = 10 } = args as { limit?: number };
        const memories = await listMemories(limit);

        if (memories.length === 0) {
          return {
            content: [{ type: 'text', text: 'No memories saved yet.' }]
          };
        }

        const formatted = memories.map((m, i) =>
          `${i + 1}. [${m.id.slice(0, 8)}...] ${m.payload.content?.slice(0, 100)}${m.payload.content?.length > 100 ? '...' : ''}`
        ).join('\n');

        return {
          content: [{ type: 'text', text: `${memories.length} memories:\n${formatted}` }]
        };
      }

      case 'forget': {
        const { id } = args as { id: string };
        const success = await deleteMemory(id);
        return {
          content: [{ type: 'text', text: success ? `Memory ${id} deleted.` : `Failed to delete memory ${id}.` }]
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

// List resources (memories as resources)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const memories = await listMemories(20);
  return {
    resources: memories.map(m => ({
      uri: `memory://${m.id}`,
      name: m.payload.content?.slice(0, 50) || 'Memory',
      mimeType: 'text/plain'
    }))
  };
});

// Read a specific memory resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const id = request.params.uri.replace('memory://', '');

  const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/${id}`);
  const data = await response.json();

  if (!data.result) {
    throw new Error('Memory not found');
  }

  return {
    contents: [{
      uri: request.params.uri,
      mimeType: 'text/plain',
      text: JSON.stringify(data.result.payload, null, 2)
    }]
  };
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP-Qdrant] Server started');
}

main().catch(console.error);
