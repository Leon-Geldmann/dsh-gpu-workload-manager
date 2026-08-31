#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source "$test_dir/testlib.sh"
repo_root=$(cd "$test_dir/../.." && pwd -P)
TEST_REAL_NODE=${TEST_REAL_NODE:-$(command -v node)}
export TEST_REAL_NODE

test_mac_requires_explicit_manager_url() {
  local output status
  set +e
  output=$("$repo_root/deploy/scripts/verify-live.sh" --role mac --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -eq 2 ]] || fail 'Mac verification without --manager-url must fail as invalid invocation'
  assert_contains "$output" 'missing_manager_url' 'failure must identify the missing Mac manager origin'
}

make_minimal_verify_release() {
  local sandbox=$1 label=$2 release_root staging release_id
  release_root="$sandbox/system-root/opt/qwen38-workload-manager/releases"
  staging="$release_root/staging-$label"
  mkdir -p "$staging/dist" "$staging/node-v22/bin" "$staging/canary" "$staging/config" "$staging/systemd" "$staging/verify"
  cp -L "$TEST_REAL_NODE" "$staging/node-v22/bin/node"
  printf '%s\n' '{"type":"module"}' > "$staging/dist/package.json"
  printf '%s\n' 'export {};' > "$staging/dist/canary.js"
  printf '%s\n' '#!/bin/sh' 'exit 0' > "$staging/canary/fake-canary"
  cp "$staging/canary/fake-canary" "$staging/canary/real-canary"
  cat > "$staging/dist/managerd.js" <<'NODE'
import { createServer } from 'node:http';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const server = createServer((request, response) => {
  if (process.env.VERIFY_PROBE_FILE) appendFileSync(process.env.VERIFY_PROBE_FILE, `${request.url}\n`);
  if (request.url === '/gpu/v1/status' && request.headers.authorization === `Bearer ${'a'.repeat(64)}`) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      phase: process.env.VERIFY_LATE_STATE_FILE && existsSync(process.env.VERIFY_LATE_STATE_FILE) ? 'LOADING' : 'UNLOADED',
      activeRequestCount: 0,
    }));
  } else if (request.url === '/v1/models' && request.headers.authorization === `Bearer ${'b'.repeat(64)}`) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [] }));
  } else {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'unauthorized' } }));
  }
});
server.listen(Number(process.env.VERIFY_MANAGER_PORT ?? '8080'), '127.0.0.1', () => {
  if (process.env.VERIFY_READY_FILE) writeFileSync(process.env.VERIFY_READY_FILE, 'ready\n');
});
NODE
  printf '// %s\n' "$label" >> "$staging/dist/managerd.js"
  cp "$sandbox/system-root/etc/qwen38-workload-manager/manager.production.json" "$staging/config/manager.production.json"
  cp "$sandbox/system-root/etc/qwen38-workload-manager/models.production.json" "$staging/config/models.production.json"
  cp "$sandbox/system-root/etc/systemd/system/qwen38-workload-manager.service" "$staging/systemd/qwen38-workload-manager.service"
  cp "$repo_root/deploy/scripts/verify-live.sh" "$staging/verify/verify-live.sh"
  cp "$repo_root/deploy/scripts/preflight-ubuntu.sh" "$staging/verify/preflight-ubuntu.sh"
  (
    cd "$staging"
    find . -type f ! -name release.manifest -printf '%P\n' \
      | LC_ALL=C sort \
      | while IFS= read -r relative; do sha256sum "$relative"; done \
      > release.manifest
  )
  find -P "$staging" -type d -exec chmod 0550 -- {} +
  find -P "$staging" -type f -exec chmod 0440 -- {} +
  chmod 0550 -- "$staging/node-v22/bin/node" "$staging/canary/fake-canary" "$staging/canary/real-canary" "$staging/verify/preflight-ubuntu.sh"
  release_id=$(sha256sum "$staging/release.manifest" | awk '{print $1}')
  mv "$staging" "$release_root/$release_id"
  printf '%s\n' "$release_root/$release_id"
}

set_fixture_current_release() {
  local sandbox=$1 release=$2 current_link
  current_link="$sandbox/system-root/opt/qwen38-workload-manager/current"
  [[ ! -e "$current_link" && ! -L "$current_link" ]] || unlink "$current_link"
  ln -s "$release" "$current_link"
}

