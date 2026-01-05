'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { encrypt, decrypt } from '@/lib/crypto';
import {
  getOrCreateKeyPair,
  getPublicKeyBase64,
  importServerPublicKey,
  deriveSharedSecret,
  encryptWithKey,
  decryptWithKey,
} from '@/lib/keys';
import {
  Send, Lock, Loader2, Sparkles, Copy, Check, Paperclip, X, FileText,
  Image as ImageIcon, FileSpreadsheet, Plus, Search, Trash2, MessageSquare,
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Globe, ExternalLink,
  GitBranch, CornerDownRight
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';

interface AttachedFile {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
  preview?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isTyping?: boolean;
  files?: AttachedFile[];
  sources?: WebSource[];
}

interface Conversation {
  id: string;
  tenant_id: string;
  title: string;
  parent_id: string | null;
  forked_from_message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface WebSource {
  url: string;
  title: string;
  query?: string;
}

interface SearchResult {
  id: string;
  content: string;
  conversation_id: string;
  conversation_title: string;
  created_at: string;
}

// Typewriter effect
function TypewriterText({ content, onComplete }: { content: string; onComplete: () => void }) {
  const [displayedContent, setDisplayedContent] = useState('');
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (isComplete) return;

    let currentIndex = 0;
    const words = content.split(/(\s+)/);
    let currentText = '';

    const interval = setInterval(() => {
      if (currentIndex < words.length) {
        currentText += words[currentIndex];
        setDisplayedContent(currentText);
        currentIndex++;
      } else {
        clearInterval(interval);
        setIsComplete(true);
        onComplete();
      }
    }, 15 + Math.random() * 25);

    return () => clearInterval(interval);
  }, [content, isComplete, onComplete]);

  return <MarkdownContent content={displayedContent} />;
}

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'http://localhost:3100';
const SHARED_SECRET = process.env.NEXT_PUBLIC_ENCRYPT_SECRET || 'dev-secret';

// Cover traffic generator
function generateCoverTraffic() {
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    headers: {
      'X-Request-Id': requestId,
      'X-Correlation-Id': `corr-${requestId.slice(0, 8)}`,
      'X-Api-Version': '2024-01-15',
      'X-Client-Version': '1.4.2',
      'X-Timestamp': timestamp,
    },
    envelope: {
      version: '1.0',
      type: 'application/vnd.sage.encrypted+json',
      timestamp,
      requestId,
      signature: nonce,
      metadata: {
        client: 'sage-web',
        platform: 'browser',
        locale: navigator.language || 'en-US',
      }
    }
  };
}

// Code block with copy
function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-3 rounded-lg overflow-hidden" style={{ background: '#1a1a1a' }}>
      <div className="absolute right-2 top-2 z-10">
        <button
          onClick={handleCopy}
          className="p-1.5 rounded bg-zinc-600 hover:bg-zinc-500 text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      {language && (
        <div className="absolute left-3 top-2 text-xs text-zinc-400 font-mono">
          {language}
        </div>
      )}
      <SyntaxHighlighter
        style={oneDark}
        language={language || 'text'}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: '0.5rem',
          paddingTop: language ? '2rem' : '1rem',
          paddingLeft: '1rem',
          paddingRight: '1rem',
          paddingBottom: '1rem',
          background: '#1a1a1a',
          overflow: 'auto',
        }}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
}

