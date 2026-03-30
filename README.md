# Dujiao-Next AIO (All-in-One) Docker Deployment

这是一个专为 [Dujiao-Next](https://github.com/dujiao-next) 独角数卡商城生态整合打造的一体化 Docker 部署方案（AIO）。  
它通过极简优雅的多阶段构建技术，将 Dujiao-Next 的三大核心开源服务整合进了同一个轻量级容器（基于 Alpine + Nginx），实现了真正的**一键拉取，全站启动**。

## 🎯 亮点特性

- **一站式（AIO）整合**：无需再分别部署且配置代理网关去对接前台（User）、管理后台（Admin）及后端（API）。所有核心应用环节统一集成。
- **纯粹的生产环境隔离**：容器内使用多重 `node` 与 `golang` 的 Multi-Stage 构建，最后交付的是极度纯净且免依赖体积的精简容器发行包，无源码垃圾残留。
- **防冲突静态路由策略**：在构建打包前沿注入环境变量修改，强制将 Admin 管理台挂载于 `/admin/` 子路由下，和 User 前台界面的根路径 `/` 互不干扰。
- **进程防挂死守护**：配合特定的并行 `entrypoint.sh`，后台任意服务崩溃（死锁或报错）均会捕获并且触发整体重启，系统长期稳定性大幅增强。
- **完全 CI/CD 自动化**：无缝连接 GitHub Actions。一旦本仓库代码发生向 `main` 分支的提交推送，云端会自动装配成最新镜像包丢向 GitHub Registry（GHCR）。

---

## 🚀 如何从云端部署使用？

由于镜像由 GitHub Action 自动编译后发布在您个人账户的 Container Registry 里，您在服务器只需一个配置文件即可启动系统。

### 1. 将配置文件拉取至你的运行服务器

您可以直接在云主机的任何一个指定目录，创建或者下载属于本仓库根目录的 `docker-compose.yml` 文件。如果是新机器：

```bash
mkdir my-shop && cd my-shop
wget https://raw.githubusercontent.com/fjiangming/eshop/main/docker-compose.yml
```

### 2. 启动服务

只要确认你拉下来这个 yml 文件内的镜像名字 `image: ghcr.io/fjiangming/eshop:latest` 正确，直接执行启服务命：

```bash
docker-compose up -d
```

服务初次启动后，它会自动帮您下载远程仓库刚发布成功的新镜像、执行容器进程，还会在您当前的终端目录下解压生成 `uploads/`（放置图片数据）、`logs/` （放置日志）这几个安全的隔离外挂文件夹！

### 3. 系统二次修改相关配置 

当容器第一次完成加载后，宿主机该目录将会被附赠生成最新的核心 `config.yml`。
您只需在此处输入您想要对接好的数据库连结地址（如果有必要，取消 `docker-compose.yml` 当中针对原生 Postgre 和 Redis 容器的独立注释以快速拉起一个），再次利用 `docker-compose restart` 就能生效使用！

---

## 🛠 本地二次开发以及手动魔改支持

除了利用在线 GitHub Action 来挂载云端发版通道以外。您可以随意克隆下来修改 `Dockerfile` 或是代理 `nginx.conf` 之后重编译构建这个私人一体化发行映像：

```bash
git clone https://github.com/fjiangming/eshop.git
cd eshop
docker build -t dujiao-aio:local .
```

随后利用此刚刚装好的本地域名将包 `docker-compose.yml` 的拉取标记改成 `dujiao-aio:local` 本机即可！

---
### 许可和原版权声明
本项目仅是对其进行了分发部署方案的技术组装集成以降低新手使用运维难度。代码内容的所有底层著作权和功能均归属于原开源团队 [Dujiao-Next](https://github.com/dujiao-next) 所有。