setup_system_verify_fixture() {
  local sandbox=$1 binary_hash model_hash index manager_port
  mkdir -p \
    "$sandbox/repo/deploy/scripts" "$sandbox/repo/fake-bin" "$sandbox/dsh-home" \
    "$sandbox/system-root/usr/bin" "$sandbox/system-root/usr/sbin" \
    "$sandbox/system-root/etc/qwen38-workload-manager/credentials" \
    "$sandbox/system-root/etc/systemd/system" \
    "$sandbox/system-root/opt/qwen38-workload-manager/releases" \
    "$sandbox/system-root/opt/qwen38-workload-manager/artifacts" \
    "$sandbox/state"
  chmod 700 "$sandbox/system-root"
  printf 'gpu-workload-manager verify-live fixture v1\n' > "$sandbox/system-root/.verify-live-fixture-v1"
  chmod 400 "$sandbox/system-root/.verify-live-fixture-v1"
  printf 'qwen38-workload-manager-fixture-v1\n' > "$sandbox/system-root/.qwen38-workload-manager-fixture-v1"
  chmod 600 "$sandbox/system-root/.qwen38-workload-manager-fixture-v1"
  manager_port=$("$TEST_REAL_NODE" - <<'NODE'
const { createServer } = require('node:net');
const server = createServer();
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
  server.close();
});
NODE
  )
  printf 'http://127.0.0.1:%s\n' "$manager_port" > "$sandbox/system-root/.verify-live-manager-origin-v1"
  chmod 400 "$sandbox/system-root/.verify-live-manager-origin-v1"
  cp "$repo_root/deploy/scripts/verify-live.sh" "$sandbox/repo/deploy/scripts/verify-live.sh"
  chmod +x "$sandbox/repo/deploy/scripts/verify-live.sh"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    ': > "$(dirname "$0")/../user-tool-called"' \
    'if [[ "${1:-}" == --version ]]; then printf "v22.0.0\n"; fi' \
    'exit 0' \
    > "$sandbox/repo/fake-bin/node"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    ': > "$(dirname "$0")/../user-tool-called"' \
    'if [[ "${1:-}" == --version ]]; then printf "11.0.0\n"; fi' \
    'exit 0' \
    > "$sandbox/repo/fake-bin/pnpm"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    ': > "$(dirname "$0")/../user-tool-called"' \
    'if [[ "${1:-}" == --version ]]; then printf "0.1.1-rc.2\n"; fi' \
    'exit 0' \
    > "$sandbox/repo/fake-bin/dsh"
  cat > "$sandbox/system-root/usr/bin/id" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}:\${2:-}:\$(<"$sandbox/state/id-mode")" in
  -u::*) printf '%s\n' '$(id -u)' ;;
  -g::*) printf '%s\n' '$(id -g)' ;;
  -un::*) printf '%s\n' '$(id -un)' ;;
  -gn::*) printf '%s\n' '$(id -gn)' ;;
  -u:agentops:good) printf '%s\n' '$(id -u)' ;;
  -g:agentops:good) printf '%s\n' '$(id -g)' ;;
  -u:agentops:wrong-uid) printf '%s\n' '$(( $(id -u) + 1 ))' ;;
  -g:agentops:wrong-uid) printf '%s\n' '$(id -g)' ;;
  *) exit 64 ;;
esac
EOF
  printf 'fixture binary\n' > "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/llama-server"
  binary_hash=$(sha256sum "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/llama-server" | awk '{print $1}')
  for index in 1 2 3 4; do
    printf 'fixture model %s\n' "$index" > "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/model-$index.gguf"
  done
  "$TEST_REAL_NODE" - "$sandbox/system-root/etc/qwen38-workload-manager/models.production.json" \
    "$sandbox/system-root/opt/qwen38-workload-manager/artifacts" "$binary_hash" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [destination, artifactRoot, binaryHash] = process.argv.slice(2);
const descriptor = file => ({
  path: file,
  bytes: fs.statSync(file).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
});
fs.writeFileSync(destination, `${JSON.stringify({
  binary: { ...descriptor(path.join(artifactRoot, 'llama-server')), sha256: binaryHash },
  models: [1, 2, 3, 4].map(index => descriptor(path.join(artifactRoot, `model-${index}.gguf`))),
}, null, 2)}\n`);
NODE
  printf '{"fixture":true}\n' > "$sandbox/system-root/etc/qwen38-workload-manager/manager.production.json"
  printf '[Service]\nExecStart=fixture\n' > "$sandbox/system-root/etc/systemd/system/qwen38-workload-manager.service"
  printf '%s\n' "$(printf 'a%.0s' {1..64})" > "$sandbox/system-root/etc/qwen38-workload-manager/credentials/management.key"
  printf '%s\n' "$(printf 'b%.0s' {1..64})" > "$sandbox/system-root/etc/qwen38-workload-manager/credentials/inference.key"
  chmod 700 "$sandbox/system-root/etc/qwen38-workload-manager/credentials"
  chmod 600 "$sandbox/system-root/etc/qwen38-workload-manager/credentials/"*.key
  chmod 0550 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts"
  chmod 0550 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/llama-server"
  chmod 0440 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/"*.gguf

  cat > "$sandbox/system-root/usr/bin/systemctl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
