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
# saved games; mount a volume here to keep them across container restarts.
# npm/corepack/yarn are not needed at runtime (CMD runs node directly) and their bundled deps carry CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack         /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack         /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*     && mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "--env-file-if-exists=.env", "src/server.js"]
