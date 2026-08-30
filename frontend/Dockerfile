# 前端静态产物构建镜像（docker-compose.yml frontend 服务）。
# 产物输出到 /app/dist，由命名卷 frontend_build 挂载共享给 nginx 容器托管。
FROM node:20-alpine AS build

WORKDIR /app

# 启用 corepack 以使用项目锁定的 pnpm 版本
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# 生产构建（tsc -b && vite build），产物在 /app/dist
RUN pnpm run build

FROM scratch
COPY --from=build /app/dist /app/dist

WORKDIR /app/dist