// Markdown renderer
function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const isInline = !match && !String(children).includes('\n');

          if (isInline) {
            return (
              <code className="px-1.5 py-0.5 rounded bg-zinc-700 text-violet-300 text-sm font-mono" {...props}>
                {children}
              </code>
            );
          }

          return (
            <CodeBlock language={match?.[1] || ''}>
              {String(children).replace(/\n$/, '')}
            </CodeBlock>
          );
        },
        p({ children }) {
          return <p className="mb-3 last:mb-0">{children}</p>;
        },
        ul({ children }) {
          return <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>;
        },
        li({ children }) {
          return <li className="text-zinc-200">{children}</li>;
        },
        h1({ children }) {
          return <h1 className="text-xl font-bold mb-3 text-zinc-100">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="text-lg font-semibold mb-2 text-zinc-100">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="text-base font-semibold mb-2 text-zinc-100">{children}</h3>;
        },
        blockquote({ children }) {
          return (
            <blockquote className="border-l-4 border-violet-500 pl-4 my-3 text-zinc-400 italic">
              {children}
            </blockquote>
          );
        },
        a({ href, children }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300 underline">
              {children}
            </a>
          );
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full border border-zinc-700 rounded">{children}</table>
            </div>
          );
        },
        th({ children }) {
          return <th className="px-3 py-2 bg-zinc-800 border border-zinc-700 text-left font-semibold">{children}</th>;
        },
        td({ children }) {
          return <td className="px-3 py-2 border border-zinc-700">{children}</td>;
        },
        hr() {
          return <hr className="my-4 border-zinc-700" />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// Sources panel
function SourcesPanel({ sources }: { sources: WebSource[] }) {
  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-zinc-700">
      <div className="flex items-center gap-2 mb-2">
        <Globe className="w-3 h-3 text-zinc-400" />
        <span className="text-xs font-medium text-zinc-400">Sources</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {sources.map((source, idx) => (
          <a
            key={idx}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-2 py-1 bg-zinc-700/50 hover:bg-zinc-700 rounded text-xs text-zinc-300 hover:text-white transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            <span className="truncate max-w-[150px]">{source.title || new URL(source.url).hostname}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

export function Chat() {
  // State
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sharedKey, setSharedKey] = useState<CryptoKey | null>(null);
  const [useECDH, setUseECDH] = useState(false);

  // Conversation state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);

  // Web search state
  const [webSearchQuery, setWebSearchQuery] = useState<string | null>(null);
  const [isWebSearching, setIsWebSearching] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const SUPPORTED_TYPES = {
    'image/png': 'image',
    'image/jpeg': 'image',
    'image/gif': 'image',
    'image/webp': 'image',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
    'application/msword': 'word',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
    'application/vnd.ms-excel': 'excel',
    'text/plain': 'text',
    'text/csv': 'text',
  } as const;

  // API helper
  const callAPI = useCallback(async (endpoint: string, data: object) => {
    if (!sessionId || !sharedKey) throw new Error('Not connected');

    const cover = generateCoverTraffic();
    const encryptedData = await encryptWithKey(JSON.stringify(data), sharedKey);

    const response = await fetch(`${PROXY_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cover.headers },
      body: JSON.stringify({ ...cover.envelope, sessionId, payload: encryptedData })
    });

    const json = await response.json();
    if (json.error) throw new Error(json.error);

    const decrypted = await decryptWithKey(json.payload, sharedKey);
    return JSON.parse(decrypted);
  }, [sessionId, sharedKey]);

  // Load conversations
  const loadConversations = useCallback(async () => {
    if (!sessionId || !sharedKey) return;
    try {
      const convos = await callAPI('/api/conversations/list', { sessionId });
      setConversations(convos);
    } catch (error) {
      console.error('[Sage] Failed to load conversations:', error);
    }
  }, [sessionId, sharedKey, callAPI]);

  // Load messages for a conversation
  const loadMessages = useCallback(async (conversationId: string) => {
    if (!sessionId || !sharedKey) return;
    try {
      const msgs = await callAPI('/api/conversations/messages', { sessionId, conversationId });
      setMessages(msgs.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: new Date(m.created_at),
      })));
      setCurrentConversationId(conversationId);
    } catch (error) {
      console.error('[Sage] Failed to load messages:', error);
    }
  }, [sessionId, sharedKey, callAPI]);

  // Create new conversation
  const createNewConversation = useCallback(async () => {
    setMessages([]);
    setCurrentConversationId(null);
  }, []);

  // Open delete dialog
  const confirmDelete = useCallback((convo: Conversation) => {
    setConversationToDelete(convo);
    setDeleteDialogOpen(true);
  }, []);

  // Delete conversation
  const deleteConversation = useCallback(async () => {
    if (!sessionId || !sharedKey || !conversationToDelete) return;
    const conversationId = conversationToDelete.id;
    setDeletingId(conversationId);
    try {
      await callAPI('/api/conversations/delete', { conversationId });
      setConversations(prev => prev.filter(c => c.id !== conversationId));
      if (currentConversationId === conversationId) {
        setMessages([]);
        setCurrentConversationId(null);
      }
    } catch (error) {
      console.error('[Sage] Failed to delete conversation:', error);
    } finally {
      setDeletingId(null);
      setDeleteDialogOpen(false);
      setConversationToDelete(null);
    }
  }, [sessionId, sharedKey, callAPI, currentConversationId, conversationToDelete]);

  // Fork conversation from a message
  const forkConversation = useCallback(async (messageId: string) => {
    if (!sessionId || !sharedKey || !currentConversationId) return;
    setForkingMessageId(messageId);
    try {
      const forkedConvo = await callAPI('/api/conversations/fork', {
        conversationId: currentConversationId,
        messageId,
      });
      // Load the forked conversation
      await loadMessages(forkedConvo.id);
      await loadConversations(); // Refresh list
    } catch (error) {
      console.error('[Sage] Failed to fork conversation:', error);
    } finally {
      setForkingMessageId(null);
    }
  }, [sessionId, sharedKey, callAPI, currentConversationId, loadMessages, loadConversations]);

  // Search conversations
  const searchConversations = useCallback(async (query: string) => {
    if (!query.trim() || !sessionId || !sharedKey) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const results = await callAPI('/api/conversations/search', { sessionId, query });
      setSearchResults(results);
    } catch (error) {
      console.error('[Sage] Search failed:', error);
    } finally {
      setIsSearching(false);
    }
  }, [sessionId, sharedKey, callAPI]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      searchConversations(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchConversations]);

  // Initialize ECDH
  useEffect(() => {
    async function initKeyExchange() {
      try {
        const healthRes = await fetch(`${PROXY_URL}/health`);
        if (!healthRes.ok) {
          setIsConnected(false);
          return;
        }

        const keyPair = await getOrCreateKeyPair();
        const clientPublicKey = await getPublicKeyBase64(keyPair);

        const exchangeRes = await fetch(`${PROXY_URL}/key-exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientPublicKey }),
        });

        if (!exchangeRes.ok) {
          setIsConnected(true);
          setUseECDH(false);
          return;
        }

        const { serverPublicKey, sessionId: sid } = await exchangeRes.json();
        const serverKey = await importServerPublicKey(serverPublicKey);
        const derivedKey = await deriveSharedSecret(keyPair.privateKey, serverKey);

        setSessionId(sid);
        setSharedKey(derivedKey);
        setUseECDH(true);
        setIsConnected(true);
      } catch (error) {
        console.error('[Sage] Key exchange error:', error);
        setIsConnected(true);
        setUseECDH(false);
      }
    }

    initKeyExchange();
  }, []);

  // Load conversations after connection
  useEffect(() => {
    if (isConnected && useECDH && sessionId && sharedKey) {
      loadConversations();
    }
  }, [isConnected, useECDH, sessionId, sharedKey, loadConversations]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const markTypingComplete = useCallback((messageId: string) => {
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, isTyping: false } : m));
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (!(file.type in SUPPORTED_TYPES)) {
        alert(`Unsupported file type: ${file.type}`);
        continue;
      }

      if (file.size > 20 * 1024 * 1024) {
        alert(`File too large: ${file.name} (max 20MB)`);
        continue;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const newFile: AttachedFile = {
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          size: file.size,
          data: base64,
          preview: file.type.startsWith('image/') ? reader.result as string : undefined,
        };
        setAttachedFiles(prev => [...prev, newFile]);
      };
      reader.readAsDataURL(file);
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (id: string) => {
    setAttachedFiles(prev => prev.filter(f => f.id !== id));
  };

  const getFileIcon = (type: string) => {
    if (type.startsWith('image/')) return <ImageIcon className="w-4 h-4" />;
    if (type.includes('pdf')) return <FileText className="w-4 h-4 text-red-400" />;
    if (type.includes('word')) return <FileText className="w-4 h-4 text-blue-400" />;
    if (type.includes('excel') || type.includes('spreadsheet')) return <FileSpreadsheet className="w-4 h-4 text-green-400" />;
    return <FileText className="w-4 h-4" />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Parse web sources from response
  const parseWebSources = (content: string): WebSource[] => {
    const sources: WebSource[] = [];
    const urlRegex = /https?:\/\/[^\s\)]+/g;
    const matches = content.match(urlRegex) || [];

    matches.forEach(url => {
      try {
        const parsed = new URL(url);
        if (!sources.find(s => s.url === url)) {
          sources.push({ url, title: parsed.hostname });
        }
      } catch {}
    });

    return sources.slice(0, 5); // Max 5 sources
  };

  const sendMessage = async () => {
    if ((!input.trim() && attachedFiles.length === 0) || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
      files: attachedFiles.length > 0 ? [...attachedFiles] : undefined,
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setAttachedFiles([]);
    setIsLoading(true);

    // Check if this might trigger a web search
    const searchKeywords = ['search', 'find', 'look up', 'what is', 'who is', 'latest', 'current', 'news', 'today'];
    const mightSearch = searchKeywords.some(kw => input.toLowerCase().includes(kw));
    if (mightSearch) {
      setWebSearchQuery(input.slice(0, 50));
      setIsWebSearching(true);
    }

    try {
      const apiRequest = {
        endpoint: '/v1/messages',
        method: 'POST',
        body: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          messages: [...messages, userMessage].map(m => ({ role: m.role, content: m.content }))
        },
        files: userMessage.files?.map(f => ({ name: f.name, type: f.type, data: f.data })),
        conversationId: currentConversationId,
      };

      let decryptedResponse;
      const cover = generateCoverTraffic();

      if (useECDH && sharedKey && sessionId) {
        const encryptedData = await encryptWithKey(JSON.stringify(apiRequest), sharedKey);

        const response = await fetch(`${PROXY_URL}/proxy/secure`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cover.headers },
          body: JSON.stringify({ ...cover.envelope, payload: encryptedData, sessionId })
        });

        const responseJson = await response.json();
        const encryptedPayload = responseJson.signature || responseJson.payload || responseJson.data;
        decryptedResponse = JSON.parse(await decryptWithKey(encryptedPayload, sharedKey));

        // Update conversation ID if new
        if (decryptedResponse.conversationId && !currentConversationId) {
          setCurrentConversationId(decryptedResponse.conversationId);
          loadConversations(); // Refresh list
        }
      } else {
        const encryptedData = await encrypt(JSON.stringify(apiRequest), SHARED_SECRET);

        const response = await fetch(`${PROXY_URL}/proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cover.headers },
          body: JSON.stringify({ ...cover.envelope, payload: encryptedData })
        });

        const responseJson = await response.json();
        decryptedResponse = JSON.parse(await decrypt(responseJson.payload || responseJson.data, SHARED_SECRET));
      }

      setIsWebSearching(false);
      const body = JSON.parse(decryptedResponse.body);
      const content = body.content?.[0]?.text || body.error?.message || 'No response';
      const sources = parseWebSources(content);

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content,
        timestamp: new Date(),
        isTyping: true,
        sources: sources.length > 0 ? sources : undefined,
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error:', error);
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Error: Could not connect to the encrypted proxy.',
        timestamp: new Date()
      }]);
    } finally {
      setIsLoading(false);
      setWebSearchQuery(null);
      setIsWebSearching(false);
    }
  };

  const formatDate = (date: string) => {
    const d = new Date(date);
    const now = new Date();
    const diff = now.getTime() - d.getTime();

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return d.toLocaleDateString();
  };

  return (
    <div className="flex h-screen bg-black overflow-hidden">
      {/* Sidebar */}
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 300, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="flex flex-col border-r border-zinc-800 bg-zinc-950 overflow-hidden"
          >
            {/* Sidebar header */}
            <div className="p-4 border-b border-zinc-800">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={createNewConversation}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-lg text-white font-medium transition-colors"
              >
                <Plus className="w-4 h-4" />
                New Conversation
              </motion.button>
            </div>

            {/* Search */}
            <div className="p-3 border-b border-zinc-800">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search conversations..."
                  className="pl-9 bg-zinc-900 border-zinc-700 focus:border-violet-500 text-sm"
                />
              </div>
            </div>

            {/* Search results or conversation list */}
            <ScrollArea className="flex-1">
              <div className="p-2">
                <AnimatePresence mode="popLayout">
                  {searchQuery && searchResults.length > 0 ? (
                    // Search results
                    <div className="space-y-1">
                      <p className="text-xs text-zinc-500 px-2 py-1">Search Results</p>
                      {searchResults.map((result, idx) => (
                        <motion.button
                          key={result.id}
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                          transition={{ delay: idx * 0.03 }}
                          onClick={() => {
                            loadMessages(result.conversation_id);
                            setSearchQuery('');
                          }}
                          className="w-full text-left p-3 rounded-lg hover:bg-zinc-800/50 transition-colors"
                        >
                          <p className="text-sm font-medium text-zinc-200 truncate">{result.conversation_title}</p>
                          <p className="text-xs text-zinc-500 truncate mt-1">{result.content}</p>
                        </motion.button>
                      ))}
                    </div>
                  ) : (
                    // Conversation list
                    <div className="space-y-1">
                      {conversations.map((convo, idx) => (
                        <motion.div
                          key={convo.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          transition={{ delay: idx * 0.02 }}
                          className={`group relative rounded-lg transition-colors ${
                            currentConversationId === convo.id
                              ? 'bg-violet-600/20 border border-violet-500/30'
                              : 'hover:bg-zinc-800/50'
                          } ${convo.parent_id ? 'ml-3' : ''}`}
                        >
                          <button
                            onClick={() => loadMessages(convo.id)}
                            className="w-full text-left p-3 pr-10"
                          >
                            <div className="flex items-start gap-2">
                              {convo.parent_id ? (
                                <CornerDownRight className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                              ) : (
                                <MessageSquare className="w-4 h-4 text-zinc-500 mt-0.5 flex-shrink-0" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <p className="text-sm font-medium text-zinc-200 truncate">
                                    {convo.title}
                                  </p>
                                  {convo.parent_id && (
                                    <GitBranch className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                                  )}
                                </div>
                                <p className="text-xs text-zinc-500 mt-0.5">
                                  {formatDate(convo.updated_at)}
                                </p>
                              </div>
                            </div>
                          </button>

                          {/* Delete button - always visible */}
                          <motion.button
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              confirmDelete(convo);
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md hover:bg-red-500/20 text-zinc-500 hover:text-red-400 transition-all"
                          >
                            {deletingId === convo.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </motion.button>
                        </motion.div>
                      ))}

                      {conversations.length === 0 && !searchQuery && (
                        <div className="text-center py-8 text-zinc-500">
                          <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
                          <p className="text-sm">No conversations yet</p>
                        </div>
                      )}
                    </div>
                  )}
                </AnimatePresence>
              </div>
            </ScrollArea>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Collapsible Header */}
        <motion.header
          initial={{ opacity: 0, y: -20 }}
          animate={{
            opacity: 1,
            y: 0,
            height: headerCollapsed ? 'auto' : 'auto'
          }}
          className="flex-shrink-0 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-xl"
        >
          <AnimatePresence mode="wait">
            {headerCollapsed ? (
              <motion.div
                key="collapsed"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="px-4 py-1.5 flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSidebarOpen(!sidebarOpen)}
                    className="text-zinc-400 hover:text-white h-7 w-7"
                  >
                    {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </Button>
                  <Sparkles className="w-4 h-4 text-violet-400" />
                  <span className="text-sm font-medium text-zinc-400">Sage</span>
                  <Lock className={`w-3 h-3 ${isConnected ? 'text-emerald-400' : 'text-zinc-600'}`} />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setHeaderCollapsed(false)}
                  className="text-zinc-500 hover:text-white h-7 w-7"
                >
                  <ChevronDown className="w-4 h-4" />
                </Button>
              </motion.div>
            ) : (
              <motion.div
                key="expanded"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="px-4 py-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSidebarOpen(!sidebarOpen)}
                    className="text-zinc-400 hover:text-white"
                  >
                    {sidebarOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                  </Button>
                  <motion.div
                    animate={{ rotate: [0, 10, -10, 0] }}
                    transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
                  >
                    <Sparkles className="w-6 h-6 text-violet-400" />
                  </motion.div>
                  <h1 className="text-xl font-semibold bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">
                    Sage
                  </h1>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <motion.div
                      animate={{ scale: isConnected ? [1, 1.2, 1] : 1 }}
                      transition={{ duration: 1, repeat: isConnected ? Infinity : 0, repeatDelay: 2 }}
                    >
                      <Lock className={`w-4 h-4 ${isConnected ? 'text-emerald-400' : 'text-zinc-600'}`} />
                    </motion.div>
                    <span className="text-xs text-zinc-500">
                      {isConnected ? (useECDH ? 'ECDH Encrypted' : 'AES Encrypted') : 'Disconnected'}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setHeaderCollapsed(true)}
                    className="text-zinc-500 hover:text-white"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.header>

        {/* Messages */}
        <ScrollArea className="flex-1 min-h-0 p-4 bg-black" ref={scrollRef}>
          <div className="max-w-4xl mx-auto space-y-4">
            <AnimatePresence mode="popLayout">
              {messages.length === 0 && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="flex flex-col items-center justify-center h-[60vh] text-center"
                >
                  <motion.div
                    animate={{ y: [0, -10, 0], rotate: [0, 5, -5, 0] }}
                    transition={{ duration: 4, repeat: Infinity }}
                    className="text-6xl mb-6"
                  >
                    🦉
                  </motion.div>
                  <h2 className="text-2xl font-medium text-zinc-300 mb-2">Welcome to Sage</h2>
                  <p className="text-zinc-500 max-w-md">
                    Your encrypted AI companion with memory and web search.
                    All messages are E2E encrypted. I remember our conversations.
                  </p>
                </motion.div>
              )}

              {messages.map((message, index) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -20, scale: 0.95 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30, delay: index * 0.02 }}
                  className={`group/message flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {message.role === 'assistant' && (
                    <Avatar className="w-8 h-8 border border-violet-500/30">
                      <AvatarFallback className="bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white text-sm">
                        S
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <Card className={`relative max-w-[80%] p-4 pb-6 overflow-hidden ${
                      message.role === 'user'
                        ? 'bg-violet-600 text-white border-violet-500'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-100'
                    }`}>
                    {message.role === 'assistant' ? (
                      <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none">
                        {message.isTyping ? (
                          <TypewriterText content={message.content} onComplete={() => markTypingComplete(message.id)} />
                        ) : (
                          <MarkdownContent content={message.content} />
                        )}
                        {message.sources && <SourcesPanel sources={message.sources} />}
                      </div>
                    ) : (
                      <div>
                        {message.files && message.files.length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-2">
                            {message.files.map(file => (
                              <div key={file.id} className="flex items-center gap-1 bg-violet-700/50 rounded px-2 py-1">
                                {file.preview ? (
                                  <img src={file.preview} alt={file.name} className="w-8 h-8 object-cover rounded" />
                                ) : (
                                  getFileIcon(file.type)
                                )}
                                <span className="text-xs truncate max-w-[100px]">{file.name}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {message.content && (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
                        )}
                      </div>
                    )}
                    {/* Fork button - inside card, bottom right */}
                    {currentConversationId && (
                      <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => forkConversation(message.id)}
                        disabled={forkingMessageId === message.id}
                        className={`absolute bottom-1.5 right-1.5 p-1 rounded hover:bg-emerald-600 transition-all ${
                          message.role === 'user'
                            ? 'text-violet-300 hover:text-white'
                            : 'text-zinc-500 hover:text-white'
                        }`}
                        title="Branch from here"
                      >
                        {forkingMessageId === message.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <GitBranch className="w-3.5 h-3.5" />
                        )}
                      </motion.button>
                    )}
                  </Card>
                  {message.role === 'user' && (
                    <Avatar className="w-8 h-8 border border-zinc-700">
                      <AvatarFallback className="bg-zinc-800 text-zinc-300 text-sm">U</AvatarFallback>
                    </Avatar>
                  )}
                </motion.div>
              ))}

              {isLoading && (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3 justify-start">
                  <Avatar className="w-8 h-8 border border-violet-500/30">
                    <AvatarFallback className="bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white text-sm">S</AvatarFallback>
                  </Avatar>
                  <Card className="bg-zinc-800/50 border-zinc-700 p-4">
                    <motion.div className="flex flex-col gap-2" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                      {/* Web search indicator */}
                      <AnimatePresence>
                        {webSearchQuery && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="flex items-center gap-2 text-sm"
                          >
                            <motion.div
                              animate={isWebSearching ? { rotate: 360 } : {}}
                              transition={{ duration: 1, repeat: isWebSearching ? Infinity : 0, ease: 'linear' }}
                            >
                              <Globe className="w-4 h-4 text-blue-400" />
                            </motion.div>
                            <span className="text-blue-300">
                              {isWebSearching ? 'Searching the web...' : 'Processing results...'}
                            </span>
                          </motion.div>
                        )}
                      </AnimatePresence>
                      {/* Typing dots */}
                      <div className="flex gap-1">
                        {[0, 1, 2].map((i) => (
                          <motion.div
                            key={i}
                            className="w-2 h-2 bg-violet-400 rounded-full"
                            animate={{ y: [0, -8, 0] }}
                            transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
                          />
                        ))}
                      </div>
                    </motion.div>
                  </Card>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </ScrollArea>

        {/* Input */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex-shrink-0 border-t border-zinc-800 bg-zinc-950/80 backdrop-blur-xl p-4"
        >
          <div className="max-w-4xl mx-auto">
            {attachedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {attachedFiles.map(file => (
                  <div key={file.id} className="relative group flex items-center gap-2 bg-zinc-800 rounded-lg px-3 py-2 border border-zinc-700">
                    {file.preview ? (
                      <img src={file.preview} alt={file.name} className="w-10 h-10 object-cover rounded" />
                    ) : (
                      getFileIcon(file.type)
                    )}
                    <div className="flex flex-col">
                      <span className="text-xs text-zinc-300 truncate max-w-[120px]">{file.name}</span>
                      <span className="text-xs text-zinc-500">{formatFileSize(file.size)}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(file.id)}
                      className="absolute -top-1 -right-1 p-0.5 bg-zinc-700 hover:bg-red-600 rounded-full transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={(e) => { e.preventDefault(); sendMessage(); }} className="flex gap-3">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
                onChange={handleFileSelect}
                className="hidden"
              />

              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || !isConnected}
                className="border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
              >
                <Paperclip className="w-4 h-4" />
              </Button>

              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask Sage anything..."
                className="flex-1 bg-zinc-900 border-zinc-700 focus:border-violet-500 focus:ring-violet-500/20 text-zinc-100 placeholder:text-zinc-500"
                disabled={isLoading || !isConnected}
              />
              <Button
                type="submit"
                disabled={isLoading || (!input.trim() && attachedFiles.length === 0) || !isConnected}
                className="bg-violet-600 hover:bg-violet-500 text-white px-6"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </form>
            <p className="text-xs text-zinc-600 mt-2 text-center">
              {useECDH ? 'Signal-style ECDH key exchange • AES-256-GCM encryption' : 'Messages encrypted with AES-256-GCM'}
            </p>
          </div>
        </motion.div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Conversation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{conversationToDelete?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConversationToDelete(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteConversation}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deletingId ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
