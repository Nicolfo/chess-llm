# syntax=docker/dockerfile:1

# Dependencies (production only, cached while package*.json don't change)
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# keep only the Stockfish build the app serves (about 2 MB of the 200 MB package)
RUN npm ci --omit=dev && npm cache clean --force \
    && find node_modules/stockfish/bin -type f ! -name "*-lite-single.*" -delete

# Runtime
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config.example.json ./
# saved games; mount a volume here to keep them across container restarts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "--env-file-if-exists=.env", "src/server.js"]
