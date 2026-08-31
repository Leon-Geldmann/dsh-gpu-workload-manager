#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_NODE_MAJOR=22
readonly EXPECTED_PNPM_MAJOR=11
readonly RELEASE_VERSION=0.1.0
readonly MANAGER_PACKAGE='@local/dsh-gpu-workload-manager'
readonly SELECTOR_PACKAGE='@local/dsh-gpu-model-selection'
readonly BUNDLE_PACKAGE='@local/dsh-gpu-workload-bundle'

die() {
  printf 'build-bundle: %s\n' "$*" >&2
  exit 1
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd "$script_dir/../.." && pwd -P)
dist_root="$repo_root/dist"
published_dir="$dist_root/packages"

node_bin=$(command -v node || true)
pnpm_bin=$(command -v pnpm || true)
[[ -n "$node_bin" ]] || die 'node is not available on PATH'
[[ -n "$pnpm_bin" ]] || die 'pnpm is not available on PATH'

node_version=$("$node_bin" --version)
[[ "$node_version" == v${EXPECTED_NODE_MAJOR}.* ]] || die "Node 22.x is required (found $node_version)"
pnpm_version=$("$pnpm_bin" --version)
[[ "$pnpm_version" == ${EXPECTED_PNPM_MAJOR}.* ]] || die "pnpm 11.x is required (found $pnpm_version)"

[[ -f "$repo_root/package.json" && -f "$repo_root/pnpm-workspace.yaml" ]] || die 'workspace sentinel files are missing'
for package_dir in dsh-plugin dsh-model-selection bundle; do
  [[ -f "$repo_root/packages/$package_dir/package.json" ]] || die "workspace package is missing: packages/$package_dir"
done

"$node_bin" - "$repo_root/package.json" <<'NODE' || die 'workspace package.json does not match this project'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (manifest.name !== 'dsh-gpu-workload-manager-workspace' || manifest.private !== true) process.exit(1);
if (manifest.packageManager !== 'pnpm@11.19.0') process.exit(1);
NODE

temporary_root=''
publish_stage=''
publish_backup=''

remove_generated_tree() {
  local target=${1:-}
  [[ -n "$target" && -d "$target" ]] || return 0
  case "$target" in
    /tmp/gwm-package-build.*|"${TMPDIR:-/tmp}"/gwm-package-build.*|"$dist_root"/.packages.stage.*|"$dist_root"/.packages.previous.*)
      find "$target" -depth -delete
      ;;
    *)
      printf 'build-bundle: refusing to clean unexpected path: %s\n' "$target" >&2
      return 1
      ;;
  esac
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ $status -ne 0 && -n "$publish_backup" && -d "$publish_backup" && ! -e "$published_dir" ]]; then
    mv "$publish_backup" "$published_dir" || true
    publish_backup=''
  fi
  [[ -z "$publish_stage" ]] || remove_generated_tree "$publish_stage" || true
  [[ -z "$publish_backup" ]] || remove_generated_tree "$publish_backup" || true
  [[ -z "$temporary_root" ]] || remove_generated_tree "$temporary_root" || true
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

sha256_file() {
  local file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die 'sha256sum or shasum is required'
  fi
}

validate_archive() {
  local archive=$1
  local expected_name=$2
  "$node_bin" - "$archive" "$expected_name" "$RELEASE_VERSION" <<'NODE'
const cp = require('node:child_process');

const [archive, expectedName, expectedVersion] = process.argv.slice(2);
const fail = message => {
  process.stderr.write(`build-bundle: ${message}\n`);
  process.exit(1);
};
const tar = args => cp.execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

let entries;
try {
  entries = tar(['-tzf', archive]).split(/\r?\n/).filter(Boolean);
} catch (error) {
  fail(`cannot list archive ${archive}: ${error.message}`);
}
if (entries.length === 0) fail(`archive is empty: ${archive}`);
for (const entry of entries) {
  const parts = entry.replace(/\/$/, '').split('/');
  if (entry.startsWith('/') || entry.includes('\\') || parts.includes('..') || parts[0] !== 'package') {
    fail(`unsafe tar path in ${archive}: ${entry}`);
  }
}
if (entries.filter(entry => entry === 'package/package.json').length !== 1) {
  fail(`archive must contain exactly one package/package.json: ${archive}`);
}

let manifest;
try {
  manifest = JSON.parse(tar(['-xOf', archive, 'package/package.json']));
} catch (error) {
  fail(`invalid package manifest in ${archive}: ${error.message}`);
}
if (manifest.name !== expectedName) fail(`unexpected package name ${String(manifest.name)} in ${archive}`);
if (manifest.version !== expectedVersion) fail(`unexpected package version ${String(manifest.version)} in ${archive}`);
if (manifest.private === true) fail(`published package is private: ${expectedName}`);

for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  const dependencies = manifest[field] ?? {};
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) fail(`${field} must be an object in ${expectedName}`);
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') fail(`invalid ${field} spec for ${name}`);
    if (/^(workspace|file|link):/i.test(spec)) fail(`forbidden publish spec ${spec} for ${name} in ${expectedName}`);
  }
}

