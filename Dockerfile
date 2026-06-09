FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runtime

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
