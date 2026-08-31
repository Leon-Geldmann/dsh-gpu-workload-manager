#!/usr/bin/env bash

set -euo pipefail

export LC_ALL=C
umask 077

readonly EXPECTED_NODE_MAJOR=22
readonly EXPECTED_PNPM_MAJOR=11
readonly MANAGER_PACKAGE='@local/gpu-workload-managerd'

die() {
  printf 'build-ubuntu-release: %s\n' "$*" >&2
  exit 1
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd "$script_dir/../.." && pwd -P)
dist_root="$repo_root/dist"
published_root="$dist_root/ubuntu-release"
work_root=''

remove_work_tree() {
  local target=${1:-}
  [[ -n "$target" && -d "$target" && ! -L "$target" ]] || return 0
  case "$target" in
    "$dist_root"/.ubuntu-release.build.*)
      find -P "$target" -depth -mindepth 1 -delete
      rmdir -- "$target"
      ;;
    *)
      printf 'build-ubuntu-release: refusing to clean unexpected path: %s\n' "$target" >&2
      return 1
      ;;
  esac
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  [[ -z "$work_root" ]] || remove_work_tree "$work_root" || true
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

sha256_file() {
  sha256sum -- "$1" | cut -d ' ' -f 1
}

node_bin=$(command -v node || true)
pnpm_bin=$(command -v pnpm || true)
[[ -n "$node_bin" && -x "$node_bin" ]] || die 'node is not available on PATH'
[[ -n "$pnpm_bin" && -x "$pnpm_bin" ]] || die 'pnpm is not available on PATH'

node_version=$($node_bin --version)
[[ "$node_version" == v${EXPECTED_NODE_MAJOR}.* ]] || die "Node 22.x is required (found $node_version)"
pnpm_version=$($pnpm_bin --version)
[[ "$pnpm_version" == ${EXPECTED_PNPM_MAJOR}.* ]] || die "pnpm 11.x is required (found $pnpm_version)"

[[ -f "$repo_root/package.json" && ! -L "$repo_root/package.json" && -f "$repo_root/pnpm-workspace.yaml" ]] || die 'workspace sentinel files are missing'
[[ -f "$repo_root/packages/managerd/package.json" && ! -L "$repo_root/packages/managerd/package.json" ]] || die 'managerd workspace package is missing'
$node_bin - "$repo_root/package.json" "$repo_root/packages/managerd/package.json" <<'NODE' || die 'workspace manifests do not match this project'
const fs = require('node:fs');
const [rootPath, managerPath] = process.argv.slice(2);
const root = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
const manager = JSON.parse(fs.readFileSync(managerPath, 'utf8'));
if (root.name !== 'dsh-gpu-workload-manager-workspace' || root.private !== true || root.packageManager !== 'pnpm@11.19.0') process.exit(1);
if (manager.name !== '@local/gpu-workload-managerd' || manager.private !== true) process.exit(1);
NODE

printf 'Building standalone manager daemon and canary...\n'
(cd "$repo_root" && "$pnpm_bin" --filter "$MANAGER_PACKAGE" build)

manager_bundle="$repo_root/packages/managerd/dist/managerd.js"
canary_bundle="$repo_root/packages/managerd/dist/canary.js"
manager_config="$repo_root/deploy/config/manager.production.json"
models_config="$repo_root/deploy/config/models.production.json"
systemd_unit="$repo_root/deploy/systemd/qwen38-workload-manager.service"
live_verifier="$repo_root/deploy/scripts/verify-live.sh"
preflight_script="$repo_root/deploy/scripts/preflight-ubuntu.sh"
for bundle in "$manager_bundle" "$canary_bundle"; do
  [[ -f "$bundle" && ! -L "$bundle" ]] || die "missing regular runtime bundle: $bundle"
  [[ -s "$bundle" ]] || die "empty runtime bundle: $bundle"
done
for source in "$manager_config" "$models_config" "$systemd_unit" "$live_verifier" "$preflight_script"; do
  [[ -f "$source" && ! -L "$source" && -s "$source" ]] || die "missing regular deployment source: $source"
