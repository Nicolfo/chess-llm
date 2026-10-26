# syntax=docker/dockerfile:1

# Dependencies (production only, cached while package*.json don't change)
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
