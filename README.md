# Sage - E2E Encrypted Claude Chat

A privacy-focused Claude chat client with end-to-end encryption for DPI evasion. Your conversations are encrypted locally before being sent through a proxy server, ensuring your chat traffic looks like random data.

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│                 │      │                  │      │                 │
│  Local Client   │─────▶│  Hetzner Proxy   │─────▶│  Claude API     │
│  (Next.js)      │ E2E  │  (Hono)          │ TLS  │  (Anthropic)    │
│                 │      │                  │      │                 │
└─────────────────┘      └──────────────────┘      └─────────────────┘
                               │
                               ▼
                         ┌──────────────────┐
                         │                  │
                         │  Qdrant          │
                         │  (Vector DB)     │
                         │                  │
                         └──────────────────┘
```

## Features

- **End-to-End Encryption**: AES-256-GCM encryption with PBKDF2 key derivation
- **DPI Evasion**: Encrypted traffic appears as random data
- **Memory**: Vector database (Qdrant) stores conversation history for context
- **Slick UI**: Animated interface with Framer Motion and shadcn/ui
- **Self-hosted**: Deploy your own proxy on any VPS

## Quick Start

### Using Docker Compose

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/encrypt-chat-ai.git
   cd encrypt-chat-ai
   ```

2. Create environment files:
   ```bash
   cp server/.env.example server/.env
   cp client/.env.example client/.env
   ```

3. Configure your secrets:
   ```bash
   # Generate a strong shared secret
   openssl rand -base64 32

   # Edit server/.env and client/.env with matching secrets
   # Add your ANTHROPIC_API_KEY to server/.env
   ```

4. Start the stack:
   ```bash
   docker-compose up -d
   ```

5. Open http://localhost:3000

### Manual Development

**Server:**
```bash
cd server
npm install
npm run dev
```

**Client:**
```bash
cd client
npm install
npm run dev
```

## Configuration

### Client Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_PROXY_URL` | URL of your proxy server | `http://localhost:3100` |
| `NEXT_PUBLIC_ENCRYPT_SECRET` | Shared encryption secret | - |

### Server Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3100` |
| `ENCRYPT_CHAT_SECRET` | Shared encryption secret | - |
| `ANTHROPIC_API_KEY` | Your Anthropic API key | - |
| `CLAUDE_API_URL` | Claude API base URL | `https://api.anthropic.com` |
| `QDRANT_URL` | Qdrant server URL | `http://localhost:6333` |

## Security

### Encryption

- **Algorithm**: AES-256-GCM
- **Key Derivation**: PBKDF2 with 100,000 iterations
- **Salt**: Random 16 bytes per message
- **IV**: Random 12 bytes per message

### Important Notes

- The shared secret should be strong (use `openssl rand -base64 32`)
- Transport is still over HTTPS - encryption adds an extra layer
- The proxy server has access to decrypted messages (trust your server)
- Qdrant stores conversation history - secure your database

## Deployment

### Deploy Proxy to Hetzner/VPS

1. SSH into your server
2. Install Docker and Docker Compose
3. Clone this repository
4. Configure environment variables
5. Run `docker-compose up -d`
6. Set up reverse proxy (Caddy/Nginx) with HTTPS

Example Caddy configuration:
```
sage.yourdomain.com {
    reverse_proxy localhost:3100
}
```

### Deploy Client

The client can be:
- Run locally for maximum privacy
- Deployed to Vercel/Coolify pointing to your proxy

## Tech Stack

**Client:**
- Next.js 16 (React 19)
- shadcn/ui components
- Framer Motion animations
- TanStack AI SDK
- Web Crypto API

**Server:**
- Hono (fast web framework)
- Node.js crypto
- Qdrant vector database

## License

MIT