done
/bin/bash -n "$live_verifier" || die 'live verifier has invalid Bash syntax'
/bin/bash -n "$preflight_script" || die 'preflight script has invalid Bash syntax'

mkdir -p "$dist_root"
work_root=$(mktemp -d "$dist_root/.ubuntu-release.build.XXXXXX")
stage="$work_root/release"
mkdir -p "$stage/node-v22/bin" "$stage/dist" "$stage/canary" "$stage/config" "$stage/systemd" "$stage/verify"
install -m 0555 "$node_bin" "$stage/node-v22/bin/node"
install -m 0444 "$manager_bundle" "$stage/dist/managerd.js"
install -m 0444 "$canary_bundle" "$stage/dist/canary.js"
install -m 0444 "$manager_config" "$stage/config/manager.production.json"
install -m 0444 "$models_config" "$stage/config/models.production.json"
install -m 0444 "$systemd_unit" "$stage/systemd/qwen38-workload-manager.service"
install -m 0444 "$live_verifier" "$stage/verify/verify-live.sh"
install -m 0550 "$preflight_script" "$stage/verify/preflight-ubuntu.sh"
printf '%s\n' '{"name":"@local/gpu-workload-manager-runtime","private":true,"type":"module"}' > "$stage/dist/package.json"
chmod 0444 "$stage/dist/package.json"

