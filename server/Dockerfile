FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install python and system deps for docling (including OpenGL for image processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    libgl1 libglib2.0-0 libsm6 libxrender1 libxext6 && \
    pip3 install --break-system-packages docling --extra-index-url https://download.pytorch.org/whl/cpu && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts
RUN npm install --omit=dev

EXPOSE 3100
CMD ["node", "dist/index.js"]
