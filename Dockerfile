FROM oven/bun:1 AS builder
WORKDIR /app

COPY . .

RUN bun install

# Build without --frozen-lockfile since lockfile is gitignored
RUN bunx vite build

# ---

FROM oven/bun:1-slim AS runner
WORKDIR /app

COPY --from=builder /app/.output ./.output

ENV PORT=7739
ENV DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 7739

CMD ["bun", ".output/server/index.mjs"]
