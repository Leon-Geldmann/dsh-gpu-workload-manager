# GPU Workload Manager 运维手册

## 1. 部署模型

GPU Workload Manager 是安装到两台机器现有 DeepSeek Harness（DSH）agent 中的同一个 bundle，不是一个独立的第三方 agent：

- Ubuntu 安装 `server` 角色，通过 `http://127.0.0.1:8080` 控制本机 manager daemon。
- Mac mini 安装 `client` 角色，通过 `http://<UBUNTU_LAN_IP>:8080` 控制 Ubuntu 上的同一个 manager daemon。
- 两端都安装相同版本、相同 SHA-256 的三个 DSH 包；角色与 manager URL 只保存在各自 DSH home 的受管 `.env` 区块中。
- browser 不接触管理密钥；DSH host 从本机 credential store 解析 `GPU_MANAGER_KEY`，再代理人工操作。

manager 只接受人工 load、switch、unload 和 cancel。它不注册 model-callable tool，不根据 prompt 自动换模，也不恢复上次驻留模型。Ubuntu 或 daemon 每次启动后都保持 `UNLOADED`，没有 llama-server 子进程占用 GPU。

## 2. 固定端点和角色

| 用途 | Ubuntu | Mac mini |
|---|---|---|
| DSH 角色 | `server` | `client` |
| DSH manager URL | `http://127.0.0.1:8080` | `http://<UBUNTU_LAN_IP>:8080` |
| LAN inference | `http://<UBUNTU_LAN_IP>:8080/v1` | 同左 |
| llama child | `127.0.0.1:18080` | 不可直连 |
| 管理 credential ref | `GPU_MANAGER_KEY` | `GPU_MANAGER_KEY` |
| 推理 credential ref | `LLAMA_CPP_API_KEY` | `LLAMA_CPP_API_KEY` |

端口 8080 只允许 loopback 和实际受信任的私有局域网段；不应把 HTTP 服务通过公网、端口转发或不可信 Wi-Fi 暴露出去。

## 3. 版本与不可变输入

两台机器的发布前置条件：

- Node.js `22.x`；
- pnpm `11.x`；
- DSH 精确为 `0.1.1-rc.2`；
- Mac mini 每次安装都需要 Xcode Command Line Tools；安装器不会信任或复用上次留下的 helper 语义，而是每次从当前安装脚本的固定内嵌源码经系统 `/usr/bin/xcrun`/`clang` 重新构建私有 durability helper，并通过 `sync_volume_np(..., SYNC_VOLUME_FULLSYNC | SYNC_VOLUME_WAIT)` 保证 transaction/journal 的卷级 data+metadata 写序。工具链或 full-sync 能力不可用时安装会失败关闭，不降级为普通 `fsync`；
- 三个 DSH tarball 必须通过同目录 `SHA256SUMS`；
- Ubuntu release ID 必须等于 `SHA256(release.manifest)`，manifest 中每个文件也必须重新散列通过；
- Ubuntu manager 配置、模型目录、systemd unit 和 root-stage verifier 必须来自该 Ubuntu release，不接受相邻工作区里的可变副本。

安装后的内容寻址 release 由 root 持有，目录/可执行文件只给 `agentops` 组读取与执行，普通 payload 只读；它**不会**改成 `agentops` 所有。这是刻意的安全边界：运行 manager 的账号不能改写下一次会执行的 Node、daemon、canary、配置或 unit。

