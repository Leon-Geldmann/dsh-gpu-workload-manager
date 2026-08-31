#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source "$test_dir/testlib.sh"
repo_root=$(cd "$test_dir/../.." && pwd -P)
TEST_REAL_NODE=${TEST_REAL_NODE:-$(command -v node)}
export TEST_REAL_NODE

setup_release_fixture() {
  local fixture_root=$1
  mkdir -p "$fixture_root/deploy/scripts" "$fixture_root/deploy/config" "$fixture_root/deploy/systemd" "$fixture_root/packages/managerd/dist" "$fixture_root/fake-bin"
  cp "$repo_root/deploy/scripts/build-ubuntu-release.sh" "$fixture_root/deploy/scripts/build-ubuntu-release.sh"
  cp "$repo_root/deploy/scripts/preflight-ubuntu.sh" "$fixture_root/deploy/scripts/preflight-ubuntu.sh"
  cp "$repo_root/deploy/scripts/verify-live.sh" "$fixture_root/deploy/scripts/verify-live.sh"
  cp "$repo_root/deploy/config/manager.production.json" "$repo_root/deploy/config/models.production.json" "$fixture_root/deploy/config/"
  cp "$repo_root/deploy/systemd/qwen38-workload-manager.service" "$fixture_root/deploy/systemd/"
  chmod +x "$fixture_root/deploy/scripts/build-ubuntu-release.sh"
  printf '%s\n' '{"name":"dsh-gpu-workload-manager-workspace","private":true,"packageManager":"pnpm@11.19.0"}' > "$fixture_root/package.json"
  printf '%s\n' 'packages:' '  - packages/*' > "$fixture_root/pnpm-workspace.yaml"
  printf '%s\n' '{"name":"@local/gpu-workload-managerd","private":true}' > "$fixture_root/packages/managerd/package.json"
  make_release_fake_node "$fixture_root/fake-bin"
  make_release_fake_pnpm "$fixture_root/fake-bin"
}

make_release_fake_node() {
  local bin_dir=$1
  cat > "$bin_dir/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == --version ]]; then
  if [[ "${FAKE_NODE_FLIP_AFTER_FIRST:-0}" == 1 ]]; then
    count=0
    [[ ! -f "$FAKE_NODE_VERSION_COUNTER" ]] || count=$(<"$FAKE_NODE_VERSION_COUNTER")
    printf '%s\n' "$((count + 1))" > "$FAKE_NODE_VERSION_COUNTER"
    if ((count >= 1)); then printf '%s\n' v21.9.0; exit 0; fi
  fi
  printf '%s\n' "${FAKE_NODE_VERSION:-v22.23.2}"
  exit 0
fi
exec "$TEST_REAL_NODE" "$@"
EOF
  chmod +x "$bin_dir/node"
}

make_release_fake_pnpm() {
  local bin_dir=$1
  cat > "$bin_dir/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then
  printf '%s\n' "${FAKE_PNPM_VERSION:-11.19.0}"
  exit 0
fi
[[ "$*" == '--filter @local/gpu-workload-managerd build' ]] || exit 71
printf 'managerd build\n' >> "$FAKE_COMMAND_LOG"
mkdir -p packages/managerd/dist
if [[ "${FAKE_RELATIVE_IMPORT:-0}" == 1 ]]; then
  printf '%s\n' 'import "./chunk.js";' > packages/managerd/dist/managerd.js
else
  printf '%s\n' 'export const ready = true;' > packages/managerd/dist/managerd.js
fi
cat > packages/managerd/dist/canary.js <<'NODE'
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CANARY_LOG, `${process.env.QWEN38_CANARY_KIND}:${process.env.QWEN38_CANARY_MODE}\n`);
NODE
EOF
  chmod +x "$bin_dir/pnpm"
}

release_directory() {
  find "$1/dist/ubuntu-release" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' | head -1
}

