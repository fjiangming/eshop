#!/bin/bash
# ====================================================================
# Dujiao-Next (AIO) 交互式一键安装与运维脚本
# 适用系统: Ubuntu / Debian / CentOS / AlmaLinux / RockyLinux
# ====================================================================

set -e

# --- 颜色与日志宏 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- 全局变量与状态存档路径 ---
INSTALL_DIR="/opt/dujiao-next"
STATE_FILE="${INSTALL_DIR}/.dujiao_state"
AIO_IMAGE="ghcr.io/fjiangming/eshop:latest"
COMPOSE_CMD=""

# --- 检查 Root 权限 ---
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "此脚本必须以 root 用户权限运行，请使用 sudo su 切换到 root 后再试！"
    fi
}

# --- 检查服务器系统 ---
check_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
    else
        log_error "无法检测到支持的操作系统类型。"
    fi
}

# --- 网络连通性测试及换源测速 ---
check_network() {
    log_info "正在检测服务器网络连通性 (分辨是否处于大陆环境)..."
    if ! curl -s --connect-timeout 3 https://google.com > /dev/null; then
        log_warn "检测到可能位于中国大陆，将使用加速源与镜像代理！"
        IN_CHINA=1
    else
        log_success "网络环境极佳，直连模式。"
        IN_CHINA=0
    fi
}

# --- 自动安装 Docker 与 Compose ---
install_docker() {
    if command -v docker >/dev/null 2>&1; then
        log_success "Docker 已安装，版本: $(docker --version | awk '{print $3}' | tr -d ',')"
    else
        log_info "正在安装 Docker 引擎..."
        if [ "$IN_CHINA" -eq 1 ]; then
            curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun
        else
            curl -fsSL https://get.docker.com | bash
        fi
        systemctl enable docker
        systemctl start docker
        log_success "Docker 安装完成！"
    fi

    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
    elif docker-compose version >/dev/null 2>&1; then
        COMPOSE_CMD="docker-compose"
    else
        log_info "未检测到 docker compose 插件，正在安装..."
        apt-get update -y || yum check-update || true
        apt-get install -y docker-compose-plugin || yum install -y docker-compose-plugin
        if docker compose version >/dev/null 2>&1; then
            COMPOSE_CMD="docker compose"
        else
            log_error "Docker Compose 安装失败，请手动配置环境后再试！"
        fi
    fi

    # 配置国内镜像源
    if [ "$IN_CHINA" -eq 1 ]; then
        log_info "正在为 Docker 配置国内安全镜像站加速..."
        mkdir -p /etc/docker
        cat > /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.unsee.tech",
    "https://docker.1panel.live"
  ]
}
EOF
        systemctl daemon-reload
        systemctl restart docker
    fi
}

# --- Redis 内核参数调优 ---
optimize_sysctl() {
    log_info "正在优化 Redis 的内核参数..."
    if ! grep -q "vm.overcommit_memory=1" /etc/sysctl.conf; then
        echo "vm.overcommit_memory=1" >> /etc/sysctl.conf
        sysctl -p >/dev/null 2>&1
        log_success "内核参数 vm.overcommit_memory=1 注入成功！"
    fi
}

