# 🔗 卡密同步工具 (sync-tool)

> **NewAPI 兑换码 → Dujiao-Next 卡密** 自动补货服务

定时监控 Dujiao-Next 商品库存，库存低于阈值时自动在 NewAPI 创建兑换码并批量导入到 Dujiao-Next，实现全自动卡密补货闭环。

## ✨ 功能特性

- **自动补货**：定时巡检库存 → 创建兑换码 → 导入卡密，全链路自动化
- **自动登录**：存储 Dujiao 管理员凭据，自动获取 JWT 并在过期前续期（24h 有效期，提前 1h 刷新）
- **WebUI 管理面板**：深色主题仪表盘，支持任务 CRUD、配置管理、实时日志
- **SKU 选择器**：从 Dujiao 拉取商品列表，支持多 SKU 选择
- **任务开关**：一键启用/禁用单个任务
- **实时日志**：SSE 推送，浏览器实时查看执行状态
- **API 认证**：sync-tool 自身带密码登录 + Token 认证，保护管理接口

## 📁 项目结构

```
sync-tool/
├── server.js              # 后端服务（Express）
├── public/
│   └── index.html         # WebUI 前端（单文件）
├── config.example.json    # 配置模板
├── config.json            # 运行时配置（自动生成，已 gitignore）
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
└── .gitignore
```

## 🚀 快速开始

### 本地开发

```bash
cd sync-tool

# 安装依赖
npm install

# 启动（开发模式，文件变更自动重启）
npm run dev

# 启动（生产模式）
npm start
```

首次启动会从 `config.example.json` 复制生成 `config.json`，打开浏览器访问 `http://localhost:2050`，默认密码 `changeme`。

### 初始配置

1. 登录后切换到 **⚙️ 全局配置** 页签
2. 填写 **NewAPI 地址** 和 **Token**
3. 填写 **Dujiao-Next 地址**、**管理员用户名** 和 **密码**
4. 点击 **🔗 测试连接** 验证 Dujiao 凭据
5. 按需开启 **定时巡检** 并设置 Cron 表达式
6. 修改默认登录密码
7. 点击 **💾 保存配置**

### 创建补货任务

1. 切换到 **📋 任务管理** 页签
2. 点击 **+ 新建任务**
3. 点击 **📦 从 Dujiao 拉取商品列表** 选择商品和 SKU
4. 设置库存阈值和目标库存
5. 配置 NewAPI 兑换码参数（额度、前缀等）
6. 保存并点击 **▶ 执行** 测试

---

## 🐳 Docker Compose 部署

### 方式一：免构建部署（推荐）

无需拉取源码，在服务器上创建一个空目录，只需两个文件即可运行：

```bash
mkdir -p /opt/sync-tool && cd /opt/sync-tool
```

**① 创建 `docker-compose.yml`**：

```yaml
services:
  sync-tool:
    image: ghcr.io/fjiangming/eshop-sync-tool:latest
    container_name: eshop-sync-tool
    restart: unless-stopped
    ports:
      - "2050:2050"
    volumes:
      - ./config.json:/app/config.json
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai
```

**② 创建 `config.json`**（参考下方 [准备配置文件](#2-准备配置文件) 章节）

**③ 启动**：

```bash
docker compose up -d
```

> 更新时只需 `docker compose pull && docker compose up -d`，无需重新构建。

---

### 方式二：拉取源码构建部署

```bash
# Git 克隆
git clone https://github.com/fjiangming/eshop.git
cd eshop/sync-tool

# 或仅上传 sync-tool 目录
scp -r sync-tool/ root@your-server:/opt/sync-tool
ssh root@your-server
cd /opt/sync-tool
```

### 准备配置文件

```bash
# 从模板创建配置（必须在启动前完成）
cp config.example.json config.json

# 编辑配置
vi config.json
```

按需修改以下字段：

```jsonc
{
  "auth_password": "your-strong-password",   // 修改登录密码！
  "port": 2050,
  "newapi": {
    "base_url": "https://your-newapi-domain.com",
    "token": "your-newapi-admin-token"
  },
  "dujiao": {
    "base_url": "https://your-dujiao-domain.com",
    "username": "admin",
    "password": "your-admin-password"
  },
  "cron_enabled": false,
  "cron_expression": "*/10 * * * *",
  "tasks": []
}
```

### 构建并启动（方式二适用）

```bash
# 构建镜像并后台启动
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止服务
docker compose down
```

### 访问面板

浏览器打开 `http://your-server-ip:2050`，使用配置文件中的密码登录。

### 更新部署

```bash
cd /opt/sync-tool

# 方式一（免构建）：拉取最新镜像
docker compose pull && docker compose up -d

# 方式二（源码构建）：拉取代码后重新构建
git pull && docker compose up -d --build
```

---

## 🔒 安全建议

- **修改默认密码**：首次部署务必修改 `auth_password`
- **专用账号**：为 sync-tool 在 Dujiao-Next 中创建专用管理员（`operations` 角色），避免使用超级管理员
- **禁用 2FA**：自动登录不支持 2FA，专用账号请勿开启两步验证
- **反向代理**：生产环境建议通过 Nginx 反向代理并启用 HTTPS

### Nginx 反向代理示例

```nginx
server {
    listen 443 ssl;
    server_name sync.your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:2050;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 支持
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

## ⏰ Cron 表达式参考

| 表达式 | 含义 |
|--------|------|
| `*/5 * * * *` | 每 5 分钟 |
| `*/10 * * * *` | 每 10 分钟 |
| `0 * * * *` | 每小时整点 |
| `0 */6 * * *` | 每 6 小时 |
| `0 9,21 * * *` | 每天 9:00 和 21:00 |

## 📡 API 接口

所有接口（除 login 和 events）需携带 `Authorization: Bearer <token>` 请求头。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 登录获取 Token |
| POST | `/api/logout` | 登出 |
| GET | `/api/events` | SSE 实时日志流 |
| GET | `/api/config` | 获取配置（脱敏） |
| PUT | `/api/config` | 更新配置 |
| POST | `/api/dujiao/test-login` | 测试 Dujiao 连接 |
| GET | `/api/dujiao/token-status` | 查询 Dujiao Token 状态 |
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks` | 创建任务 |
| PUT | `/api/tasks/:id` | 更新任务 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| PATCH | `/api/tasks/:id/toggle` | 切换启用/禁用 |
| POST | `/api/tasks/:id/execute` | 手动执行任务 |
| POST | `/api/tasks/:id/check` | 查询库存（不补货） |
| POST | `/api/tasks/execute-all` | 执行全部启用任务 |
