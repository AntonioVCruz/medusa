FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS source

WORKDIR /source
COPY package.json yarn.lock .yarnrc.yml turbo.json _tsconfig.base.json ./
COPY .yarn/releases .yarn/releases
COPY .yarn/patches .yarn/patches
COPY packages packages
COPY integration-tests integration-tests
COPY scripts scripts

ARG BUILD_CONCURRENCY=4
RUN node .yarn/releases/yarn-4.18.1.cjs install --immutable --inline-builds
RUN node .yarn/releases/yarn-4.18.1.cjs turbo run build \
    --filter=@medusajs/medusa... \
    --filter=@medusajs/cli... \
    --filter=@medusajs/admin-sdk... \
    --concurrency=${BUILD_CONCURRENCY}
RUN node .yarn/releases/yarn-4.18.1.cjs workspace @medusajs/draft-order build:plugin \
    && node .yarn/releases/yarn-4.18.1.cjs workspace @medusajs/cloud build:plugin

ARG MEDUSA_SOURCE_REVISION
LABEL org.opencontainers.image.revision=$MEDUSA_SOURCE_REVISION
RUN test -n "$MEDUSA_SOURCE_REVISION" && printf '%s\n' "$MEDUSA_SOURCE_REVISION" > /source-revision

FROM source AS application
WORKDIR /app
COPY tests/E2E/app ./
RUN ln -s /source/node_modules node_modules
ENV ADMIN_AUTH_TYPE=jwt
ENV MEDUSA_TELEMETRY_DISABLED=true
RUN node /source/packages/cli/medusa-cli/cli.js build
RUN test -f .medusa/server/public/admin/index.html \
    && ln -s /source/node_modules .medusa/server/node_modules
WORKDIR /app/.medusa/server
CMD ["bash", "/app/start.sh"]