staged_node_version=$("$stage/node-v22/bin/node" --version)
[[ "$staged_node_version" == v${EXPECTED_NODE_MAJOR}.* ]] || die "staged Node 22 validation failed (found $staged_node_version)"
"$stage/node-v22/bin/node" - "$stage/dist/managerd.js" "$stage/dist/canary.js" "$stage/config/manager.production.json" "$stage/config/models.production.json" "$stage/systemd/qwen38-workload-manager.service" <<'NODE' || die 'staged runtime must be standalone and deployment config/unit must be valid'
const fs = require('node:fs');
const [managerBundle, canaryBundle, managerPath, modelsPath, unitPath] = process.argv.slice(2);
for (const file of [managerBundle, canaryBundle]) {
  const source = fs.readFileSync(file, 'utf8');
  if (/(?:from\s*|import\s*(?:\(\s*)?)["']\.\//.test(source) || /@local\/|workspace:/.test(source)) process.exit(1);
}
const manager = JSON.parse(fs.readFileSync(managerPath, 'utf8'));
const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
const unit = fs.readFileSync(unitPath, 'utf8');
if (manager.version !== 1 || manager.startup?.mode !== 'manual' || manager.startup?.initialState !== 'UNLOADED'
  || manager.startup?.autoLoad !== false || manager.startup?.restoreLastModel !== false
  || manager.listen?.host !== '0.0.0.0' || manager.listen?.port !== 8080
  || manager.child?.host !== '127.0.0.1' || manager.child?.port !== 18080
  || manager.catalogPath !== '/etc/qwen38-workload-manager/models.production.json') process.exit(1);
if (models.version !== 1 || !Array.isArray(models.models) || models.models.length !== 4
  || models.models.some(model => !/^[0-9a-f]{64}$/.test(model.sha256) || !Number.isSafeInteger(model.bytes) || model.bytes < 1)) process.exit(1);
for (const required of ['User=agentops', 'Group=agentops', 'KillMode=control-group', 'LoadCredential=inference.key:', 'LoadCredential=management.key:', 'NoNewPrivileges=yes']) {
  if (!unit.includes(required)) process.exit(1);
}
NODE

write_canary_wrapper() {
  local destination=$1 expected_kind=$2 temporary
  temporary="$destination.tmp"
  {
    printf '%s\n' '#!/usr/bin/env sh' 'set -eu' "expected_kind='$expected_kind'"
    cat <<'SH'
if [ "${QWEN38_CANARY_KIND:-}" != "$expected_kind" ]; then
  exit 64
fi
case "$expected_kind:${QWEN38_CANARY_MODE:-}" in
  fake:full|real:full|real:artifact-only) ;;
  *) exit 64 ;;
esac
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
release_directory=$(CDPATH= cd -- "$script_directory/.." && pwd -P)
if [ "${QWEN38_RELEASE_DIR:-}" != "$release_directory" ]; then
  exit 64
fi
exec "$release_directory/node-v22/bin/node" "$release_directory/dist/canary.js"
SH
  } > "$temporary"
  chmod 0555 "$temporary"
  mv -- "$temporary" "$destination"
}

write_canary_wrapper "$stage/canary/fake-canary" fake
write_canary_wrapper "$stage/canary/real-canary" real

if find -P "$stage" -type l -o \( ! -type d ! -type f \) | grep -q .; then
  die 'release contains a symlink or non-regular entry'
fi
if find -P "$stage" -type f \( -name '.env' -o -name '*.key' \) | grep -q .; then
  die 'release must not contain env or key files'
fi

manifest_source="$work_root/release.manifest"
while IFS= read -r relative; do
  [[ "$relative" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$relative" != *//* && "$relative" != */../* ]] || die "unsafe release path: $relative"
  printf '%s  %s\n' "$(sha256_file "$stage/$relative")" "$relative"
done < <(find -P "$stage" -type f -printf '%P\n' | LC_ALL=C sort) > "$manifest_source"
[[ -s "$manifest_source" ]] || die 'release manifest is empty'
install -m 0444 "$manifest_source" "$stage/release.manifest"
release_id=$(sha256_file "$stage/release.manifest")
[[ "$release_id" =~ ^[0-9a-f]{64}$ ]] || die 'invalid release ID'
mv -- "$stage" "$work_root/$release_id"
stage="$work_root/$release_id"
(cd "$stage" && sha256sum --strict --check release.manifest >/dev/null) || die 'release digest self-check failed'

archive_temporary="$work_root/qwen38-workload-manager-ubuntu.tar.gz"
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --mode='a=rX' -C "$work_root" -cf - "$release_id" | gzip -n > "$archive_temporary"
archive_hash=$(sha256_file "$archive_temporary")
archive_name="qwen38-workload-manager-ubuntu-${release_id}-${archive_hash}.tar.gz"

if [[ -e "$published_root" ]]; then
  [[ -d "$published_root" && ! -L "$published_root" ]] || die "$published_root exists and is not a regular directory"
else
  mkdir -p "$published_root"
fi

published_release="$published_root/$release_id"
if [[ -e "$published_release" ]]; then
  [[ -d "$published_release" && ! -L "$published_release" ]] || die 'existing release ID is not a regular directory'
  [[ "$(sha256_file "$published_release/release.manifest")" == "$release_id" ]] || die 'existing content-addressed release is invalid'
  (cd "$published_release" && sha256sum --strict --check release.manifest >/dev/null) || die 'existing content-addressed release is corrupt'
  diff -qr "$stage" "$published_release" >/dev/null || die 'existing content-addressed release differs from staged bytes'
else
  mv -- "$stage" "$published_release"
  find -P "$published_release" -type d -exec chmod 0555 {} +
fi

published_archive="$published_root/$archive_name"
if [[ -e "$published_archive" ]]; then
  [[ -f "$published_archive" && ! -L "$published_archive" && "$(sha256_file "$published_archive")" == "$archive_hash" ]] || die 'existing content-addressed archive is corrupt'
else
  mv -- "$archive_temporary" "$published_archive"
fi

checksums_temporary="$work_root/SHA256SUMS"
while IFS= read -r archive; do
  name=$(basename "$archive")
  [[ "$name" =~ ^qwen38-workload-manager-ubuntu-[0-9a-f]{64}-[0-9a-f]{64}\.tar\.gz$ ]] || die "unexpected archive in release directory: $name"
  printf '%s  %s\n' "$(sha256_file "$archive")" "$name"
done < <(find -P "$published_root" -mindepth 1 -maxdepth 1 -type f -name '*.tar.gz' | LC_ALL=C sort) > "$checksums_temporary"
[[ -s "$checksums_temporary" ]] || die 'no Ubuntu release archive was published'
install -m 0400 "$checksums_temporary" "$published_root/.SHA256SUMS.new"
mv -f -- "$published_root/.SHA256SUMS.new" "$published_root/SHA256SUMS"

printf 'Published Ubuntu release id=%s directory=%s archive=%s\n' "$release_id" "$published_release" "$published_archive"
