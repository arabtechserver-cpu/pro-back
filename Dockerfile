FROM node:22-alpine AS builder

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runner

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev
RUN npx prisma generate

COPY --from=builder /app/dist ./dist

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p /app/uploads /app/backups && chown -R node:node /app/uploads /app/backups && chmod 750 /app/uploads /app/backups

ENV NODE_ENV=production
USER node

EXPOSE 5000

CMD ["sh", "./docker-entrypoint.sh"]
