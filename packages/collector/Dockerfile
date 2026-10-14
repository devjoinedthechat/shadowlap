# The Shadowlap telemetry collector. Build from the repository root:
#   docker build -f packages/collector/Dockerfile -t shadowlap-collector .
#   docker run -p 8787:8787 -v collector-data:/data -e COLLECTOR_DB=/data/collector.db shadowlap-collector
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY testing ./testing
COPY sdks ./sdks
RUN npm ci --no-audit --no-fund && npx tsc -b packages/collector

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 COLLECTOR_DB=/data/collector.db
COPY --from=build /src/packages/collector/package.json ./package.json
COPY --from=build /src/packages/collector/dist ./dist
COPY --from=build /src/packages/collector/bin ./bin
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "bin/shadowlap-collector.js"]
