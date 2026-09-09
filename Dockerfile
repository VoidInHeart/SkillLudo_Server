FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
ARG GIT_SHA=local
ENV NODE_ENV=production PORT=3000 GIT_SHA=${GIT_SHA} SKILLLUDO_ALLOW_DEBUG_DICE=false
LABEL org.opencontainers.image.source="https://github.com/VoidInHeart/SkillLudo_Server" org.opencontainers.image.revision=${GIT_SHA}
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node scripts/smoke.mjs scripts/load-test.mjs ./scripts/
USER node
EXPOSE 3000
CMD ["node", "--max-old-space-size=512", "dist/index.js"]
