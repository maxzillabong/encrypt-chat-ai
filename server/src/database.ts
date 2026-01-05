/**
 * PostgreSQL database module for conversation persistence
 */

import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://sage:sage_secret_2024@localhost:5432/sage';

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection on startup
pool.on('connect', () => {
  console.log('[Database] Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('[Database] Pool error:', err.message);
});

export interface Conversation {
  id: string;
  tenant_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: Date;
}

export const db = {
  /**
   * Create a new conversation
   */
  async createConversation(tenantId: string, title?: string): Promise<Conversation> {
    const result = await pool.query(
      `INSERT INTO conversations (tenant_id, title) VALUES ($1, $2) RETURNING *`,
      [tenantId, title || 'New Conversation']
    );
    return result.rows[0];
  },

  /**
   * Get all conversations for a tenant (excluding deleted)
   */
  async getConversations(tenantId: string): Promise<Conversation[]> {
    const result = await pool.query(
      `SELECT * FROM conversations
       WHERE tenant_id = $1 AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
      [tenantId]
    );
    return result.rows;
  },

  /**
   * Get a single conversation
   */
  async getConversation(conversationId: string, tenantId: string): Promise<Conversation | null> {
    const result = await pool.query(
      `SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [conversationId, tenantId]
    );
    return result.rows[0] || null;
  },

  /**
   * Update conversation title
   */
  async updateConversationTitle(conversationId: string, tenantId: string, title: string): Promise<Conversation | null> {
    const result = await pool.query(
      `UPDATE conversations SET title = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [conversationId, tenantId, title]
    );
    return result.rows[0] || null;
  },

  /**
   * Soft delete a conversation
   */
  async deleteConversation(conversationId: string, tenantId: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE conversations SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [conversationId, tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Add a message to a conversation
   */
  async addMessage(conversationId: string, role: 'user' | 'assistant' | 'system', content: string): Promise<Message> {
    const result = await pool.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING *`,
      [conversationId, role, content]
    );
    return result.rows[0];
  },

  /**
   * Get messages for a conversation
   */
  async getMessages(conversationId: string, limit = 100): Promise<Message[]> {
    const result = await pool.query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [conversationId, limit]
    );
    return result.rows;
  },

  /**
   * Search messages across all conversations for a tenant
   */
  async searchMessages(tenantId: string, query: string, limit = 20): Promise<(Message & { conversation_title: string })[]> {
    const result = await pool.query(
      `SELECT m.*, c.title as conversation_title
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE c.tenant_id = $1
       AND c.deleted_at IS NULL
       AND m.content ILIKE $2
       ORDER BY m.created_at DESC
       LIMIT $3`,
      [tenantId, `%${query}%`, limit]
    );
    return result.rows;
  },

  /**
   * Get conversation context (recent messages formatted for prompt)
   */
  async getConversationContext(conversationId: string, limit = 20): Promise<string> {
    const messages = await this.getMessages(conversationId, limit);
    return messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');
  },

  /**
   * Test database connection
   */
  async testConnection(): Promise<boolean> {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (err) {
      console.error('[Database] Connection test failed:', err);
      return false;
    }
  },

  /**
   * Close pool (for graceful shutdown)
   */
  async close(): Promise<void> {
    await pool.end();
  }
};