test_builds_a_reproducible_self_contained_release() {
  local sandbox release release_id first_sums
  sandbox=$(mktemp -d /tmp/gwm-ubuntu-release.XXXXXX)
  trap 'chmod -R u+w "$sandbox" 2>/dev/null || true; cleanup_tree "$sandbox"' RETURN
  setup_release_fixture "$sandbox/repo"
  export FAKE_COMMAND_LOG="$sandbox/commands.log"

  (cd "$sandbox/repo" && PATH="$sandbox/repo/fake-bin:$PATH" deploy/scripts/build-ubuntu-release.sh)
  release=$(release_directory "$sandbox/repo")
  [[ -n "$release" ]] || fail 'release directory was not published'
  release_id=$(basename "$release")
  [[ "$release_id" =~ ^[0-9a-f]{64}$ ]] || fail 'release directory must use the full manifest SHA-256'
  assert_eq "$release_id" "$(sha256sum "$release/release.manifest" | awk '{print $1}')" 'release ID must address the manifest bytes'
  assert_eq $'canary/fake-canary\ncanary/real-canary\nconfig/manager.production.json\nconfig/models.production.json\ndist/canary.js\ndist/managerd.js\ndist/package.json\nnode-v22/bin/node\nsystemd/qwen38-workload-manager.service\nverify/preflight-ubuntu.sh\nverify/verify-live.sh' "$(sed -E 's/^[0-9a-f]{64}  //' "$release/release.manifest")" 'manifest must be complete and C-sorted'
  assert_eq module "$(json_eval "$release/dist/package.json" 'data.type')" 'runtime bundles must have an explicit ESM boundary'
  (cd "$release" && sha256sum --strict -c release.manifest >/dev/null)
  assert_eq 0 "$(find -P "$release" -type l | wc -l | tr -d ' ')" 'release must not contain symlinks'
  assert_eq 555 "$(stat -c %a "$release/node-v22/bin/node")" 'root-owned staging Node must be executable by agentops but not writable'
  assert_eq 555 "$(stat -c %a "$release/canary/fake-canary")" 'root-owned canary wrapper must be executable by agentops but not writable'
  assert_eq 444 "$(stat -c %a "$release/dist/managerd.js")" 'root-owned daemon bundle must be readable by agentops but immutable'
  assert_eq 444 "$(stat -c %a "$release/verify/verify-live.sh")" 'root-owned verifier must be readable by root but immutable'
  assert_eq 550 "$(stat -c %a "$release/verify/preflight-ubuntu.sh")" 'pinned firewall preflight must be executable by root but immutable'
  assert_eq "$(sha256sum "$sandbox/repo/deploy/scripts/verify-live.sh" | awk '{print $1}')" "$(sha256sum "$release/verify/verify-live.sh" | awk '{print $1}')" 'release verifier must exactly match the manifest-pinned repository input'
  assert_eq 555 "$(stat -c %a "$release/dist")" 'root-owned release directories must be traversable by agentops but immutable'
  ! find "$release" -type f \( -name '.env' -o -name '*.key' \) | grep -q . || fail 'release must not contain env or key files'

  : > "$sandbox/canary.log"
  assert_eq '' "$(FAKE_CANARY_LOG="$sandbox/canary.log" TEST_REAL_NODE="$TEST_REAL_NODE" QWEN38_CANARY_KIND=fake QWEN38_CANARY_MODE=full QWEN38_RELEASE_DIR="$release" "$release/canary/fake-canary" 2>&1)" 'fake canary must run without module warnings'
  assert_eq '' "$(FAKE_CANARY_LOG="$sandbox/canary.log" TEST_REAL_NODE="$TEST_REAL_NODE" QWEN38_CANARY_KIND=real QWEN38_CANARY_MODE=full QWEN38_RELEASE_DIR="$release" "$release/canary/real-canary" 2>&1)" 'real canary must run without module warnings'
  assert_eq '' "$(FAKE_CANARY_LOG="$sandbox/canary.log" TEST_REAL_NODE="$TEST_REAL_NODE" QWEN38_CANARY_KIND=real QWEN38_CANARY_MODE=artifact-only QWEN38_RELEASE_DIR="$release" "$release/canary/real-canary" 2>&1)" 'artifact-only real canary must run without module warnings'
  assert_eq $'fake:full\nreal:full\nreal:artifact-only' "$(<"$sandbox/canary.log")" 'wrappers must execute only the exact kind and mode contracts'
  assert_wrapper_rejects "$sandbox" "$release/canary/fake-canary" real full 'fake wrapper must reject a mismatched canary kind'
  assert_wrapper_rejects "$sandbox" "$release/canary/fake-canary" fake artifact-only 'fake wrapper must reject artifact-only mode'
  assert_wrapper_rejects "$sandbox" "$release/canary/real-canary" real '' 'real wrapper must reject a missing canary mode'

  assert_file "$sandbox/repo/dist/ubuntu-release/SHA256SUMS"
  (cd "$sandbox/repo/dist/ubuntu-release" && sha256sum -c SHA256SUMS >/dev/null)
  first_sums=$(<"$sandbox/repo/dist/ubuntu-release/SHA256SUMS")
  (cd "$sandbox/repo" && PATH="$sandbox/repo/fake-bin:$PATH" deploy/scripts/build-ubuntu-release.sh)
  assert_eq "$first_sums" "$(<"$sandbox/repo/dist/ubuntu-release/SHA256SUMS")" 'repeated builds must publish byte-identical archives'
  assert_eq 2 "$(wc -l < "$sandbox/commands.log" | tr -d ' ')" 'each release build must invoke the manager build exactly once'
}

