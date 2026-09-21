FROM node:22-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS dependencies

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS runtime

ENV NODE_ENV=production

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN pnpm exec prisma generate
# Checkout may run under a restrictive host umask. Normalize only image contents;
# keep root ownership and grant the runtime user no additional write permissions.
RUN chmod -R a+rX /app
RUN mkdir -p /var/lib/npclassworks-npep && chown node:node /var/lib/npclassworks-npep && chmod 700 /var/lib/npclassworks-npep

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node scripts/npep-config.js check && ./node_modules/.bin/prisma migrate deploy && exec node ./bin/www"]
