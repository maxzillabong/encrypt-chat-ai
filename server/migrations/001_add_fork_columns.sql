-- Migration: Add fork/branch columns to conversations table
-- Run this on the production database to enable conversation branching

-- Add parent_id column for tracking conversation branches
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES conversations(id) ON DELETE SET NULL;

-- Add forked_from_message_id to track which message the fork started from
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS forked_from_message_id UUID;

-- Add foreign key constraint for forked_from_message_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_forked_message'
    ) THEN
        ALTER TABLE conversations
        ADD CONSTRAINT fk_forked_message
        FOREIGN KEY (forked_from_message_id)
        REFERENCES messages(id)
        ON DELETE SET NULL;
    END IF;
END $$;

-- Add index for efficient branch lookups
CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_id) WHERE parent_id IS NOT NULL;