assert_wrapper_rejects() {
  local sandbox=$1 wrapper=$2 kind=$3 mode=$4 message=$5 output status before
  before=$(<"$sandbox/canary.log")
  set +e
  output=$(FAKE_CANARY_LOG="$sandbox/canary.log" QWEN38_CANARY_KIND="$kind" QWEN38_CANARY_MODE="$mode" QWEN38_RELEASE_DIR=$(dirname "$(dirname "$wrapper")") "$wrapper" 2>&1)
  status=$?
  set -e
  assert_eq 64 "$status" "$message (status)"
  assert_eq '' "$output" "$message (output)"
  assert_eq "$before" "$(<"$sandbox/canary.log")" "$message (bundle must not execute)"
}

test_rejects_wrong_toolchain_before_build() {
  local sandbox output status
  sandbox=$(mktemp -d /tmp/gwm-ubuntu-node.XXXXXX)
  trap 'chmod -R u+w "$sandbox" 2>/dev/null || true; cleanup_tree "$sandbox"' RETURN
  setup_release_fixture "$sandbox/repo"
  export FAKE_COMMAND_LOG="$sandbox/commands.log"
  set +e
  output=$(cd "$sandbox/repo" && FAKE_NODE_VERSION=v21.9.0 PATH="$sandbox/repo/fake-bin:$PATH" deploy/scripts/build-ubuntu-release.sh 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'Node 21 must be rejected'
  assert_contains "$output" 'Node 22' 'failure must explain the pinned Node major'
  assert_no_file "$sandbox/commands.log"
  assert_no_file "$sandbox/repo/dist/ubuntu-release"
}

test_rejects_non_standalone_output_without_replacing_release() {
  local sandbox release before output status
  sandbox=$(mktemp -d /tmp/gwm-ubuntu-standalone.XXXXXX)
  trap 'chmod -R u+w "$sandbox" 2>/dev/null || true; cleanup_tree "$sandbox"' RETURN
  setup_release_fixture "$sandbox/repo"
  export FAKE_COMMAND_LOG="$sandbox/commands.log"
  (cd "$sandbox/repo" && PATH="$sandbox/repo/fake-bin:$PATH" deploy/scripts/build-ubuntu-release.sh)
  release=$(release_directory "$sandbox/repo")
  before=$(sha256sum "$release/release.manifest")
  set +e
  output=$(cd "$sandbox/repo" && FAKE_RELATIVE_IMPORT=1 PATH="$sandbox/repo/fake-bin:$PATH" deploy/scripts/build-ubuntu-release.sh 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'relative runtime imports must be rejected'
  assert_contains "$output" 'standalone' 'failure must explain the single-file runtime requirement'
  assert_eq "$before" "$(sha256sum "$release/release.manifest")" 'a failed build must not replace the last valid release'
}

test_revalidates_the_staged_node_copy() {
  local sandbox output status
  sandbox=$(mktemp -d /tmp/gwm-ubuntu-node-race.XXXXXX)
  trap 'chmod -R u+w "$sandbox" 2>/dev/null || true; cleanup_tree "$sandbox"' RETURN
  setup_release_fixture "$sandbox/repo"
  export FAKE_COMMAND_LOG="$sandbox/commands.log"
  export FAKE_NODE_VERSION_COUNTER="$sandbox/node-version-count"
  set +e
  output=$(cd "$sandbox/repo" && FAKE_NODE_FLIP_AFTER_FIRST=1 PATH="$sandbox/repo/fake-bin:$PATH" deploy/scripts/build-ubuntu-release.sh 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a staged copy that no longer reports Node 22 must be rejected'
  assert_contains "$output" 'staged Node 22' 'failure must identify staged Node validation'
  assert_no_file "$sandbox/repo/dist/ubuntu-release"
}

test_builds_a_reproducible_self_contained_release
test_rejects_wrong_toolchain_before_build
test_rejects_non_standalone_output_without_replacing_release
test_revalidates_the_staged_node_copy
printf 'ok - build-ubuntu-release tests\n'
