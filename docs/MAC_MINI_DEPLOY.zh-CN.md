# Mac mini 部署指南

本指南只在已经安装 DSH agent 的 Mac mini 上安装 GPU Workload Manager 的 `client` 角色。Ubuntu 必须已经运行 manager daemon；Mac 不安装 daemon、不运行 `llama.cpp`、不持有 GGUF。

## 需要事先知道

- Ubuntu 的私网 IPv4 地址，以下记作 `<UBUNTU_LAN_IP>`；
- Mac 上 DSH home，默认 `$HOME/.dsh`；
- 两个 credential 的引用名固定为 `GPU_MANAGER_KEY` 与 `LLAMA_CPP_API_KEY`；
- credential 的实际值必须通过已有安全渠道提供，不能要求 Codex 从 Ubuntu 文件、聊天历史或日志中复制显示。

## 自动化工具允许做什么

Mac 上的 Codex 可以：

- 只读检查版本、DSH profile、现有 provider 和进程管理方式；
- 下载公开 release、校验 SHA-256、运行事务化安装器；
- 在保留全部在线 provider 的前提下补充 `llama-local`；
- 按现有 supervisor 方式重启 DSH；
- 运行只读 verifier 和 UI 结构检查。

它不应：

- 自动 load、switch、unload 模型；
- 显示、记录或写入任何 bearer key 到仓库、`.env`、命令行或日志；
- 修改 Ubuntu、防火墙、GGUF、在线 provider 或云端 credential；
- 在未识别现有 DSH 启动方式前粗暴杀进程。

## 安装命令

```bash
git clone https://github.com/Leon-Geldmann/dsh-gpu-workload-manager.git
cd dsh-gpu-workload-manager
git checkout v0.1.0

mkdir -p dist/packages
gh release download v0.1.0 \
  --repo Leon-Geldmann/dsh-gpu-workload-manager \
  --pattern '*.tgz' \
  --pattern SHA256SUMS \
  --dir dist/packages

(cd dist/packages && shasum -a 256 -c SHA256SUMS)

deploy/scripts/install-dsh-bundle.sh \
  --role client \
  --manager-url "http://<UBUNTU_LAN_IP>:8080" \
  --dsh-home "${DSH_HOME:-$HOME/.dsh}"
```

如果没有 GitHub CLI，可从 [v0.1.0 Release](https://github.com/Leon-Geldmann/dsh-gpu-workload-manager/releases/tag/v0.1.0) 手工下载三个 `.tgz` 与 `SHA256SUMS` 到 `dist/packages/`。不要使用未校验的归档。

## 验收命令

```bash
deploy/scripts/verify-live.sh \
  --role mac \
  --manager-url "http://<UBUNTU_LAN_IP>:8080" \
  --dsh-home "${DSH_HOME:-$HOME/.dsh}"
```

验收完成后，manager 仍应是 `UNLOADED`。首次模型装载由用户在 DSH Web 的 GPU Workload Manager 中手动执行。