state='$sandbox/state'
case "\${1:-}" in
  is-active) exit 0 ;;
  show)
    pid=\$(<"\$state/main-pid")
    if [[ \$(<"\$state/unit-mode") == replace-after-probe && -s "\$state/manager-probes" \
      || \$(<"\$state/unit-mode") == replace-after-late-gate && -e "\$state/late-replaced" ]]; then
      pid=999999
    fi
    control_group=\$(awk -F: 'NR == 1 { print \$3 }' "/proc/\$pid/cgroup")
    if [[ " \$* " == *' --value '* ]]; then
      printf '%s\n' "\$pid"
    else
      need_reload=no
      unit_file=enabled
      user=\$(id -un)
      group=\$(id -gn)
      case \$(<"\$state/unit-mode") in
        good|replace-after-probe|replace-after-late-gate) ;;
        reload) need_reload=yes ;;
        disabled) unit_file=disabled ;;
        weak) user=root; group=root ;;
        *) exit 65 ;;
      esac
      printf '%s\n' \
        'LoadState=loaded' \
        "UnitFileState=\$unit_file" \
        'ActiveState=active' \
        'SubState=running' \
        "NeedDaemonReload=\$need_reload" \
        'FragmentPath=$sandbox/system-root/etc/systemd/system/qwen38-workload-manager.service' \
        'DropInPaths=' \
        "User=\$user" \
        "Group=\$group" \
        "MainPID=\$pid" \
        "ControlGroup=\$control_group"
    fi
    ;;
  *) exit 64 ;;
esac
EOF
  cat > "$sandbox/system-root/usr/bin/ss" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ " \$* " == *' :8080 '* ]]; then
  pid=\$(<"$sandbox/state/main-pid")
  case \$(<"$sandbox/state/manager-ss-mode") in
    good) ;;
    old) pid=\$((pid + 1)) ;;
    duplicate)
      printf 'LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=%s,fd=20))\n' "\$pid"
      ;;
    fail) exit 42 ;;
    *) exit 64 ;;
  esac
  printf 'LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=%s,fd=20))\n' "\$pid"
else
  case \$(<"$sandbox/state/ss-mode") in
    empty) exit 0 ;;
    listener) printf 'LISTEN 0 1 127.0.0.1:18080 0.0.0.0:* users:(("llama",pid=9,fd=3))\n' ;;
    fail) exit 42 ;;
    *) exit 64 ;;
  esac
fi
EOF
  cat > "$sandbox/system-root/usr/sbin/ufw" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[[ "\$*" == 'status verbose' ]] || exit 63
case \$(<"$sandbox/state/ufw-mode") in
  good) printf 'Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n8080/tcp                  ALLOW IN    192.168.3.0/24\n' ;;
  interface) printf 'Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n8080/tcp on enp5s0        ALLOW IN    192.168.3.0/24\n' ;;
  range-anywhere) printf 'Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n8080/tcp                  ALLOW IN    192.168.3.0/24\n8000:9000/tcp             ALLOW IN    Anywhere\n' ;;
  default-allow) printf 'Status: active\nDefault: allow (incoming), allow (outgoing), disabled (routed)\n8080/tcp                  ALLOW IN    192.168.3.0/24\n' ;;
  mark-loaded)
    : > "$sandbox/state/late-loaded"
    printf 'Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n8080/tcp                  ALLOW IN    192.168.3.0/24\n'
    ;;
  mark-replaced)
    : > "$sandbox/state/late-replaced"
    printf 'Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n8080/tcp                  ALLOW IN    192.168.3.0/24\n'
    ;;
  unrelated-cidr) printf 'Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n22/tcp                    ALLOW IN    192.168.3.0/24\n8080/tcp                  DENY IN     Anywhere\n' ;;
  *) exit 64 ;;
esac
EOF
  cat > "$sandbox/system-root/usr/sbin/iptables-save" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[[ "\$*" == '-t filter' ]] || exit 63
state='$sandbox/state'
mode=\$(<"\$state/iptables-mode")
if [[ "\${0##*/}" == ip6tables-save ]]; then
  if [[ "\$mode" == partial-ip6 ]]; then printf '%s\\n' '# Generated by ip6tables-save v1.8.10 (nf_tables)' '*filter'; exit 42; fi
  printf '%s\\n' \\
    '# Generated by ip6tables-save v1.8.10 (nf_tables)' \\
    '*filter' \\
    ':INPUT DROP [11:704]' \\
    ':FORWARD DROP [0:0]' \\
    ':OUTPUT ACCEPT [19:2001]' \\
    ':ufw6-before-input - [8:640]' \\
    ':ufw6-user-input - [0:0]' \\
    '-A INPUT -j ufw6-before-input' \\
    '-A INPUT -j ufw6-user-input' \\
    '-A ufw6-before-input -i lo -j ACCEPT' \\
    '-A ufw6-before-input -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT' \\
    '-A ufw6-before-input -m rt --rt-type 0 -j DROP' \\
    '-A ufw6-before-input -p ipv6-icmp -m ipv6-icmp --icmpv6-type 133 -m hl --hl-eq 255 -j ACCEPT' \\
    '-A ufw6-before-input -p ipv6-icmp -m ipv6-icmp --icmpv6-type 134 -m hl --hl-eq 255 -j ACCEPT' \\
    '-A ufw6-before-input -p ipv6-icmp -m ipv6-icmp --icmpv6-type 130 -m hl --hl-eq 1 -j ACCEPT'
  if [[ "\$mode" == ipv6-accept ]]; then printf '%s\\n' '-A ufw6-user-input -p tcp -m tcp --dport 8080 -j ACCEPT'; fi
  printf '%s\\n' 'COMMIT' '# Completed by ip6tables-save v1.8.10 (nf_tables)'
  exit 0