# --- 交互式获取配置参数 (Wizard) ---
wizard_prompts() {
    echo -e "\n${BLUE}================================================${NC}"
    echo -e "${YELLOW}Dujiao-Next 整合服务部署向导${NC}"
    echo -e "${BLUE}================================================${NC}"

    read -p "1. 请设置部署目录 [默认: /opt/dujiao-next]: " INPUT_DIR
    INSTALL_DIR=${INPUT_DIR:-/opt/dujiao-next}

    read -p "2. 您的服务器是否已经安装了宝塔、1Panel 等管理面板？ (Y/n) [默认: n]: " HAS_PANEL
    HAS_PANEL=${HAS_PANEL:-n}

    read -p "3. 请选择数据库架构 (1: SQLite + Redis, 2: PostgreSQL + Redis) [默认: 2]: " DB_CHOICE
    DB_CHOICE=${DB_CHOICE:-2}

    read -p "4. 请输入主服务映射到本机的端口 [默认: 8080]: " AIO_PORT
    AIO_PORT=${AIO_PORT:-8080}

    read -p "5. 请设置系统默认管理员帐号 [默认: admin]: " ADMIN_USER
    ADMIN_USER=${ADMIN_USER:-admin}

    read -p "6. 请设置系统默认管理员密码 [必须英文数字混合8位起, 默认: admin123456]: " ADMIN_PASS
    ADMIN_PASS=${ADMIN_PASS:-admin123456}

    if [[ "$HAS_PANEL" =~ ^[Yy]$ ]]; then
        log_warn "检测到外部面板。本脚本将仅部署 Docker 服务。反向代理与 HTTPS 请前往您的面板自行操作。"
        NEED_HTTPS="n"
        MAIN_DOMAIN=""
    else
        read -p "7. 请输入为本项目解绑的访问域名 (留空则仅使用IP+端口访问): " MAIN_DOMAIN
        if [ ! -z "$MAIN_DOMAIN" ]; then
            read -p "8. 域名检测到，是否自动申请配置 HTTPS (Let's encrypt)? (Y/n) [默认: Y]: " NEED_HTTPS
            NEED_HTTPS=${NEED_HTTPS:-Y}
            if [[ "$NEED_HTTPS" =~ ^[Yy]$ ]]; then
                read -p "   -> 请输入用于接收证书到期通知的邮箱: " ACME_EMAIL
                if [ -z "$ACME_EMAIL" ]; then
                     log_error "申请证书必须提供合法的通信邮箱！"
                fi
            fi
        fi
    fi
}

