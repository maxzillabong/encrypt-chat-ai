'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { encrypt, decrypt } from '@/lib/crypto';
import { Send, Lock, Loader2, Sparkles } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'http://localhost:3100';
const SHARED_SECRET = process.env.NEXT_PUBLIC_SHARED_SECRET || 'dev-secret';

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
        content: body.content?.[0]?.text || 'No response',
        timestamp: new Date()
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
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {message.content}
                  </p>
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