fi
if [[ "\$mode" == partial-ipv4 ]]; then printf '%s\\n' '# Generated by iptables-save v1.8.10 (nf_tables)' '*filter'; exit 42; fi
printf '%s\\n' \\
  '# Generated by iptables-save v1.8.10 (nf_tables)' \\
  '*filter' \\
  ':INPUT DROP [23:1840]' \\
  ':FORWARD DROP [0:0]' \\
  ':OUTPUT ACCEPT [31:4096]' \\
  ':ufw-before-logging-input - [0:0]' \\
  ':ufw-before-input - [18:1450]' \\
  ':ufw-not-local - [2:160]' \\
  ':ufw-user-input - [1:64]' \\
  ':ufw-after-input - [0:0]' \\
  ':ufw-reject-input - [0:0]' \\
  ':ufw-track-input - [0:0]'
if [[ "\$mode" == preceding-drop ]]; then printf '%s\\n' '-A INPUT -p tcp --dport 8080 -j DROP'; fi
printf '%s\\n' \\
  '-A INPUT -j ufw-before-logging-input' \\
  '-A INPUT -j ufw-before-input' \\
  '-A INPUT -j ufw-user-input' \\
  '-A INPUT -j ufw-after-input' \\
  '-A INPUT -j ufw-reject-input' \\
  '-A INPUT -j ufw-track-input' \\
  '-A ufw-before-logging-input -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW BLOCK] "' \\
  '-A ufw-before-input -i lo -j ACCEPT' \\
  '-A ufw-before-input -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT' \\
  '-A ufw-before-input -m conntrack --ctstate INVALID -j DROP' \\
  '-A ufw-before-input -j ufw-not-local' \\
  '-A ufw-not-local -m addrtype --dst-type LOCAL -j RETURN' \\
  '-A ufw-not-local -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW BLOCK] "' \\
  '-A ufw-not-local -j DROP'
if [[ "\$(<"\$state/ufw-mode")" == interface ]]; then
  printf '%s\\n' '-A ufw-user-input -p tcp -m tcp -s 192.168.3.0/24 -i enp5s0 --dport 8080 -j ACCEPT'
else
  printf '%s\\n' '-A ufw-user-input -p tcp -m tcp -s 192.168.3.0/24 --dport 8080 -j ACCEPT'
fi
if [[ "\$mode" == broad-accept ]]; then printf '%s\\n' '-A ufw-user-input -p tcp -m tcp --dport 8080 -j ACCEPT'; fi
printf '%s\\n' 'COMMIT' '# Completed by iptables-save v1.8.10 (nf_tables)'
EOF
  ln -s iptables-save "$sandbox/system-root/usr/sbin/ip6tables-save"
  chmod +x "$sandbox/repo/fake-bin/"*
  chmod 755 "$sandbox/system-root/usr/bin/"* "$sandbox/system-root/usr/sbin/"*
  chmod -R go-w "$sandbox/system-root"
  printf 'empty\n' > "$sandbox/state/ss-mode"
  printf 'good\n' > "$sandbox/state/manager-ss-mode"
  printf 'good\n' > "$sandbox/state/ufw-mode"
  printf 'good\n' > "$sandbox/state/iptables-mode"
  printf 'good\n' > "$sandbox/state/unit-mode"
  printf 'good\n' > "$sandbox/state/id-mode"
}

run_system_verifier() {
  local sandbox=$1 release=$2
  PATH="$sandbox/repo/fake-bin:$PATH" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" \
      --role ubuntu --system-only \
      --fixture-root "$sandbox/system-root" \
      --release-dir "$release" --release-id "$(basename "$release")"
}

start_verify_manager() {
  local sandbox=$1 release=$2 attempt manager_port
  manager_port=$(sed 's#^http://127\.0\.0\.1:##' "$sandbox/system-root/.verify-live-manager-origin-v1")
  rm -f "$sandbox/state/manager-ready" "$sandbox/state/manager-probes" \
    "$sandbox/state/late-loaded" "$sandbox/state/late-replaced"
  (
    cd "$release"
    VERIFY_READY_FILE="$sandbox/state/manager-ready" VERIFY_PROBE_FILE="$sandbox/state/manager-probes" \
      VERIFY_LATE_STATE_FILE="$sandbox/state/late-loaded" \
      VERIFY_MANAGER_PORT="$manager_port" \
      exec "$release/node-v22/bin/node" "$release/dist/managerd.js" \
        --manager-config "$sandbox/system-root/etc/qwen38-workload-manager/manager.production.json" \
        --models-config "$sandbox/system-root/etc/qwen38-workload-manager/models.production.json"
  ) &
  VERIFY_MANAGER_PID=$!
  for attempt in $(seq 1 200); do
    [[ -f "$sandbox/state/manager-ready" ]] && return 0
    kill -0 "$VERIFY_MANAGER_PID" 2>/dev/null || fail 'fixture manager exited before becoming ready'
    sleep 0.01
  done
  fail 'fixture manager did not become ready'
}

