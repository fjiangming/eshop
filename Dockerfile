FROM node:20-alpine AS admin-builder
WORKDIR /src
RUN apk add --no-cache git
# 拉取 admin 端代码进行编译
RUN git clone https://github.com/dujiao-next/admin.git .
RUN npm install
# 强制将 Admin 打包到 /admin/ 基础路径下，防止与 User 端路由冲突
RUN npx vite build --base=/admin/

FROM node:20-alpine AS user-builder
WORKDIR /src
RUN apk add --no-cache git
# 拉取 user 端代码进行编译
RUN git clone https://github.com/dujiao-next/user.git .
RUN npm install
RUN npm run build

FROM golang:alpine AS api-builder
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
WORKDIR /src
RUN apk add --no-cache git
# 拉取 api 端代码进行编译
RUN git clone https://github.com/dujiao-next/dujiao-next.git .
ENV CGO_ENABLED=0
RUN go mod download
RUN set -eux; \
    export GOOS="$TARGETOS" GOARCH="$TARGETARCH"; \
    if [ "$TARGETARCH" = "arm" ] && [ -n "$TARGETVARIANT" ]; then export GOARM="${TARGETVARIANT#v}"; fi; \
    if [ "$TARGETARCH" = "amd64" ] && [ -n "$TARGETVARIANT" ]; then export GOAMD64="${TARGETVARIANT#v}"; fi; \
    go build -trimpath -tags release -ldflags="-s -w" -o /out/dujiao-api ./cmd/server

FROM alpine:latest
WORKDIR /app
# 安装 Nginx，时区及基础凭证，并创建必要的文件目录
RUN apk --no-cache add ca-certificates tzdata nginx \
    && mkdir -p /app/db /app/uploads /app/logs /run/nginx

# 拷贝 API 二进制和配置模板
COPY --from=api-builder /out/dujiao-api /app/dujiao-api
COPY --from=api-builder /src/config.yml.example /app/config.yml.example

# 拷贝 User UI 作为根目录静态资源
COPY --from=user-builder /src/dist /usr/share/nginx/html/

# 拷贝 Admin UI 作为子目录静态资源
COPY --from=admin-builder /src/dist /usr/share/nginx/html/admin/

# 拷贝自定义的配置和执行脚本
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 默认设置 Gin 环境变量为 release
ENV GIN_MODE=release

# 只暴露 HTTP 80 端口（对内由 Nginx 分发）
EXPOSE 80

CMD ["/app/entrypoint.sh"]
