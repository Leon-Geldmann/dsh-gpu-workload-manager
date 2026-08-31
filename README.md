# DSH GPU Workload Manager

面向单 GPU、双主机 DeepSeek Harness（DSH）环境的手动模型驻留管理器。Ubuntu 工作站负责运行 `llama.cpp` 与 GPU workload manager，Mac mini 上的 DSH 通过局域网复用 Ubuntu 的模型算力；同一个 DSH bundle 安装到两台机器，通过 `server` / `client` 角色区分行为。

项目当前针对以下经过验证的组合：

- AMD Radeon RX 7900 XTX；
- `llama.cpp` Vulkan backend；
- Qwen3.8 27B 的四个本地 GGUF 变体；
- DSH `0.1.1-rc.2`；
- Node.js `22.x` 与 pnpm `11.x`。

这是一个面向特定本地部署的工程项目，不会下载 GGUF，也不会替你决定模型路径、校验值、防火墙网段或 GPU 参数。部署到其他环境前必须审核 `deploy/config/`。

## 为什么需要它

27B 模型装载到单张 GPU 会产生明显的首轮等待。完全按请求启动模型会增加 TTFT，而让多个模型常驻又会耗尽显存。这个项目把取舍变成一个明确的人工动作：需要某个模型时手动装载或切换，不需要时手动卸载；manager 与 Ubuntu 重启后保持无模型状态。

```text
Mac mini                                               Ubuntu GPU 工作站
┌──────────────────────────┐                 ┌─────────────────────────────┐
│ DSH agent                │    private LAN  │ DSH agent (server role)     │
│ GPU bundle (client role) ├────────────────►│ GPU workload manager :8080  │
│ llama-local provider     │                 │ llama.cpp child :18080      │
└──────────────────────────┘                 │ Radeon RX 7900 XTX           │
                                             └─────────────────────────────┘
```

## 行为保证

- 仅允许人工 `load`、`switch`、`unload` 和 `cancel`；不会根据 prompt 自动换模。
- 启动初始状态固定为 `UNLOADED`，不会恢复上次驻留模型。
- DSH 对话框右下角提供 `GPU` 入口；也可输入 `/gpu` 打开管理面板。
- 本地 provider `llama-local` 中，非当前模型显示为灰色且不可点击，并提示“请通过 GPU Workload Manager 切换”。
- 在线 provider 不经过本地 GPU policy，模型选择与正在运行的云端请求不受影响。
- 存在本地推理请求时，切换弹窗将“排队”作为高亮默认操作；“强行停止并切换”为红色危险操作。
- 管理密钥由 DSH host 从 credential store 解析，浏览器插件不会收到 bearer key。

## 组成

| 目录 | 作用 |
|---|---|
| `packages/managerd` | Ubuntu manager daemon、OpenAI-compatible inference proxy、进程与请求生命周期 |
| `packages/dsh-plugin` | DSH host 插件、命令与受认证的 manager remote |
| `packages/dsh-model-selection` | Web 管理面板、模型选择禁用策略、busy 对话框 |
| `packages/bundle` | 同时装入 DSH `web` 与 `headless` profile 的 bundle |
| `deploy/scripts` | 可复现构建、事务化 DSH 安装、Ubuntu 迁移、回滚与只读验收 |
| `deploy/config` | 当前硬件部署的严格 runtime/catalog 配置，移植前必须审核 |

## 快速开始

完整步骤见 [安装与使用说明](docs/INSTALL.zh-CN.md)。Mac mini 单独部署见 [Mac mini 部署指南](docs/MAC_MINI_DEPLOY.zh-CN.md)，生产维护边界见 [运维手册](docs/OPERATIONS.zh-CN.md)。

构建 DSH 包：

```bash
node --version   # v22.x
pnpm --version   # 11.x
pnpm install --frozen-lockfile
deploy/scripts/build-bundle.sh
```

Ubuntu 的现有 DSH 安装 `server` 角色：

```bash
deploy/scripts/install-dsh-bundle.sh --role server
```

Mac mini 的现有 DSH 必须显式提供 Ubuntu 私网地址：

```bash
deploy/scripts/install-dsh-bundle.sh \
  --role client \
  --manager-url "http://<UBUNTU_LAN_IP>:8080"
```

安装器不会重启 DSH，也不会加载模型。完成 credential、provider 与 DSH 重启后，仍应看到 `UNLOADED`，再由操作者从 GPU Workload Manager 手工装载。

## 人工命令

```text
/gpu
/gpu status
/gpu load qwen3.8-27b
/gpu switch qwen3.8-27b-q4
/gpu unload
/gpu cancel
```

Web 面板是推荐入口。排队与强停只作用于 manager 登记的本地请求及其自有 `llama.cpp` child，不会取消在线模型请求。

## 开发验证

```bash
pnpm typecheck
pnpm test
deploy/scripts/build-bundle.sh
cd dist/packages
sha256sum -c SHA256SUMS
```

macOS 可用 `shasum -a 256 -c SHA256SUMS`。完整测试包含耗时较长的迁移、故障注入、durability 与回滚场景。

## 安全说明

端口 `8080` 使用 HTTP，只适合受控私有局域网。必须在 Ubuntu 上以防火墙限制可信网段，不要做公网映射。管理与推理使用不同 bearer key；不得把 key 写入 Git、`.env`、命令行、浏览器、日志或截图。

仓库当前未声明开源许可证；如需复用或分发，请先取得权利人许可。
