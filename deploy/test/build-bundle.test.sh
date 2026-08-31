#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source "$test_dir/testlib.sh"
repo_root=$(cd "$test_dir/../.." && pwd -P)
TEST_REAL_NODE=${TEST_REAL_NODE:-$(command -v node)}
export TEST_REAL_NODE

setup_build_fixture() {
  local fixture_root=$1
  mkdir -p "$fixture_root/deploy/scripts" "$fixture_root/packages" "$fixture_root/fake-bin"
  cp "$repo_root/deploy/scripts/build-bundle.sh" "$fixture_root/deploy/scripts/build-bundle.sh"
  chmod +x "$fixture_root/deploy/scripts/build-bundle.sh"
  printf '%s\n' '{"name":"dsh-gpu-workload-manager-workspace","private":true,"packageManager":"pnpm@11.19.0"}' > "$fixture_root/package.json"
  printf '%s\n' 'packages:' '  - packages/*' > "$fixture_root/pnpm-workspace.yaml"
  write_package_fixture "$fixture_root" dsh-plugin '@local/dsh-gpu-workload-manager'
  write_package_fixture "$fixture_root" dsh-model-selection '@local/dsh-gpu-model-selection'
  write_package_fixture "$fixture_root" bundle '@local/dsh-gpu-workload-bundle'
  make_fake_node "$fixture_root/fake-bin"
  make_fake_pnpm_for_build "$fixture_root/fake-bin"
}

test_builds_in_order_and_reproduces() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-build-test.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_build_fixture "$sandbox/repo"
  export FAKE_COMMAND_LOG="$sandbox/commands.log"
  PATH="$sandbox/repo/fake-bin:$PATH" "$sandbox/repo/deploy/scripts/build-bundle.sh"

  assert_file "$sandbox/repo/dist/packages/SHA256SUMS"
  assert_eq 3 "$(find "$sandbox/repo/dist/packages" -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')" 'must publish exactly three tarballs'
  local archive filename embedded_hash actual_hash
  for archive in "$sandbox/repo/dist/packages/"*.tgz; do
    filename=$(basename "$archive")
    [[ "$filename" =~ -([0-9a-f]{64})\.tgz$ ]] || fail "tarball filename must contain its full SHA-256: $filename"
    embedded_hash=${BASH_REMATCH[1]}
    actual_hash=$(sha256sum "$archive" | awk '{print $1}')
    assert_eq "$actual_hash" "$embedded_hash" 'tarball filename hash must address its exact bytes'
  done
  assert_eq $'build @local/dsh-gpu-workload-manager\nbuild @local/dsh-gpu-model-selection\nbuild @local/dsh-gpu-workload-bundle' "$(sed -n '1,3p' "$sandbox/commands.log")" 'host, UI, and bundle builds must be sequential'
  local first_checksums
  first_checksums=$(<"$sandbox/repo/dist/packages/SHA256SUMS")

  PATH="$sandbox/repo/fake-bin:$PATH" "$sandbox/repo/deploy/scripts/build-bundle.sh"
  assert_eq "$first_checksums" "$(<"$sandbox/repo/dist/packages/SHA256SUMS")" 'two builds must publish byte-identical archives'
  (cd "$sandbox/repo/dist/packages" && sha256sum -c SHA256SUMS >/dev/null)
}

test_rejects_unpublishable_manifest_without_replacing_release() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-build-invalid.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_build_fixture "$sandbox/repo"
  mkdir -p "$sandbox/repo/dist/packages"
  printf 'old-release\n' > "$sandbox/repo/dist/packages/keep.txt"
  export FAKE_COMMAND_LOG="$sandbox/commands.log"
  local output status
  set +e
  output=$(FAKE_BAD_MANIFEST_PACKAGE='@local/dsh-gpu-model-selection' PATH="$sandbox/repo/fake-bin:$PATH" "$sandbox/repo/deploy/scripts/build-bundle.sh" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'workspace: dependency must reject the package'
  assert_contains "$output" 'workspace:' 'failure must identify the forbidden publish spec'
  assert_file "$sandbox/repo/dist/packages/keep.txt"
  assert_eq 1 "$(find "$sandbox/repo/dist/packages" -maxdepth 1 -type f | wc -l | tr -d ' ')" 'failed validation must leave the previous release untouched'
}

test_rejects_wrong_toolchain_before_build() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-build-version.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_build_fixture "$sandbox/repo"
  export FAKE_COMMAND_LOG="$sandbox/commands.log"
  local output status
  set +e
  output=$(FAKE_NODE_VERSION=v21.9.0 PATH="$sandbox/repo/fake-bin:$PATH" "$sandbox/repo/deploy/scripts/build-bundle.sh" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'Node 21 must be rejected'
  assert_contains "$output" 'Node 22' 'failure must explain the required Node major'
  assert_no_file "$sandbox/commands.log"
}

test_does_not_require_gnu_find_maxdepth() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-build-bsd-find.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_build_fixture "$sandbox/repo"
  export FAKE_COMMAND_LOG="$sandbox/commands.log"
  local real_find
  real_find=$(command -v find)
  cat > "$sandbox/repo/fake-bin/find" <<EOF
#!/usr/bin/env bash
for argument in "\$@"; do
  if [[ "\$argument" == -maxdepth ]]; then
    printf 'BSD find does not support -maxdepth\n' >&2
    exit 88
  fi
done
exec "$real_find" "\$@"
EOF
  chmod +x "$sandbox/repo/fake-bin/find"
  PATH="$sandbox/repo/fake-bin:$PATH" "$sandbox/repo/deploy/scripts/build-bundle.sh"
  assert_file "$sandbox/repo/dist/packages/SHA256SUMS"
}

test_builds_in_order_and_reproduces
test_rejects_unpublishable_manifest_without_replacing_release
test_rejects_wrong_toolchain_before_build
test_does_not_require_gnu_find_maxdepth
printf 'ok - build-bundle tests\n'
