# ---- 构建阶段 ----
FROM node:22-alpine AS builder

WORKDIR /app

# 启用 corepack 以使用 package.json 中 packageManager 指定的 pnpm 版本
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# 只保留生产依赖
RUN pnpm prune --prod

# ---- 运行阶段 ----
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# 目标机器内存有限，限制 V8 堆上限避免挤占其他服务
ENV NODE_OPTIONS=--max-old-space-size=96

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# 使用非 root 用户运行
USER node

EXPOSE 7791

CMD ["node", "dist/index.js"]
