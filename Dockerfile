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

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/uploads /app/backups && chmod -R 777 /app/uploads /app/backups

EXPOSE 5000

CMD ["sh", "-c", "mkdir -p /app/uploads /app/backups && chmod -R 777 /app/uploads /app/backups 2>/dev/null || true; npx prisma migrate resolve --applied 20260919000000_add_dashboard_ip_access_control 2>/dev/null || true; npx prisma migrate resolve --applied 20260920000000_security_and_hardening 2>/dev/null || true; npx prisma migrate deploy || true; node dist/server.js"]
