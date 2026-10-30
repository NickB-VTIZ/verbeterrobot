# Node 22: vereist door better-sqlite3 (SQLite met FTS5)
FROM node:22-alpine AS builder
WORKDIR /app
# better-sqlite3 is een native module: op Alpine (musl) is er niet altijd een
# prebuilt binary, dan wordt hij met node-gyp gecompileerd. Daarvoor zijn
# python3, make en g++ nodig (alleen in deze build-stage, niet in het eindimage).
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# Dev-dependencies weghalen; de gecompileerde native module blijft behouden
RUN npm prune --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
# Visuele controle: LibreOffice (docx -> pdf), poppler (pdf -> png) en lettertypen.
# Dit maakt het image een stuk groter (enkele honderden MB). Uitzetten kan
# met VISUAL_CHECK=off, dan wordt de controle gewoon overgeslagen.
RUN apk add --no-cache libreoffice poppler-utils font-liberation ttf-dejavu fontconfig \
 && fc-cache -f
COPY package*.json ./
# Productie-node_modules uit de builder (zelfde Alpine/Node => binary-compatibel)
COPY --from=builder /app/node_modules ./node_modules
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
