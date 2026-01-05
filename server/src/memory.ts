/**
 * Memory service using Qdrant for vector storage
 * Stores conversation history and retrieves relevant context
 */

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    sessionId: string;
    tenantId: string;
  };
}

interface SearchResult {
  id: string;
  score: number;
  payload: QdrantPoint['payload'];
}

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = 'sage_memories';
const VECTOR_SIZE = 1536; // OpenAI embedding size, we'll use Claude for now

export class Memory {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if collection exists
      const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);

      if (response.status === 404) {
        // Create collection
        await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vectors: {
              size: VECTOR_SIZE,
              distance: 'Cosine'
            }
          })
        });
        console.log(`[Memory] Created collection: ${COLLECTION_NAME}`);
      }

      this.initialized = true;
      console.log('[Memory] Initialized');
    } catch (error) {
      console.error('[Memory] Failed to initialize:', error);
    }
  }

  /**
   * Simple text embedding using character-level hashing
   * In production, use a proper embedding model
   */
  private async embed(text: string): Promise<number[]> {
    // Simple hash-based embedding for demo
    // In production: use OpenAI/Cohere/local embedding model
    const vector = new Array(VECTOR_SIZE).fill(0);
    const words = text.toLowerCase().split(/\s+/);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      for (let j = 0; j < word.length; j++) {
        const idx = (word.charCodeAt(j) * (i + 1) * (j + 1)) % VECTOR_SIZE;
        vector[idx] += 1 / (i + 1);
      }
    }

    // Normalize
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map(v => v / magnitude);
  }

  async store(tenantId: string, sessionId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    await this.init();

    try {
      const vector = await this.embed(content);
      const point: QdrantPoint = {
        id: crypto.randomUUID(),
        vector,
        payload: {
          role,
          content,
          timestamp: new Date().toISOString(),
          sessionId,
          tenantId
        }
      };

      await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: [point] })
      });
    } catch (error) {
      console.error('[Memory] Failed to store:', error);
    }
  }

  async recall(tenantId: string, query: string, limit = 5): Promise<SearchResult[]> {
    await this.init();

    try {
      const vector = await this.embed(query);

      const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vector,
          limit,
          with_payload: true,
          filter: {
            must: [{ key: 'tenantId', match: { value: tenantId } }]
          }
        })
      });

      const data = await response.json();
      return data.result || [];
    } catch (error) {
      console.error('[Memory] Failed to recall:', error);
      return [];
    }
  }

  async getRecentContext(tenantId: string, sessionId: string, limit = 10): Promise<string> {
    await this.init();

    try {
      const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter: {
            must: [
              { key: 'tenantId', match: { value: tenantId } },
              { key: 'sessionId', match: { value: sessionId } }
            ]
          },
          limit,
          with_payload: true,
          order_by: [{ key: 'timestamp', direction: 'desc' }]
        })
      });

      const data = await response.json();
      const points = data.result?.points || [];

      return points
        .reverse()
        .map((p: { payload: QdrantPoint['payload'] }) =>
          `${p.payload.role}: ${p.payload.content}`
        )
        .join('\n');
    } catch (error) {
      console.error('[Memory] Failed to get recent context:', error);
      return '';
    }
  }
}

export const memory = new Memory();
