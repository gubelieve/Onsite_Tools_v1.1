# Modelled on Lab_management's Dockerfile: node:22-alpine, standalone output,
# a fake DATABASE_URL for the build (the build never connects, and a real one
# passed as a build arg would be recorded in `docker history`), non-root run.

# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app
ARG DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
RUN apk add --no-cache tzdata

COPY package.json package-lock.json .npmrc prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN mkdir -p public
RUN npm run build

# ---- run stage ----
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

ENV NODE_ENV=production
ENV PORT=3000
# Docker sets HOSTNAME to the container id; standalone server.js would bind to it.
ENV HOSTNAME=0.0.0.0
ENV TZ=Asia/Bangkok

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
