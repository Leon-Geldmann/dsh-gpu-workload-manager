# 安装与使用说明

## 1. 部署前提

两台机器都已经安装 DSH agent。Ubuntu 是唯一 GPU 计算节点，Mac mini 不运行 `llama.cpp`，只通过局域网访问 Ubuntu manager。

必须满足：

- Node.js `22.x`；
- pnpm `11.x`；
- DSH 精确为 `0.1.1-rc.2`；
- Ubuntu 已安装可工作的 Vulkan `llama-server`，模型文件路径、大小与 SHA-256 已写入 `deploy/config/models.production.json`；
- Mac mini 已安装 Xcode Command Line Tools；
- Ubuntu 的 `8080/tcp` 仅允许 loopback 和受信任的私有局域网段；
- 已准备两个不同的 64 位十六进制 key：管理 key 与推理 key。

发布仓库不会包含 key、GGUF、环境文件或任何 credential。

## 2. 获取源码或发布包

从源码构建：

```bash
git clone https://github.com/Leon-Geldmann/dsh-gpu-workload-manager.git
cd dsh-gpu-workload-manager
git checkout v0.1.0
pnpm install --frozen-lockfile
deploy/scripts/build-bundle.sh
```

也可以在 GitHub Release 页面下载三个 `.tgz` 与 `SHA256SUMS`，放到仓库的 `dist/packages/`：

```bash
mkdir -p dist/packages
gh release download v0.1.0 \
  --repo Leon-Geldmann/dsh-gpu-workload-manager \
  --pattern '*.tgz' \
  --pattern SHA256SUMS \
  --dir dist/packages
```

Ubuntu 校验：

```bash
(cd dist/packages && sha256sum -c SHA256SUMS)
```

macOS 校验：

```bash
(cd dist/packages && shasum -a 256 -c SHA256SUMS)
```

必须恰好有三个归档且全部报告 `OK`。不要解包修改后重新打包。

## 3. 安装 Ubuntu DSH 角色

Ubuntu 的 DSH owner 执行：

```bash
deploy/scripts/install-dsh-bundle.sh \
  --role server \
  --manager-url http://127.0.0.1:8080
```

`--manager-url` 对 server 可省略，默认仍是 loopback。安装器将相同的三个包事务化安装到 DSH `web` 与 `headless` profile，并在 DSH home 的 `.env` 中维护：

```dotenv
GPU_WORKLOAD_ROLE=server
GPU_WORKLOAD_MANAGER_URL=http://127.0.0.1:8080
```

这里不会保存 credential，也不会重启 DSH 或 manager。

Ubuntu daemon 的全新迁移涉及 root-owned release、模型散列、防火墙、canary、旧服务停止与自动回滚。首次部署必须按 [运维手册](OPERATIONS.zh-CN.md) 的 Ubuntu 迁移章节执行，不能直接复制 systemd unit 绕过 preflight。

## 4. 安装 Mac mini DSH 角色

先确认 manager LAN health 可达：

```bash
curl -fsS "http://<UBUNTU_LAN_IP>:8080/health"
```

随后由 Mac mini 的 DSH owner 执行：

```bash
deploy/scripts/install-dsh-bundle.sh \
  --role client \
  --manager-url "http://<UBUNTU_LAN_IP>:8080"
```

client 没有默认地址；漏掉 `--manager-url` 会在任何 DSH 写入之前失败。只接受带显式端口的 RFC1918 IPv4 HTTP origin，不接受公网 IP、HTTPS、路径、query、fragment 或内嵌账号密码。

## 5. 配置 DSH credential

在两台机器各自的 DSH Web credential 设置中创建：

| 引用名 | 值来源 | 用途 |
|---|---|---|
| `GPU_MANAGER_KEY` | Ubuntu `management.key` | `/gpu/v1/*` 人工管理操作 |
| `LLAMA_CPP_API_KEY` | Ubuntu `inference.key` | `/v1/*` 本地推理 |

两个值必须不同。不要写入 `.env`、provider YAML、shell history、截图或 Codex prompt。Mac mini 需要通过安全的现有渠道取得这些值；本项目不传输 credential。

## 6. 配置 `llama-local` provider

bundle 不会改写现有 provider，以免影响在线模型。两端都应保留或创建 provider ID `llama-local`：

```yaml
llm-pi-ai:
  providers:
    llama-local:
      displayName: Local Qwen3.8 llama.cpp
      apiKeyEnv: LLAMA_CPP_API_KEY
      api: openai-completions
      baseURL: <ROLE_SPECIFIC_BASE_URL>
      models:
        - id: qwen3.8-27b
        - id: qwen3.8-27b-uncensored
        - id: qwen3.8-27b-q4
        - id: qwen3.8-27b-uncensored-q4
```

Ubuntu 的 `baseURL` 是 `http://127.0.0.1:8080/v1`；Mac mini 是 `http://<UBUNTU_LAN_IP>:8080/v1`。在线 provider 的 ID、模型、credential 和 base URL 不得修改。

## 7. 重启和只读验收

在维护窗口使用当前机器既有的启动方式重启 DSH agent。安装器不会猜测它由 shell、launchd、systemd user unit 还是其他 supervisor 管理。

Ubuntu DSH owner stage：

```bash
deploy/scripts/verify-live.sh \
  --role ubuntu \
  --dsh-home "${DSH_HOME:-$HOME/.dsh}" \
  --dsh-only
```

Mac mini：

```bash
deploy/scripts/verify-live.sh \
  --role mac \
  --dsh-home "${DSH_HOME:-$HOME/.dsh}" \
  --manager-url "http://<UBUNTU_LAN_IP>:8080"
```

verifier 只读，不改文件、不切模型、不改防火墙。Ubuntu 的 system-only root 验收必须使用 installer 已复制进内容寻址 release 的 verifier，具体命令见运维手册。

## 8. UI 验收

重启后先确认没有模型驻留：

- manager 状态为 `UNLOADED`；
- Ubuntu 上没有 `127.0.0.1:18080` listener；
- 对话框右下角出现 `GPU` 按钮；
- 四个 `llama-local` 模型全部置灰，提示“请通过 GPU Workload Manager 切换”；
- 在线模型仍可选择。

然后由操作者手工加载一个本地模型，确认只有当前模型可选。存在本地请求时尝试切换，应看到高亮的“排队”与红色的“强行停止并切换”。部署验收本身不要自动加载、切换或卸载模型。

## 9. 常见故障

- `cannot get property "remote.gpuWorkloads" without inject`：安装了旧 selector 包或 profile 仍引用旧内容；重新下载同一 release、校验 SHA、重复运行安装器并重启 DSH。
- `--manager-url is required for role client`：为 Mac 安装命令补上 Ubuntu 的私网 origin。
- `invalid_manager_url`：URL 必须形如 `http://192.168.x.y:8080`，不能包含路径或凭据。
- `Failed to load plugins`：执行 `dsh --profile web --dump-config` 与 `dsh --profile headless --dump-config`，确认三个本地包均来自 `$DSH_HOME/.gpu-workload-manager/packages/` 的同一 release。
- 重启后没有模型：这是预期状态；请从 GPU Workload Manager 手工装载。