test_ubuntu_requires_explicit_owner_and_system_stages() {
  local sandbox output status
  sandbox=$(mktemp -d /tmp/gwm-verify-stage-split.XXXXXX)
  trap 'chmod -R u+rwX "$sandbox" 2>/dev/null || true; cleanup_tree "$sandbox"' RETURN
  setup_system_verify_fixture "$sandbox"

  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" \
      --role ubuntu --dsh-home "$sandbox/dsh-home" 2>&1)
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail 'Ubuntu verification without an explicit stage must fail'
  assert_contains "$output" 'ubuntu_requires_dsh_only_or_system_only' 'unsafe combined Ubuntu verification must explain the required split'
  assert_no_file "$sandbox/repo/user-tool-called"
}

test_system_stage_binds_running_release_and_distinguishes_ss_failure() {
  local sandbox current old output status
  sandbox=$(mktemp -d /tmp/gwm-verify-system-gates.XXXXXX)
  trap '[[ -z "${VERIFY_MANAGER_PID:-}" ]] || kill "$VERIFY_MANAGER_PID" 2>/dev/null || true; chmod -R u+rwX "$sandbox" 2>/dev/null || true; cleanup_tree "$sandbox"' RETURN
  setup_system_verify_fixture "$sandbox"
  current=$(make_minimal_verify_release "$sandbox" current)
  old=$(make_minimal_verify_release "$sandbox" old)
  set_fixture_current_release "$sandbox" "$current"
  cp "$current/config/manager.production.json" "$sandbox/system-root/etc/qwen38-workload-manager/manager.production.json"
  cp "$current/config/models.production.json" "$sandbox/system-root/etc/qwen38-workload-manager/models.production.json"
  cp "$current/systemd/qwen38-workload-manager.service" "$sandbox/system-root/etc/systemd/system/qwen38-workload-manager.service"

  start_verify_manager "$sandbox" "$old"
  printf '%s\n' "$VERIFY_MANAGER_PID" > "$sandbox/state/main-pid"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'system-only fixture intentionally lacks privileged production state'
  assert_contains "$output" 'FAIL  ubuntu_manager_process_identity' 'a process from an old release must not satisfy current-release identity'
  assert_no_file "$sandbox/repo/user-tool-called"
  kill "$VERIFY_MANAGER_PID"
  wait "$VERIFY_MANAGER_PID" 2>/dev/null || true
  VERIFY_MANAGER_PID=''

  start_verify_manager "$sandbox" "$current"
  printf '%s\n' "$VERIFY_MANAGER_PID" > "$sandbox/state/main-pid"
  printf 'fail\n' > "$sandbox/state/ss-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an ss probe failure must fail the system-only fixture'
  assert_contains "$output" 'PASS  ubuntu_manager_process_identity' 'the verified release process must satisfy exe/cwd/argv/cgroup identity'
  assert_contains "$output" 'FAIL  ubuntu_no_resident_child' 'an ss execution error must fail instead of proving an empty port'
  assert_no_file "$sandbox/repo/user-tool-called"

  printf 'empty\n' > "$sandbox/state/ss-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -eq 0 ]] || { printf 'system fixture output:\n%s\n' "$output" >&2; fail 'the complete fixture system stage must pass'; }
  assert_contains "$output" 'PASS  ubuntu_manager_process_identity'
  assert_contains "$output" 'PASS  ubuntu_loaded_unit_identity'
  assert_contains "$output" 'PASS  ubuntu_no_resident_child' 'a successful empty ss result must prove that port 18080 has no listener'
  assert_contains "$output" 'LIVE VERIFICATION: PASS role=ubuntu scope=fixture/system-only'
  assert_no_file "$sandbox/repo/user-tool-called"

  printf 'reload\n' > "$sandbox/state/unit-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a loaded unit that still needs daemon-reload must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_loaded_unit_identity'

  printf 'disabled\n' > "$sandbox/state/unit-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an active but disabled loaded unit must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_loaded_unit_identity'
  printf 'good\n' > "$sandbox/state/unit-mode"
}

