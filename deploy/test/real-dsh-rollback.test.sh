#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source "$test_dir/testlib.sh"
repo_root=$(cd "$test_dir/../.." && pwd -P)

real_node=$(command -v node || true)
real_pnpm=$(command -v pnpm || true)
real_dsh=$(command -v dsh || true)
if [[ -z "$real_node" || -z "$real_pnpm" || -z "$real_dsh" ]]; then
  printf 'ok - real DSH rollback test # SKIP node, pnpm, or dsh is unavailable\n'
  exit 0
fi
if [[ $("$real_node" --version) != v22.* || $("$real_pnpm" --version) != 11.* || $("$real_dsh" --version) != 0.1.1-rc.2 ]]; then
  printf 'ok - real DSH rollback test # SKIP exact Node 22, pnpm 11, and DSH rc.2 are required\n'
  exit 0
fi
if ! command -v sha256sum >/dev/null 2>&1 || ! tar --help 2>&1 | grep -q -- '--sort'; then
  printf 'ok - real DSH rollback test # SKIP GNU tar and sha256sum are required for fixtures\n'
  exit 0
fi

TEST_REAL_NODE=$real_node
export TEST_REAL_NODE
sandbox=$(mktemp -d /tmp/gwm-real-dsh-rollback.XXXXXX)
trap 'cleanup_tree "$sandbox"' EXIT
mkdir -p "$sandbox/repo/deploy/scripts" "$sandbox/cwd"
cp "$repo_root/deploy/scripts/install-dsh-bundle.sh" "$sandbox/repo/deploy/scripts/install-dsh-bundle.sh"
cp "$repo_root/deploy/scripts/verify-live.sh" "$sandbox/repo/deploy/scripts/verify-live.sh"
chmod +x "$sandbox/repo/deploy/scripts/install-dsh-bundle.sh"
chmod +x "$sandbox/repo/deploy/scripts/verify-live.sh"
make_artifact_set "$sandbox/repo"
(
  cd "$sandbox/cwd"
  DSH_HOME="$sandbox/dsh-home" "$real_dsh" --profile web --dump-default-config >/dev/null
  DSH_HOME="$sandbox/dsh-home" "$real_dsh" --profile headless --dump-default-config >/dev/null
)
printf '%s\n' '- id: gpu-workload-manager' '  disabled: true' > "$sandbox/dsh-home/profiles/web/cordis.patch.yml"

before=$(filesystem_tree_snapshot "$sandbox/dsh-home/profiles")
set +e
output=$("$sandbox/repo/deploy/scripts/install-dsh-bundle.sh" --dsh-home "$sandbox/dsh-home" --role server 2>&1)
status=$?
set -e
[[ $status -ne 0 ]] || fail 'a real DSH disabled-manager composition must fail installation'
assert_contains "$output" 'web profile composition validation failed'
assert_contains "$output" 'rolling back profile changes'
assert_eq "$before" "$(filesystem_tree_snapshot "$sandbox/dsh-home/profiles")" 'real DSH rollback must leave no profile package, transitive, metadata, or lockfile residue'
assert_no_file "$sandbox/dsh-home/.env"
assert_no_file "$sandbox/dsh-home/.gpu-workload-manager/transaction"
assert_no_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
assert_eq 3 "$(find "$sandbox/dsh-home/.gpu-workload-manager/packages" -type f -name '*.tgz' | wc -l | tr -d ' ')" 'verified content-addressed archives must remain as the intentional persistent cache'

rm "$sandbox/dsh-home/profiles/web/cordis.patch.yml"
"$sandbox/repo/deploy/scripts/install-dsh-bundle.sh" --dsh-home "$sandbox/dsh-home" --role server >/dev/null
output=$("$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu --dsh-home "$sandbox/dsh-home" --dsh-only 2>&1)
assert_contains "$output" 'PASS  dsh_same_bundle_role' 'strict payload verification must accept a fresh real DSH installation'
assert_contains "$output" 'LIVE VERIFICATION: PASS role=ubuntu scope=dsh-only' 'real DSH installation must satisfy the complete DSH-only gate'

printf 'ok - real DSH rollback test\n'
