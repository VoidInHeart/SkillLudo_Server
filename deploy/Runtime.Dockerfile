# Root-owned template installed by the operator; CI may upload application files only.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
ARG GIT_SHA
ENV NODE_ENV=production PORT=3000 GIT_SHA=${GIT_SHA} SKILLLUDO_ALLOW_DEBUG_DICE=false
LABEL org.opencontainers.image.source="https://github.com/VoidInHeart/SkillLudo_Server" org.opencontainers.image.revision=${GIT_SHA}
WORKDIR /app
COPY --chown=node:node . ./
USER node
EXPOSE 3000
CMD ["node", "--max-old-space-size=512", "dist/index.js"]
