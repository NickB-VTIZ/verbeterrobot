FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
# Alleen productie-deps
COPY package*.json ./
RUN npm ci --omit=dev
# Gebouwde frontend
COPY --from=builder /app/dist ./dist
# Server-code
COPY server ./server
RUN mkdir -p uploads data

ENV NODE_ENV=production
EXPOSE 3010
CMD ["node", "server/index.js"]