构建命令应在仓库根目录运行，而且 pnpm 进程本身也必须由 Node 22 驱动。可使用 nvm、fnm、mise 或系统包管理器准备满足版本约束的工具链，然后先核对版本：

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
deploy/scripts/build-bundle.sh
deploy/scripts/build-ubuntu-release.sh
```

前两条版本输出必须分别属于 `v22.x` 和 `11.x`；任一不符就停止构建。

输出位置：

- `dist/packages/`：两端共同使用的三个 DSH tarball 与 `SHA256SUMS`；
- `dist/ubuntu-release/`：内容寻址的 Ubuntu release archive、manifest/checksum 信息。每个 release 同时包含 manifest 固定的 `verify/verify-live.sh` 与 `verify/preflight-ubuntu.sh`；后者是 root stage 防火墙证明的唯一脚本来源。

发布物是构建结果；不要在安装前手工编辑、解包后修改或重新打包。

这里没有需要激活的 Python virtualenv。Ubuntu release 自带固定 Node 22 runtime，DSH 的依赖隔离在现有 `web`/`headless` profile 中；llama.cpp 继续使用已散列锁定的 Vulkan binary。当前 binary 的动态依赖均来自系统库，child 只继承 `PATH`、Vulkan/GL loader 和 `XDG_RUNTIME_DIR` 等固定 allowlist 环境变量，不继承 credential 或任意 DSH 环境。

manager 启动 child 时还固定保留现网的 threads、batch/ubatch、fit、context-shift、KV-unified、Jinja、cache RAM、sampling、reasoning 和 offline 参数。model ID、路径、context 与 MTP 只来自四模型只读 catalog；HTTP 不能传入 binary、路径、端口、设备或附加 argv。

## 4. 凭据

推理和管理使用两个不同的 64 位十六进制 bearer key：

- `/etc/qwen38-workload-manager/credentials/inference.key`：OpenAI-compatible inference 调用；
- `/etc/qwen38-workload-manager/credentials/management.key`：`/gpu/v1/*` 管理调用；
- 父目录必须为 `root:root`、`0700`、普通非符号链接目录；
- 两个文件必须为 `root:root`、普通非符号链接且硬链接数恰好为 1、权限 `0600`，并且不能是同一个 inode；
- 两个值都必须是各自不同的 64 位十六进制字符串；允许文件末尾有一个换行；
- key 不得写入 argv、`.env`、Git、浏览器 JavaScript、日志或验收截图。

在 Ubuntu 和 Mac mini 的 DSH Web 凭据设置页分别保存两个 credential：`GPU_MANAGER_KEY` 的值与 Ubuntu `management.key` 相同，`LLAMA_CPP_API_KEY` 的值与 Ubuntu `inference.key` 相同。两个引用和值不得交叉复用。DSH bundle 的 `.env` 只保存角色和 manager URL，不保存 key。

## 5. 配置两端本地推理 provider

bundle 刻意不改写现有 `llm-pi-ai` provider 设置，以免覆盖任何在线 provider。两端都必须在 DSH 的 Models 设置中保留或创建 provider ID `llama-local`，核心配置如下：

```yaml
llm-pi-ai:
  providers:
    llama-local:
      displayName: Local Qwen3.8 llama.cpp
      apiKeyEnv: LLAMA_CPP_API_KEY
      api: openai-completions
      baseURL: <role-specific-base-url>
      models:
        - id: qwen3.8-27b
        - id: qwen3.8-27b-uncensored
        - id: qwen3.8-27b-q4
        - id: qwen3.8-27b-uncensored-q4
```

Ubuntu 的 `<role-specific-base-url>` 必须是 `http://127.0.0.1:8080/v1`；Mac mini 必须是 `http://<UBUNTU_LAN_IP>:8080/v1`。可以保留现有的模型显示名、context/maxTokens、reasoning 和 timeout 字段，但 provider ID、四个 model ID、协议、baseURL 与 credential ref 必须精确匹配。每台机器都要在其 DSH host 内实际发起一次 authenticated `llama-local` prompt；只用 `curl /health` 不能证明 provider 或 inference credential 正确。

## 6. 安装同一个 DSH bundle

先把完整的 `dist/packages/` 和同一提交的 `deploy/scripts/install-dsh-bundle.sh` 安全复制到目标机，并保留仓库中的相对目录布局；安装器会从自己所在仓库的 `dist/packages/` 读取包。随后在目标机验证。Ubuntu 使用：

```bash
cd dist/packages
sha256sum -c SHA256SUMS
```

Mac mini 使用系统自带的 `shasum`：

```bash
cd dist/packages
shasum -a 256 -c SHA256SUMS
```

Ubuntu 的现有 DSH agent 安装 server 角色：

```bash
deploy/scripts/install-dsh-bundle.sh --role server
```

Mac mini 的现有 DSH agent 安装 client 角色：

```bash
deploy/scripts/install-dsh-bundle.sh \
  --role client \
  --manager-url "http://<UBUNTU_LAN_IP>:8080"
```

安装器先把验证过的三个 tarball 原子写入 `$DSH_HOME/.gpu-workload-manager/packages/` 的内容寻址缓存，再让 `web` 和 `headless` 两个 profile 固定引用该缓存；因此最初传输目录之后可以移动或删除。profile manifest、lockfile、`.env` 和三处 `node_modules` 由 `$DSH_HOME/.gpu-workload-manager/transaction/` 的持久 journal 保护：进程被 `SIGKILL` 或主机重启后，重复执行同一命令会先恢复未完成事务，再重新安装。失败会精确恢复这些 DSH 目标状态；已经校验且内容寻址的 tarball cache 可以保留，这不是 profile residue。

安装成功只会在目标状态落盘、journal 持久标记为 committed 并安全 retire 后输出。新版安装器以独立进程组覆盖自身及所有 DSH 子进程，并用 regular-file hard-link 锁和不可复用 tombstone：进程组 leader 被 `SIGKILL` 后，重试会先终止并证明旧组内没有非 zombie 成员，再回收 v2 锁。活锁仍拒绝并发安装。旧版 v1 目录锁没有进程组证据；无论其 owner 已死亡、记录不完整还是目录为空，都保守拒绝并要求人工确认及清理，不会自动移动或删除。安装器不会重启 DSH 或 Ubuntu 服务，安装后仍由操作者在维护窗口重启两端 DSH agent。

## 7. Ubuntu 迁移原则

Ubuntu 切换是一个显式维护窗口操作。执行顺序固定为：

1. 只读 preflight 验证 release、credential、canary 端口、旧 router 身份、唯一 8080 listener、维护窗口标记和 UFW 的有效入站链。
2. 在 root-only 事务 staging 中复制并重新验证 release，避免检查与使用之间被替换。
3. 以受限 `agentops` transient unit 运行不接触 GPU 的 fake canary；随后运行 artifact-only gate，对 binary 与四个 GGUF 做 strict owner/ancestor/mode/size/SHA-256 校验。artifact-only 不加载 credential、不开放端口、不允许 GPU device，也不启动 child。
4. 记录旧服务的精确身份与启用状态并写入 root-only snapshot；再次验证所有证据后，才停止/禁用旧 router，并证明其 cgroup、进程、8080 listener 和 GPU child 已退出。
5. 旧模型完全退出后，以非生产端口运行受限的真实 Base Q5 canary。这样不会让单张 7900 XTX 同时驻留旧模型和 canary 模型。
6. 安装内容寻址 release、精确配置和 systemd unit，启动 manager，并验证唯一进程/端口、无 18080 child、readiness 与 authenticated `UNLOADED` 状态。
7. 任一步失败都在同一互斥锁内回滚。恢复旧 router 时最多等待 30 分钟让 20+ GiB 模型重新装载，并验证原 UnitFileState、PID/exe/cgroup、唯一 8080 listener、`/health` 和受保护的 `/props`；恢复通过后才删除新 release。回滚失败必须明确退出，不能宣称成功。

把内容寻址目录作为输入；`<release-id>` 是该目录名，也是 `release.manifest` 的 SHA-256。完整 preflight 本身就要求维护标记存在，所以首次 preflight **之前**，由 `agentops` 在 `/home/agentops/.config/ai-stack/qwen38-maintenance-window` 写入恰好一行 `qwen38-maintenance-window-v1`：文件必须为普通单链接文件、`agentops:agentops`、`0600`，并且在 15 分钟内创建或更新。

随后运行 standalone preflight 和 installer dry-run：

```bash
sudo deploy/scripts/preflight-ubuntu.sh \
  --release-dir /absolute/path/to/dist/ubuntu-release/<release-id> \
  --release-id <release-id>

sudo deploy/scripts/install-ubuntu.sh \
  --release-dir /absolute/path/to/dist/ubuntu-release/<release-id> \
  --release-id <release-id>
```

上面第二条是 installer dry-run，不改变服务。dry-run 完成后、apply 紧前由 `agentops` **再次刷新同一个维护标记**，再运行：

```bash
sudo deploy/scripts/install-ubuntu.sh \
  --release-dir /absolute/path/to/dist/ubuntu-release/<release-id> \
  --release-id <release-id> \
  --apply
```

前置的四个 GGUF hash 可能超过 15 分钟；如果 installer 在停旧服务前报告维护标记过期，刷新标记后重新执行 apply 即可，此时旧 router 仍未改变。

成功输出会给出 root-only snapshot 的绝对路径。需要人工回退时，先 dry-run，再 apply：

```bash
sudo deploy/scripts/rollback-ubuntu.sh --snapshot /var/lib/qwen38-workload-manager-migrations/transaction-<timestamp>-<pid>.snapshot
sudo deploy/scripts/rollback-ubuntu.sh --snapshot /var/lib/qwen38-workload-manager-migrations/transaction-<timestamp>-<pid>.snapshot --apply
```

以三个脚本的 `--help` 为最终参数契约。不要绕过 preflight、维护标记、canary、内容 hash、迁移锁或 UFW gate。

## 8. 人工使用

DSH Web 中可以点击 composer 右下角的 `GPU` 按钮，或输入 `/gpu` 打开管理面板。支持的人工命令语义为：

```text
/gpu
/gpu status
/gpu load qwen3.8-27b
/gpu switch qwen3.8-27b-q4
/gpu unload
/gpu cancel
```

Web 面板是推荐入口。直接 host command adapter 还支持 busy 后的 `--queue` 和 `--force`；stock `headless` profile 是 agent prompt runner，不应把 `dsh --profile headless '/gpu ...'` 当作人工管理入口。

状态和选择规则：

- `UNLOADED`：四个本地模型全部置灰；在线模型照常可选。
- `READY`：只有当前驻留的本地模型可选；其他本地模型置灰。
- 本地禁用项固定提示“请通过 GPU Workload Manager 切换”，pointer、Enter、Space 和方向键都不能绕过。
- `STARTING`、`WARMING`、`DRAINING`、`FORCING`、`STOPPING` 等过渡状态下，所有本地模型禁用。
- provider 不是 `llama-local` 时完全不套用上述策略；即便在线模型复用了同一个 model ID，也不受影响。

若本地请求仍在运行，首次操作返回 busy 弹窗：

- “排队”是高亮主按钮和默认焦点；等待已有本地请求（包括尚未上传完 JSON 的认证请求）自然结束，并拒绝新的本地请求后再切换。
- “强行停止并切换”是红色危险按钮，永远不是默认焦点；只终止 manager 登记的本地请求及其自有 llama child。
- “取消”、Esc 和点击遮罩不会改变当前模型。
- 云端请求不经过本地 gateway，因此排队和强停都不影响在线模型。

## 9. 指标与诊断

`/metrics` 同时要求来源属于可信 peer（loopback 或配置的受信任私网段）并携带 management bearer；loopback 也不能匿名访问。指标只使用固定 model catalog、固定 phase 和 histogram `le` 等低基数标签，绝不记录 prompt、response、IP、credential、任意 URL 或未知 model ID。

关键观测项包括：

- `manager_child_load_to_health_seconds`：child 从 spawn 到 health 通过；
- `manager_child_warmup_seconds`：health 通过到 props 检查与固定 warmup 请求完整结束；
- `manager_inference_ttft_seconds`：从认证请求取得 provisional admission 起，到 `text/event-stream` 中首个非空文本、推理或工具调用 delta 完整到达；role/lifecycle 元数据、`[DONE]` 和非流式 JSON 不产生 TTFT 样本；
- 推理总时长、排队等待时间；
- force 取消计数和 child crash 计数；
- manager phase、gateway/engine 活跃请求数。当前驻留模型从 authenticated `/gpu/v1/status` 读取，不是一个 metrics gauge。

只有真实部署并对每个模型完成人工 load/warmup/请求采样后，才可以报告 TTFT p50/p95。fake canary 或单元测试不能作为硬件性能数字。

## 10. 只读验收

若只需在重启 DSH 前检查 bundle 安装状态，可使用 `--dsh-only`。该 gate 必须由 DSH home 的实际 owner 执行；它会把 Ubuntu/Mac 分别映射为 `server`/`client`，规范化 DSH home 与 manager origin，核对受管 `.env`、内容寻址 tarball SHA、两个 profile 的依赖与 bundle list、已安装包身份，并通过 `dsh --profile ... --dump-config` 验证 manager 和 Web selector 的实际 composition；它不会检查 Ubuntu service、网络或模型文件。

Ubuntu 必须分成两个身份隔离的阶段。先在 DSH owner 的登录 shell 中捕获并记录 canonical DSH home，再完成 owner stage：

```bash
verifier=$(cd deploy/scripts && pwd -P)/verify-live.sh
dsh_home=$(cd "${DSH_HOME:-$HOME/.dsh}" && pwd -P)
printf 'DSH_HOME=%s\n' "$dsh_home"
"$verifier" --role ubuntu --dsh-home "$dsh_home" --dsh-only
```

然后从安装记录填写受信的 64 位 release manifest SHA。root stage 必须用已经由 installer 复制到内容寻址 release、归 `root:agentops` 所有且经该 release manifest 固定的 verifier；不接收 DSH home，也不会查找或执行用户的 `node`、`pnpm`、`dsh` 或 plugin。**不得用 `sudo` 执行仓库或 DSH owner 可写目录中的 verifier 副本**：

```bash
release_id='<trusted-release-manifest-sha256>'
release_dir="/opt/qwen38-workload-manager/releases/$release_id"
root_verifier="$release_dir/verify/verify-live.sh"
sudo /usr/bin/env -i \
  PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/root \
  LC_ALL=C \
  /bin/bash "$root_verifier" \
    --role ubuntu \
    --system-only \
    --release-dir "$release_dir" \
    --release-id "$release_id"
```

只有 owner stage 的 `LIVE VERIFICATION: PASS ... scope=dsh-only` 与 root stage 的 `LIVE VERIFICATION: PASS ... scope=system-only` 同时存在，才构成一次完整的 Ubuntu verifier 结果；单独的 system-only PASS 不代表 DSH bundle 已验收。`--fixture-root` 只供仓库隔离测试，输出标为 `scope=fixture/system-only`，不得作为生产验收记录。

Mac mini 仍由 DSH owner 一次完成 DSH 与 LAN health gate：

```bash
verifier=$(cd deploy/scripts && pwd -P)/verify-live.sh
dsh_home=$(cd "${DSH_HOME:-$HOME/.dsh}" && pwd -P)
"$verifier" \
  --role mac \
  --dsh-home "$dsh_home" \
  --manager-url "http://<UBUNTU_LAN_IP>:8080"
```

verifier 不写文件、不改服务、不切模型、不改防火墙。Ubuntu 的 system-only stage 最早即要求 root，清理调用者 PATH/loader/runtime 注入环境，只从受信 release manifest 启动其已散列验证的内嵌 Node 22；credential、UFW、精确运行进程身份、service cgroup、authenticated restart-empty、18080 空闲和模型 artifact 任一无法证明时均按失败处理，而不是跳过。

`LIVE VERIFICATION: PASS` 是必要条件，不是充分条件：Mac gate 只证明 LAN `/health` 可达；Ubuntu system-only verifier 会调用同一 release manifest 固定的 `verify/preflight-ubuntu.sh --firewall-only`，证明实际 filter table 的 default-deny 与可达链；installer 的完整 preflight 仍必须在停旧服务前成功。宣布上线还必须保留成功的 installer/preflight 记录，在两端核对上述 `llama-local` provider 与两个 credential ref，各自完成 authenticated DSH prompt，并完成手工选择器、busy 弹窗、重启保持无模型和真实 TTFT 验收。

## 11. 故障处置

- manager 启动失败：保持旧服务或执行显式 rollback；不要让两个服务争用 8080。
- manager 为 `FAILED` 或 `DEGRADED_UNLOADED`：先查看固定阶段指标与 systemd 日志，确认没有 18080 listener，再人工重试 load。
- switch 失败：manager 只会尝试一次回滚到原模型；回滚失败保持无模型，不自动加载其他模型。
- DSH 插件失败：重新运行同一发布物的安装器；安装器会验证/修复三个包在两个 profile 中的精确状态。
- restart 后没有模型：这是预期安全状态，不是故障；必须从 GPU Workload Manager 手工装载。
