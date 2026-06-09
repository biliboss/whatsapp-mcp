# Patch 05: pinned base image digest — prevents floating-tag supply chain drift
FROM node:22.12-alpine@sha256:513c40ed37f6a5b7200de0a9a18e963d8c049c0427bbc9e4fc5cd16ef8881114 AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22.12-alpine@sha256:513c40ed37f6a5b7200de0a9a18e963d8c049c0427bbc9e4fc5cd16ef8881114 AS runtime

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Patch 02: non-root — create data dirs owned by node (UID 1001)
RUN mkdir -p /app/data/sessions /app/data/media && \
    chown -R node:node /app/data

USER node

EXPOSE 3000 3001

CMD ["node", "dist/index.js"]