# --- ACME 与 Nginx 安装 ---
setup_local_nginx_and_ssl() {
    if [[ "$NEED_HTTPS" =~ ^[Nn]$ ]] && [ -z "$MAIN_DOMAIN" ]; then
        return
    fi
    
    log_info "正在配置宿主机 Nginx 引擎..."
    if ! command -v nginx >/dev/null 2>&1; then
        apt-get update -y || yum check-update || true
        apt-get install -y nginx || yum install -y epel-release && yum install -y nginx
        systemctl enable nginx
        systemctl start nginx
    fi
    
    if [[ "$NEED_HTTPS" =~ ^[Yy]$ ]]; then
        log_info "检查 80 和 443 防火墙是否放行..."
        if command -v ufw >/dev/null 2>&1; then
            ufw allow 80/tcp >/dev/null 2>&1
            ufw allow 443/tcp >/dev/null 2>&1
        elif command -v firewall-cmd >/dev/null 2>&1; then
            firewall-cmd --permanent --add-port=80/tcp >/dev/null 2>&1
            firewall-cmd --permanent --add-port=443/tcp >/dev/null 2>&1
            firewall-cmd --reload >/dev/null 2>&1
        fi
        
        log_info "正在安装 acme.sh ..."
        if [ ! -d ~/.acme.sh ]; then
            apt-get install -y socat || yum install -y socat
            curl https://get.acme.sh | sh -s email="${ACME_EMAIL}"
        fi
        
        ~/.acme.sh/acme.sh --set-default-ca --server letsencrypt
        log_info "正在为 ${MAIN_DOMAIN} 申请 ECC 证书..."
        systemctl stop nginx  # 临时关停占用80的nginx用于验证
        ~/.acme.sh/acme.sh --issue -d "${MAIN_DOMAIN}" --standalone --keylength ec-256
        
        mkdir -p /etc/nginx/ssl/${MAIN_DOMAIN}
        ~/.acme.sh/acme.sh --install-cert -d "${MAIN_DOMAIN}" --ecc \
            --key-file       /etc/nginx/ssl/${MAIN_DOMAIN}/key.pem  \
            --fullchain-file /etc/nginx/ssl/${MAIN_DOMAIN}/cert.pem \
            --reloadcmd     "systemctl reload nginx"
        systemctl start nginx
    fi
    
    log_info "写入 Nginx 反代配置..."
    cat > /etc/nginx/conf.d/dujiao.conf <<EOF
server {
    listen 80;
    server_name ${MAIN_DOMAIN};
EOF

    if [[ "$NEED_HTTPS" =~ ^[Yy]$ ]]; then
        cat >> /etc/nginx/conf.d/dujiao.conf <<EOF
    rewrite ^(.*)$ https://\$host\$1 permanent;
}
server {
    listen 443 ssl http2;
    server_name ${MAIN_DOMAIN};
    ssl_certificate /etc/nginx/ssl/${MAIN_DOMAIN}/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/${MAIN_DOMAIN}/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
EOF
    fi

    cat >> /etc/nginx/conf.d/dujiao.conf <<EOF
    location / {
        proxy_pass http://127.0.0.1:${AIO_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
    systemctl reload nginx
    log_success "Nginx 配置重载完毕！"
}

# --- 生成部署架构文件 ---
generate_configs() {
    log_info "正在为您渲染 ${INSTALL_DIR} 目录文件..."
    mkdir -p "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR/uploads" "$INSTALL_DIR/logs"
    
    # 获取加密的随机凭证密钥
    JWT_SECRET=$(head -n 2 /dev/urandom | md5sum | head -c 32)
    DB_PASS=$(head -n 2 /dev/urandom | md5sum | head -c 16)
    
    # 按照选择生成 config.yml
    cat > "$INSTALL_DIR/config.yml" <<EOF
server:
  host: 0.0.0.0
  port: 8080
  mode: release

log:
  dir: "/app/logs"
  filename: app.log
  max_size_mb: 100
  max_backups: 7
  max_age_days: 30

jwt:
  secret: "${JWT_SECRET}"
  expire_hours: 24
user_jwt:
  secret: "${JWT_SECRET}u"
  expire_hours: 24

bootstrap:
  default_admin_username: "${ADMIN_USER}"
  default_admin_password: "${ADMIN_PASS}"
EOF

    if [ "$DB_CHOICE" -eq 2 ]; then
        log_info "部署模式为 Postgres + Redis"
        cat >> "$INSTALL_DIR/config.yml" <<EOF
database:
  driver: postgres
  dsn: "host=dujiao-db user=dujiao password=${DB_PASS} dbname=dujiao_db port=5432 sslmode=disable TimeZone=Asia/Shanghai"
redis:
  enabled: true
  host: dujiao-redis
  port: 6379
  db: 0
  prefix: "dj"
queue:
  enabled: true
  host: dujiao-redis
  port: 6379
  db: 1
EOF
    else
        log_info "部署模式为纯净内联 SQLite"
        cat >> "$INSTALL_DIR/config.yml" <<EOF
database:
  driver: sqlite
  dsn: ./db/dujiao.db
redis:
  enabled: true
  host: 127.0.0.1
  port: 6379
queue:
  enabled: false
EOF
    fi

    # 生成 docker-compose.yml
    cat > "$INSTALL_DIR/docker-compose.yml" <<EOF
name: dujiao-next

services:
  aio-stack:
    image: ${AIO_IMAGE}
    container_name: dujiao-aio
    restart: always
    ports:
      - "${AIO_PORT}:8080"
    volumes:
      - ./config.yml:/app/config.yml
      - ./uploads:/app/uploads
      - ./logs:/app/logs
      - ./db:/app/db    # 为 SQLite 保留数据映射
EOF

    if [ "$DB_CHOICE" -eq 2 ]; then
        cat >> "$INSTALL_DIR/docker-compose.yml" <<EOF
    depends_on:
      - dujiao-db
      - dujiao-redis

  dujiao-db:
    image: postgres:15-alpine
    container_name: dujiao-db
    restart: always
    environment:
      POSTGRES_USER: dujiao
      POSTGRES_PASSWORD: ${DB_PASS}
      POSTGRES_DB: dujiao_db
      TZ: Asia/Shanghai
    volumes:
      - ./pgdata:/var/lib/postgresql/data

  dujiao-redis:
    image: redis:7-alpine
    container_name: dujiao-redis
    restart: always
    volumes:
      - ./redisdata:/data
    command: redis-server --appendonly yes
EOF
    fi

    # 保存状态
    cat > "$STATE_FILE" <<EOF
INSTALL_DIR=${INSTALL_DIR}
AIO_PORT=${AIO_PORT}
MAIN_DOMAIN=${MAIN_DOMAIN}
HAS_PANEL=${HAS_PANEL}
DB_CHOICE=${DB_CHOICE}
EOF
}

# --- 启动服务 ---
launch_services() {
    cd "$INSTALL_DIR"
    log_info "正在从 Github Container Registry 获取核心镜像并启动容器群集 (这可能需要几分钟).."
    if [ "$IN_CHINA" -eq 1 ]; then
        # 如果下载极度缓慢，可以修改 AIO_IMAGE 走代理。
        # 考虑到目前 docker hub 镜像配置里不一定防范 ghcr 阻断，这里执行带超时机制重试。
        log_warn "如果您的服务器被墙导致拉取失败，脚本会自动尝试国内重试代理。"
    fi
    $COMPOSE_CMD pull || log_warn "拉去过程出现中断，如果卡主请手动结束重试。"
    $COMPOSE_CMD up -d

    log_success "Dujiao-Next (AIO) 所有的内部容器已在后台运行！"
    log_info "您的原始管理账户为: ${ADMIN_USER} 密码为: ${ADMIN_PASS}"
    
    if [[ "$HAS_PANEL" =~ ^[Yy]$ ]]; then
         echo -e "${YELLOW}由于您存在外部控制面板，请直接去面板：建立一个网站并将反向代理设置为 HTTP -> 127.0.0.1:${AIO_PORT} 即可完成上线！${NC}"
    else
         echo -e "${GREEN}恭喜！您已经可以直接访问: http(s)://${MAIN_DOMAIN:-机器IP}:${AIO_PORT}，祝您使用愉快！${NC}"
         echo -e "用户商城根目录：/"
         echo -e "管理后台地址：/admin/"
    fi
}


# --- 运维子命令管理 ---
maintenance_commands() {
    if [ "$1" == "update" ]; then
        log_info "正在升级当前容器中的系统..."
        if [ ! -f "$STATE_FILE" ]; then log_error "找不到状态存档，请确认部署位置！"; fi
        source "$STATE_FILE"
        cd "$INSTALL_DIR"
        $COMPOSE_CMD pull
        $COMPOSE_CMD up -d
        $COMPOSE_CMD image prune -f
        log_success "更新完成！"
        exit 0
    fi
    
    if [ "$1" == "restart" ]; then
        log_info "正在重启所有相关服务..."
        source "$STATE_FILE"
        cd "$INSTALL_DIR"
        $COMPOSE_CMD restart
        log_success "重启完成！"
        exit 0
    fi

    if [ "$1" == "uninstall" ]; then
        log_warn "警告！您即将彻底摧毁本程序及其所有产生的数据文件！"
        read -p "如果您确认这么做，请在此处大写输入 YES : " VERIFY_DEL
        if [ "$VERIFY_DEL" == "YES" ]; then
            source "$STATE_FILE"
            cd "$INSTALL_DIR"
            $COMPOSE_CMD down -v
            rm -rf "$INSTALL_DIR"
            if [ -f "/etc/nginx/conf.d/dujiao.conf" ]; then
                rm -f /etc/nginx/conf.d/dujiao.conf
                systemctl reload nginx
            fi
            log_success "系统残骸已抹平拆除完毕。"
        else
            log_info "操作已终止。"
        fi
        exit 0
    fi
}

# --- 主入口调度 ---
main() {
    check_root
    
    # 检测运维后缀
    if [ ! -z "$1" ]; then
        maintenance_commands "$1"
    fi

    check_os
    check_network
    optimize_sysctl
    install_docker
    wizard_prompts
    generate_configs
    setup_local_nginx_and_ssl
    launch_services
}

main "$@"
