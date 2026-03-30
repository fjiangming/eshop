#!/bin/sh
set -e

# 如果挂载外部 volume 但未挂载 config.yml，则复印 example 的做兜底
if [ ! -f "/app/config.yml" ]; then
    echo "未检测到 /app/config.yml，正在从最初始的模板 config.yml.example 复制一份..."
    cp /app/config.yml.example /app/config.yml
fi

echo ">> 启动 Dujiao-Next API 服务 (Go Backend)..."
cd /app
./dujiao-api &
API_PID=$!

echo ">> 启动内部 Nginx 网关代理服务..."
# 以阻塞前台进程方式启动
nginx -g "daemon off;" &
NGINX_PID=$!

echo ">> Dujiao-Next AIO 合并节点启动完成，服务监听端口 :80"

# 等待任何一个核心后台进程（Go 或 Nginx）退出则报错终止容器，预防死锁
wait -n

echo "检测到核心守护进程已退出，系统挂起！"
exit 1
