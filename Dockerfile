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
RUN npm ci --only=production
RUN npx prisma generate

COPY --from=builder --chown=node:node /app/dist ./dist

RUN mkdir -p /app/uploads /app/backups && chown -R node:node /app/uploads /app/backups

USER node

EXPOSE 5000

CMD ["sh", "-c", "npx prisma migrate resolve --applied 20260919000000_add_dashboard_ip_access_control 2>/dev/null || true; npx prisma migrate resolve --applied 20260920000000_security_and_hardening 2>/dev/null || true; npx prisma migrate deploy || true; node dist/server.js"]
