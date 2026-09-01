FROM node:20-alpine AS builder

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Install dependencies
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# Copy source files and build
COPY . .
RUN npm run build

FROM node:20-alpine AS runner

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
COPY prisma ./prisma/
COPY telegram_admins.json ./telegram_admins.json
RUN npm ci --only=production
RUN npx prisma generate

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

EXPOSE 5000

CMD ["npm", "run", "start"]
