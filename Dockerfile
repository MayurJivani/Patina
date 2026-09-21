FROM node:22-alpine AS builder
WORKDIR /app

# A NODE_ENV=production inherited from the build environment would skip
# devDependencies and leave Astro unable to build. Pin development here; the
# runtime stage sets production below.
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci

COPY astro.config.mjs tsconfig.json ./
COPY shared/ shared/
COPY src/ src/
COPY public/ public/
RUN npm run build

RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app

# tini reaps the zombies a long-lived WebSocket process would otherwise collect,
# and forwards SIGTERM so redeploys close sockets instead of dropping them.
RUN apk add --no-cache tini

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY server/ server/
COPY shared/ shared/

# The event log. compose mounts a named volume here — without it, a redeploy
# erases the year. There is no other copy: the live canvas, every month you can
# scrub to and the reel are all folds of this one file.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node

ENV NODE_ENV=production
ENV PORT=4323
EXPOSE 4323

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4323)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/index.js"]