const requiredTargets = new Set(['package/package.json']);
const collectTargets = value => {
  if (typeof value === 'string' && value.startsWith('./')) requiredTargets.add(`package/${value.slice(2)}`);
  else if (Array.isArray(value)) value.forEach(collectTargets);
  else if (value && typeof value === 'object') Object.values(value).forEach(collectTargets);
};
collectTargets(manifest.main);
collectTargets(manifest.module);
collectTargets(manifest.types);
collectTargets(manifest.exports);
collectTargets(manifest.dsh?.bundle?.patch);
for (const target of requiredTargets) {
  if (!entries.includes(target)) fail(`manifest target is missing from ${archive}: ${target}`);
}
NODE
}

write_checksums() {
  local directory=$1
  (
    cd "$directory"
    set -- ./*.tgz
    [[ -f "$1" ]] || die "no tarballs were packed in $directory"
    for archive in "$@"; do
      archive=${archive#./}
      printf '%s  %s\n' "$(sha256_file "$archive")" "$archive"
    done | LC_ALL=C sort > SHA256SUMS
  )
}

pack_one() {
  local package_name=$1
  local destination=$2
  local slot=$3
  local isolated="$destination/.pack-$slot"
  mkdir -p "$isolated"
  (
    cd "$repo_root"
    "$pnpm_bin" --filter "$package_name" pack --pack-destination "$isolated"
  )
  set -- "$isolated"/*.tgz
  [[ $# -eq 1 && -f "$1" ]] || die "expected exactly one tarball for $package_name"
  validate_archive "$1" "$package_name"
  local content_hash filename source_filename
  content_hash=$(sha256_file "$1")
  source_filename=$(basename "$1")
  [[ "$source_filename" == *.tgz ]] || die "unexpected archive filename: $source_filename"
  filename="${source_filename%.tgz}-$content_hash.tgz"
  [[ ! -e "$destination/$filename" ]] || die "duplicate archive filename: $filename"
  mv "$1" "$destination/$filename"
  rmdir "$isolated"
}

pack_release() {
  local destination=$1
  mkdir -p "$destination"
  pack_one "$MANAGER_PACKAGE" "$destination" 1
  pack_one "$SELECTOR_PACKAGE" "$destination" 2
  pack_one "$BUNDLE_PACKAGE" "$destination" 3
  set -- "$destination"/*.tgz
  [[ $# -eq 3 && -f "$1" && -f "$2" && -f "$3" ]] || die 'release must contain exactly three tarballs'
  write_checksums "$destination"
}

printf 'Building DSH host plugin...\n'
(cd "$repo_root" && "$pnpm_bin" --filter "$MANAGER_PACKAGE" build)
printf 'Building DSH web selector...\n'
(cd "$repo_root" && "$pnpm_bin" --filter "$SELECTOR_PACKAGE" build)
printf 'Building DSH bundle...\n'
(cd "$repo_root" && "$pnpm_bin" --filter "$BUNDLE_PACKAGE" build)

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/gwm-package-build.XXXXXX")
pack_release "$temporary_root/pass-one"
pack_release "$temporary_root/pass-two"
cmp -s "$temporary_root/pass-one/SHA256SUMS" "$temporary_root/pass-two/SHA256SUMS" || die 'package output is not reproducible across two pack passes'

mkdir -p "$dist_root"
publish_stage=$(mktemp -d "$dist_root/.packages.stage.XXXXXX")
cp "$temporary_root/pass-one/"*.tgz "$temporary_root/pass-one/SHA256SUMS" "$publish_stage/"

if [[ -e "$published_dir" ]]; then
  [[ -d "$published_dir" ]] || die "$published_dir exists and is not a directory"
  publish_backup=$(mktemp -d "$dist_root/.packages.previous.XXXXXX")
  rmdir "$publish_backup"
  mv "$published_dir" "$publish_backup"
fi
if ! mv "$publish_stage" "$published_dir"; then
  [[ -z "$publish_backup" ]] || mv "$publish_backup" "$published_dir"
  publish_backup=''
  die 'failed to publish dist/packages'
fi
publish_stage=''
if [[ -n "$publish_backup" ]]; then
  remove_generated_tree "$publish_backup"
  publish_backup=''
fi

printf 'Published reproducible packages to %s\n' "$published_dir"
