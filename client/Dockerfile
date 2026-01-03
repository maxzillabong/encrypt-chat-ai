FROM node:20-alpine AS builder

WORKDIR /app

# Build arguments for Next.js public env vars
ARG NEXT_PUBLIC_PROXY_URL
ARG NEXT_PUBLIC_ENCRYPT_SECRET

ENV NEXT_PUBLIC_PROXY_URL=$NEXT_PUBLIC_PROXY_URL
ENV NEXT_PUBLIC_ENCRYPT_SECRET=$NEXT_PUBLIC_ENCRYPT_SECRET

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