test_system_stage_rejects_unsafe_release_ancestors_and_credential_aliases() {
  local sandbox current drift malicious malicious_id output status trap_bin
  sandbox=$(mktemp -d /tmp/gwm-verify-system-trust.XXXXXX)
  trap '[[ -z "${VERIFY_MANAGER_PID:-}" ]] || kill "$VERIFY_MANAGER_PID" 2>/dev/null || true; chmod -R u+rwX "$sandbox" 2>/dev/null || true; cleanup_tree "$sandbox"' RETURN
  setup_system_verify_fixture "$sandbox"
  current=$(make_minimal_verify_release "$sandbox" current)
  drift=$(make_minimal_verify_release "$sandbox" drift)
  set_fixture_current_release "$sandbox" "$current"
  cp "$current/config/manager.production.json" "$sandbox/system-root/etc/qwen38-workload-manager/manager.production.json"
  cp "$current/config/models.production.json" "$sandbox/system-root/etc/qwen38-workload-manager/models.production.json"
  cp "$current/systemd/qwen38-workload-manager.service" "$sandbox/system-root/etc/systemd/system/qwen38-workload-manager.service"
  start_verify_manager "$sandbox" "$current"
  printf '%s\n' "$VERIFY_MANAGER_PID" > "$sandbox/state/main-pid"

  chmod 0777 "$sandbox/system-root/etc/qwen38-workload-manager"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a writable manager config ancestor must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_exact_runtime_config'
  chmod 0755 "$sandbox/system-root/etc/qwen38-workload-manager"

  chmod 0777 "$sandbox/system-root/etc/systemd/system"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a writable systemd unit ancestor must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_exact_runtime_config'
  chmod 0755 "$sandbox/system-root/etc/systemd/system"

  set_fixture_current_release "$sandbox" "$drift"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a current symlink drifting away from the running release must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_release_integrity'
  set_fixture_current_release "$sandbox" "$current"

  chmod 777 "$sandbox/system-root/opt"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a writable deployment ancestor must fail release verification'
  assert_contains "$output" 'FAIL  ubuntu_release_integrity'
  chmod 755 "$sandbox/system-root/opt"

  malicious=$(make_minimal_verify_release "$sandbox" malicious)
  trap_bin="$sandbox/system-root/trap-bin"
  mkdir -m 755 "$trap_bin"
  cat > "$trap_bin/node" <<EOF
#!/usr/bin/env bash
: > '$sandbox/node-bootstrap-executed'
if [[ "\${1:-}" == --version ]]; then printf 'v22.0.0\n'; fi
exit 0
EOF
  chmod 555 "$trap_bin/node"
  chmod u+w "$malicious/node-v22" "$malicious/node-v22/bin" "$malicious/release.manifest"
  rm -r "$malicious/node-v22/bin"
  ln -s "$trap_bin" "$malicious/node-v22/bin"
  "$TEST_REAL_NODE" - "$malicious/release.manifest" "$trap_bin/node" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const [manifestPath, nodePath] = process.argv.slice(2);
const nodeHash = crypto.createHash('sha256').update(fs.readFileSync(nodePath)).digest('hex');
const lines = fs.readFileSync(manifestPath, 'utf8').trimEnd().split('\n');
const index = lines.findIndex(line => line.endsWith('  node-v22/bin/node'));
if (index === -1) process.exit(1);
lines[index] = `${nodeHash}  node-v22/bin/node`;
fs.writeFileSync(manifestPath, `${lines.join('\n')}\n`);
NODE
  malicious_id=$(sha256sum "$malicious/release.manifest" | awk '{print $1}')
  mv "$malicious" "${malicious%/*}/$malicious_id"
  malicious="${malicious%/*}/$malicious_id"
  set +e
  output=$(run_system_verifier "$sandbox" "$malicious" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a release with a symlinked embedded-Node parent must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_release_integrity'
  assert_no_file "$sandbox/node-bootstrap-executed"

  rm "$sandbox/system-root/etc/qwen38-workload-manager/credentials/inference.key"
  ln "$sandbox/system-root/etc/qwen38-workload-manager/credentials/management.key" \
    "$sandbox/system-root/etc/qwen38-workload-manager/credentials/inference.key"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'aliased management and inference credentials must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_restart_empty_authenticated'

  rm "$sandbox/system-root/etc/qwen38-workload-manager/credentials/inference.key"
  printf '%s\n' "$(printf 'A%.0s' {1..64})" > "$sandbox/system-root/etc/qwen38-workload-manager/credentials/inference.key"
  chmod 600 "$sandbox/system-root/etc/qwen38-workload-manager/credentials/inference.key"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'case variants of the same credential must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_restart_empty_authenticated'

  printf '%s\n' "$(printf 'c%.0s' {1..64})" > "$sandbox/system-root/etc/qwen38-workload-manager/credentials/inference.key"
  chmod 600 "$sandbox/system-root/etc/qwen38-workload-manager/credentials/inference.key"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a source inference key rotated without restarting the loaded service must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_restart_empty_authenticated'
}

test_system_stage_rejects_service_inaccessible_permissions_and_identity() {
  local sandbox current output status alternate_group release_parent
  sandbox=$(mktemp -d /tmp/gwm-verify-system-permissions.XXXXXX)
  trap '[[ -z "${VERIFY_MANAGER_PID:-}" ]] || kill "$VERIFY_MANAGER_PID" 2>/dev/null || true; chmod -R u+rwX "$sandbox" 2>/dev/null || true; cleanup_tree "$sandbox"' RETURN
  setup_system_verify_fixture "$sandbox"
  current=$(make_minimal_verify_release "$sandbox" current)
  set_fixture_current_release "$sandbox" "$current"
  cp "$current/config/manager.production.json" "$sandbox/system-root/etc/qwen38-workload-manager/manager.production.json"
  cp "$current/config/models.production.json" "$sandbox/system-root/etc/qwen38-workload-manager/models.production.json"
  cp "$current/systemd/qwen38-workload-manager.service" "$sandbox/system-root/etc/systemd/system/qwen38-workload-manager.service"
  start_verify_manager "$sandbox" "$current"
  printf '%s\n' "$VERIFY_MANAGER_PID" > "$sandbox/state/main-pid"

  find -P "$current" -type d -exec chmod 0500 -- {} +
  find -P "$current" -type f -exec chmod 0400 -- {} +
  chmod 0500 -- "$current/node-v22/bin/node" "$current/canary/fake-canary" "$current/canary/real-canary"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a root-only-shaped release tree must not pass as service-readable'
  assert_contains "$output" 'FAIL  ubuntu_release_integrity'

  find -P "$current" -type d -exec chmod 0550 -- {} +
  find -P "$current" -type f -exec chmod 0440 -- {} +
  chmod 0550 -- "$current/node-v22/bin/node" "$current/canary/fake-canary" "$current/canary/real-canary"
  chmod 0400 "$sandbox/system-root/etc/qwen38-workload-manager/models.production.json"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a root-only installed model catalog must not pass as service-readable'
  assert_contains "$output" 'FAIL  ubuntu_exact_runtime_config'
  chmod 0644 "$sandbox/system-root/etc/qwen38-workload-manager/models.production.json"

  chmod 0440 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/llama-server"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a non-executable llama binary must fail artifact verification'
  assert_contains "$output" 'FAIL  ubuntu_strict_artifact_integrity'
  chmod 0550 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/llama-server"

  chmod 4550 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/llama-server"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a special-mode llama binary must fail artifact verification'
  assert_contains "$output" 'FAIL  ubuntu_strict_artifact_integrity'
  chmod 0550 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/llama-server"

  chmod 0000 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/model-1.gguf"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a model unreadable by the service identity must fail artifact verification'
  assert_contains "$output" 'FAIL  ubuntu_strict_artifact_integrity'
  chmod 0440 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/model-1.gguf"

  alternate_group=$(id -G | tr ' ' '\n' | awk -v primary="$(id -g)" '$0 != primary { print; exit }')
  [[ -n "$alternate_group" ]] || fail 'permission regression needs a supplementary fixture group'
  chgrp "$alternate_group" "$current"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a release root with the wrong service group must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_release_integrity'
  chgrp "$(id -g)" "$current"

  release_parent="$sandbox/system-root/opt/qwen38-workload-manager/artifacts"
  chgrp "$alternate_group" "$release_parent"
  chmod 0050 "$release_parent"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an owner-inaccessible artifact ancestor must not borrow execute from a supplementary group'
  assert_contains "$output" 'FAIL  ubuntu_strict_artifact_integrity'
  chmod 0550 "$release_parent"
  chgrp "$(id -g)" "$release_parent"

  chgrp "$alternate_group" "$sandbox/system-root/etc/qwen38-workload-manager/manager.production.json"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an installed manager config with the wrong group must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_exact_runtime_config'
  chgrp "$(id -g)" "$sandbox/system-root/etc/qwen38-workload-manager/manager.production.json"

  chmod 0400 "$sandbox/system-root/etc/systemd/system/qwen38-workload-manager.service"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a root-only installed unit must not pass exact runtime verification'
  assert_contains "$output" 'FAIL  ubuntu_exact_runtime_config'
  chmod 0644 "$sandbox/system-root/etc/systemd/system/qwen38-workload-manager.service"

  chgrp "$alternate_group" "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/model-1.gguf"
  chmod 0040 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/model-1.gguf"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an agentops-owned model must not borrow read access from its supplementary group class'
  assert_contains "$output" 'FAIL  ubuntu_strict_artifact_integrity'
  chmod 0440 "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/model-1.gguf"
  chgrp "$(id -g)" "$sandbox/system-root/opt/qwen38-workload-manager/artifacts/model-1.gguf"

  printf 'wrong-uid\n' > "$sandbox/state/id-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an unexpected resolved service UID must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_manager_account_identity'
}

test_system_stage_binds_listener_credentials_and_firewall() {
  local sandbox current output status credential_root credential_real
  sandbox=$(mktemp -d /tmp/gwm-verify-system-runtime-binding.XXXXXX)
  trap '[[ -z "${VERIFY_MANAGER_PID:-}" ]] || kill "$VERIFY_MANAGER_PID" 2>/dev/null || true; chmod -R u+rwX "$sandbox" 2>/dev/null || true; cleanup_tree "$sandbox"' RETURN
  setup_system_verify_fixture "$sandbox"
  current=$(make_minimal_verify_release "$sandbox" current)
  set_fixture_current_release "$sandbox" "$current"
  cp "$current/config/manager.production.json" "$sandbox/system-root/etc/qwen38-workload-manager/manager.production.json"
  cp "$current/config/models.production.json" "$sandbox/system-root/etc/qwen38-workload-manager/models.production.json"
  cp "$current/systemd/qwen38-workload-manager.service" "$sandbox/system-root/etc/systemd/system/qwen38-workload-manager.service"
  start_verify_manager "$sandbox" "$current"
  printf '%s\n' "$VERIFY_MANAGER_PID" > "$sandbox/state/main-pid"

  printf 'old\n' > "$sandbox/state/manager-ss-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an authenticated endpoint owned by a different listener PID must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_manager_listener_identity'
  assert_no_file "$sandbox/state/manager-probes" 'credentials must not be sent before listener identity is proven'

  printf 'fail\n' > "$sandbox/state/manager-ss-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an 8080 listener inspection error must fail closed'
  assert_contains "$output" 'FAIL  ubuntu_manager_listener_identity'
  assert_no_file "$sandbox/state/manager-probes" 'credentials must not be sent when listener inspection fails'
  printf 'good\n' > "$sandbox/state/manager-ss-mode"

  credential_root="$sandbox/system-root/etc/qwen38-workload-manager/credentials"
  chmod 0777 "$credential_root"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a writable credential parent must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_restart_empty_authenticated'
  chmod 0700 "$credential_root"

  credential_real="$sandbox/system-root/etc/qwen38-workload-manager/credentials-real"
  mv "$credential_root" "$credential_real"
  ln -s "$credential_real" "$credential_root"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a symlinked credential parent must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_restart_empty_authenticated'
  unlink "$credential_root"
  mv "$credential_real" "$credential_root"

  printf 'interface\n' > "$sandbox/state/ufw-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -eq 0 ]] || { printf 'interface-bound firewall fixture output:\n%s\n' "$output" >&2; fail 'an exact interface-bound LAN allow rule must pass firewall verification'; }
  assert_contains "$output" 'PASS  ubuntu_trusted_lan_firewall'

  for iptables_mode in broad-accept preceding-drop ipv6-accept partial-ipv4 partial-ip6; do
    printf '%s\n' "$iptables_mode" > "$sandbox/state/iptables-mode"
    set +e
    output=$(run_system_verifier "$sandbox" "$current" 2>&1)
    status=$?
    set -e
    [[ $status -ne 0 ]] || fail "iptables mode $iptables_mode must fail firewall verification"
    assert_contains "$output" 'FAIL  ubuntu_trusted_lan_firewall'
  done
  printf 'good\n' > "$sandbox/state/iptables-mode"

  printf 'unrelated-cidr\n' > "$sandbox/state/ufw-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an unrelated CIDR allow plus an 8080 deny must fail firewall verification'
  assert_contains "$output" 'FAIL  ubuntu_trusted_lan_firewall'

  printf 'range-anywhere\n' > "$sandbox/state/ufw-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a broad public allow range covering 8080 must fail firewall verification'
  assert_contains "$output" 'FAIL  ubuntu_trusted_lan_firewall'

  printf 'default-allow\n' > "$sandbox/state/ufw-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an active firewall with default incoming allow must fail verification'
  assert_contains "$output" 'FAIL  ubuntu_trusted_lan_firewall'
  printf 'good\n' > "$sandbox/state/ufw-mode"

  : > "$sandbox/state/manager-probes"
  printf 'replace-after-probe\n' > "$sandbox/state/unit-mode"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a MainPID replacement after authenticated probes must fail final runtime binding'
  assert_contains "$output" 'FAIL  ubuntu_final_runtime_binding'

  printf 'good\n' > "$sandbox/state/unit-mode"
  printf 'mark-loaded\n' > "$sandbox/state/ufw-mode"
  rm -f "$sandbox/state/late-loaded" "$sandbox/state/late-replaced" "$sandbox/state/manager-probes"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a model load beginning after the long gates start must fail the final restart-empty attestation'
  assert_contains "$output" 'FAIL  ubuntu_final_runtime_binding'

  printf 'replace-after-late-gate\n' > "$sandbox/state/unit-mode"
  printf 'mark-replaced\n' > "$sandbox/state/ufw-mode"
  rm -f "$sandbox/state/late-loaded" "$sandbox/state/late-replaced" "$sandbox/state/manager-probes"
  set +e
  output=$(run_system_verifier "$sandbox" "$current" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a MainPID replacement after the long gates start must fail final runtime binding'
  assert_contains "$output" 'FAIL  ubuntu_final_runtime_binding'
}

test_mac_requires_explicit_manager_url
test_ubuntu_requires_explicit_owner_and_system_stages
test_system_stage_binds_running_release_and_distinguishes_ss_failure
test_system_stage_rejects_unsafe_release_ancestors_and_credential_aliases
test_system_stage_rejects_service_inaccessible_permissions_and_identity
test_system_stage_binds_listener_credentials_and_firewall
printf 'ok - verify-live tests\n'
