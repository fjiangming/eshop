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

## 🚀 一键全栈自动化本地极速部署

我们特别为你提供了带彩色中控指引与交互向导的开箱即用（Out of the box!）装配脚本 `install.sh`。它可以帮助小白：
1. **自动清理环境与探测国内防火墙并加速换源**
2. **免手写自动部署 Docker/Docker-compose**
3. **基于图形向导为你定制私人的专属高并发（PostgreSQL/Redis）或轻量（SQLite）容器矩阵组合！** 

只需使用 Root 权限，在物理机执行以下一行代码：

```bash
bash <(curl -sL https://raw.githubusercontent.com/fjiangming/eshop/main/install.sh)
```

**交互式提问示例**：
- 它会询问你的部署目录、主域名是哪一个（自动切断外部 1panel），以及你是否需要开启HTTPS。如果开启了HTTPS，它还自带 ACME 环境签署和自动续期逻辑！

---

## 🛠 系统的运维操作命令

当通过一键脚本 `install.sh` 装配结束后，系统会自动在你的 Linux 中注册一个全局的高级快捷运维指令 `dujiao`：

```bash
# 无缝平滑的自动升级（自动拉取 GitHub 最新镜像并热更新容器）：
dujiao update 

# 系统后台微服务卡顿或报错重启
dujiao restart 

# 卸载面板，移除所有运行环境镜像与废墟残骸（销毁所有数据！注意备份）
dujiao uninstall 

# 随时在终端内呼叫帮助菜单
dujiao help
```

---

## 如果你更偏好纯净的高级裸配 (非必须)

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
