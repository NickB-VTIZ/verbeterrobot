# Node 22: vereist door better-sqlite3 (SQLite met FTS5)
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# Visuele controle: LibreOffice (docx -> pdf), poppler (pdf -> png) en lettertypen.
# Dit maakt het image een stuk groter (enkele honderden MB). Uitzetten kan
# met VISUAL_CHECK=off, dan wordt de controle gewoon overgeslagen.
RUN apk add --no-cache libreoffice poppler-utils font-liberation ttf-dejavu fontconfig \
 && fc-cache -f
# Alleen productie-deps
COPY package*.json ./
RUN npm ci --omit=dev
# Gebouwde frontend
COPY --from=builder /app/dist ./dist
# Server-code
COPY server ./server
RUN mkdir -p uploads data
# Back-upscript (ook los uit te voeren: docker compose run --rm backup)
COPY scripts/backup.mjs scripts/restore.mjs ./scripts/

ENV NODE_ENV=production
EXPOSE 3010
CMD ["node", "server/index.js"]
