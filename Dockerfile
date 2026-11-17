# HomeMinerProxy: one image for the proxy, the dashboard and the cube scoreboard.
# The service to run is chosen by the command (see compose.yaml).
FROM node:22-alpine

# python3 + Pillow + DejaVu only for the GeekMagic cube; tzdata for local time (quiet hours, cube clock)
RUN apk add --no-cache python3 py3-pillow font-dejavu tzdata openssl \
 && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY src/ package.json CHANGELOG.md ./
ARG COMMIT=""
RUN node -e 'const fs = require("fs"), v = require("./package.json").version, c = (process.env.COMMIT || "").trim().slice(0, 7) || null; fs.writeFileSync("version.json", JSON.stringify({ version: v, commit: c, installedAt: new Date().toISOString() }) + "\n");'

ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data
USER node

# 3000 dashboard · 3333-3341 Stratum proxy (3336 is internal stats, not published)
EXPOSE 3000 3333 3334 3335 3337 3338 3339 3340 3341
CMD ["node", "painel.js"]
