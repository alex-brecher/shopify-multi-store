# Hosted connector image ("any server" option): runs `shopify-multi-store serve`.
# See docs/HOSTED.md. For Cloudflare Workers use wrangler.jsonc and docs/DEPLOY-CLOUDFLARE.md.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20-slim
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    SHOPIFY_MULTI_STORE_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY schemas ./schemas
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "scripts/cli.mjs", "serve"]
