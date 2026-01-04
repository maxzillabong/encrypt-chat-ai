'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { encrypt, decrypt } from '@/lib/crypto';
import { Send, Lock, Loader2, Sparkles, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isTyping?: boolean;
}

// Typewriter effect for simulated streaming
function TypewriterText({ content, onComplete }: { content: string; onComplete: () => void }) {
  const [displayedContent, setDisplayedContent] = useState('');
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (isComplete) return;

    let currentIndex = 0;
    const words = content.split(/(\s+)/); // Split by whitespace, keeping separators
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
    }, 15 + Math.random() * 25); // Random delay between 15-40ms per word for natural feel

    return () => clearInterval(interval);
  }, [content, isComplete, onComplete]);

  return <MarkdownContent content={displayedContent} />;
}

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'http://localhost:3100';
const SHARED_SECRET = process.env.NEXT_PUBLIC_ENCRYPT_SECRET || 'dev-secret';

// Code block component with copy button
function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-3">
      <div className="absolute right-2 top-2 z-10">
        <button
          onClick={handleCopy}
          className="p-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      {language && (
        <div className="absolute left-3 top-2 text-xs text-zinc-500 font-mono">
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
        }}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
}

// Markdown renderer component
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

// Debug logging
console.log('[Sage] Proxy URL:', PROXY_URL);
console.log('[Sage] Secret configured:', !!process.env.NEXT_PUBLIC_ENCRYPT_SECRET);

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Check proxy connection
    fetch(`${PROXY_URL}/health`)
      .then(res => res.ok && setIsConnected(true))
      .catch(() => setIsConnected(false));
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const markTypingComplete = useCallback((messageId: string) => {
    setMessages(prev =>
      prev.map(m =>
        m.id === messageId ? { ...m, isTyping: false } : m
      )
    );
  }, []);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      // Build the request for Claude API
      const apiRequest = {
        endpoint: '/v1/messages',
        method: 'POST',
        body: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          messages: [...messages, userMessage].map(m => ({
            role: m.role,
            content: m.content
          }))
        }
      };

      // Encrypt the request
      const encryptedData = await encrypt(JSON.stringify(apiRequest), SHARED_SECRET);

      // Send to proxy
      const response = await fetch(`${PROXY_URL}/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: encryptedData })
      });

      const { data } = await response.json();

      // Decrypt response
      const decryptedResponse = JSON.parse(await decrypt(data, SHARED_SECRET));
      const body = JSON.parse(decryptedResponse.body);

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: body.content?.[0]?.text || body.error?.message || 'No response',
        timestamp: new Date(),
        isTyping: true
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
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-zinc-950">
      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-xl"
      >
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
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
          <div className="flex items-center gap-2">
            <motion.div
              animate={{ scale: isConnected ? [1, 1.2, 1] : 1 }}
              transition={{ duration: 1, repeat: isConnected ? Infinity : 0, repeatDelay: 2 }}
            >
              <Lock className={`w-4 h-4 ${isConnected ? 'text-emerald-400' : 'text-zinc-600'}`} />
            </motion.div>
            <span className="text-xs text-zinc-500">
              {isConnected ? 'E2E Encrypted' : 'Disconnected'}
            </span>
          </div>
        </div>
      </motion.header>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
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
                  animate={{
                    y: [0, -10, 0],
                    rotate: [0, 5, -5, 0]
                  }}
                  transition={{ duration: 4, repeat: Infinity }}
                  className="text-6xl mb-6"
                >
                  🦉
                </motion.div>
                <h2 className="text-2xl font-medium text-zinc-300 mb-2">
                  Welcome to Sage
                </h2>
                <p className="text-zinc-500 max-w-md">
                  Your encrypted AI companion with memory. All messages are E2E encrypted
                  through your private proxy. I remember our conversations.
                </p>
              </motion.div>
            )}

            {messages.map((message, index) => (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.95 }}
                transition={{
                  type: 'spring',
                  stiffness: 500,
                  damping: 30,
                  delay: index * 0.05
                }}
                className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {message.role === 'assistant' && (
                  <Avatar className="w-8 h-8 border border-violet-500/30">
                    <AvatarFallback className="bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white text-sm">
                      S
                    </AvatarFallback>
                  </Avatar>
                )}
                <Card className={`max-w-[80%] p-4 ${
                  message.role === 'user'
                    ? 'bg-violet-600 text-white border-violet-500'
                    : 'bg-zinc-800/50 border-zinc-700 text-zinc-100'
                }`}>
                  {message.role === 'assistant' ? (
                    <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none">
                      {message.isTyping ? (
                        <TypewriterText
                          content={message.content}
                          onComplete={() => markTypingComplete(message.id)}
                        />
                      ) : (
                        <MarkdownContent content={message.content} />
                      )}
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {message.content}
                    </p>
                  )}
                </Card>
                {message.role === 'user' && (
                  <Avatar className="w-8 h-8 border border-zinc-700">
                    <AvatarFallback className="bg-zinc-800 text-zinc-300 text-sm">
                      U
                    </AvatarFallback>
                  </Avatar>
                )}
              </motion.div>
            ))}

            {isLoading && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex gap-3 justify-start"
              >
                <Avatar className="w-8 h-8 border border-violet-500/30">
                  <AvatarFallback className="bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white text-sm">
                    S
                  </AvatarFallback>
                </Avatar>
                <Card className="bg-zinc-800/50 border-zinc-700 p-4">
                  <motion.div
                    className="flex gap-1"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    {[0, 1, 2].map((i) => (
                      <motion.div
                        key={i}
                        className="w-2 h-2 bg-violet-400 rounded-full"
                        animate={{ y: [0, -8, 0] }}
                        transition={{
                          duration: 0.6,
                          repeat: Infinity,
                          delay: i * 0.15
                        }}
                      />
                    ))}
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
        className="border-t border-zinc-800 bg-zinc-950/80 backdrop-blur-xl p-4"
      >
        <div className="max-w-4xl mx-auto">
          <form
            onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
            className="flex gap-3"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Sage anything..."
              className="flex-1 bg-zinc-900 border-zinc-700 focus:border-violet-500 focus:ring-violet-500/20 text-zinc-100 placeholder:text-zinc-500"
              disabled={isLoading || !isConnected}
            />
            <Button
              type="submit"
              disabled={isLoading || !input.trim() || !isConnected}
              className="bg-violet-600 hover:bg-violet-500 text-white px-6"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </form>
          <p className="text-xs text-zinc-600 mt-2 text-center">
            Messages encrypted with AES-256-GCM before leaving your device
          </p>
        </div>
      </motion.div>
    </div>
  );
}
