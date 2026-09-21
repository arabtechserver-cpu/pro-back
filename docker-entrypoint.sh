#!/bin/sh
set -eu

mkdir -p /app/uploads /app/backups
# Never mark migrations as applied without executing them, and never serve
# requests after a failed migration. exec preserves shutdown signals.
node node_modules/prisma/build/index.js migrate deploy
exec node dist/server.js
