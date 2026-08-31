#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source "$test_dir/testlib.sh"
repo_root=$(cd "$test_dir/../.." && pwd -P)
TEST_REAL_NODE=${TEST_REAL_NODE:-$(command -v node)}
export TEST_REAL_NODE
readonly TEST_CLIENT_URL='http://192.168.50.10:8080'

setup_install_fixture() {
  local sandbox=$1
  mkdir -p "$sandbox/repo/deploy/scripts" "$sandbox/repo/fake-bin"
  cp "$repo_root/deploy/scripts/install-dsh-bundle.sh" "$sandbox/repo/deploy/scripts/install-dsh-bundle.sh"
  cp "$repo_root/deploy/scripts/verify-live.sh" "$sandbox/repo/deploy/scripts/verify-live.sh"
  chmod +x "$sandbox/repo/deploy/scripts/install-dsh-bundle.sh"
  chmod +x "$sandbox/repo/deploy/scripts/verify-live.sh"
  make_artifact_set "$sandbox/repo"
  make_profile_home "$sandbox/dsh-home"
  make_fake_node "$sandbox/repo/fake-bin"
  make_fake_pnpm_version "$sandbox/repo/fake-bin"
  make_fake_dsh "$sandbox/repo/fake-bin"
  : > "$sandbox/dsh.log"
}

run_installer() {
  local sandbox=$1
  shift
  PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/install-dsh-bundle.sh" --dsh-home "$sandbox/dsh-home" "$@"
}

test_client_requires_explicit_manager_url_before_writes() {
  local sandbox output status before
  sandbox=$(mktemp -d /tmp/gwm-install-client-url.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  before=$(filesystem_tree_snapshot "$sandbox/dsh-home")

  set +e
  output=$(run_installer "$sandbox" --role client 2>&1)
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail 'client install without --manager-url must fail'
  assert_contains "$output" '--manager-url is required for role client' 'failure must explain how to provide the Ubuntu manager origin'
  assert_eq "$before" "$(filesystem_tree_snapshot "$sandbox/dsh-home")" 'missing client manager URL must fail before DSH writes'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'missing client manager URL must fail before invoking DSH'
}

wait_for_file() {
  local file=$1
  local message=$2
  local attempt=0
  while [[ ! -e "$file" && $attempt -lt 500 ]]; do
    attempt=$((attempt + 1))
    sleep 0.01
  done
  [[ -e "$file" ]] || fail "$message"
}

assert_installed_profile() {
  local manifest=$1
  local dsh_home=$2
  local store_prefix="file:$dsh_home/.gpu-workload-manager/packages/"
  assert_eq 2.0.0 "$(json_eval "$manifest" "data.dependencies['@example/preserved']")" 'unrelated dependency must survive'
  assert_contains "$(json_eval "$manifest" "data.dependencies['@local/dsh-gpu-workload-manager']")" "$store_prefix" 'manager must use the persistent content-addressed store'
  assert_contains "$(json_eval "$manifest" "data.dependencies['@local/dsh-gpu-model-selection']")" "$store_prefix" 'selector must use the persistent content-addressed store'
  assert_contains "$(json_eval "$manifest" "data.dependencies['@local/dsh-gpu-workload-bundle']")" "$store_prefix" 'bundle must use the persistent content-addressed store'
  assert_eq 1 "$(json_eval "$manifest" "data.dsh.profile.bundles.filter(value => value === '@local/dsh-gpu-workload-bundle').length")" 'bundle list must contain exactly one local bundle'
  assert_eq false "$(json_eval "$manifest" "data.dsh.profile.bundles.includes('@local/dsh-gpu-workload-manager')")" 'manager plugin must not be listed as a bundle'
  assert_eq false "$(json_eval "$manifest" "data.dsh.profile.bundles.includes('@local/dsh-gpu-model-selection')")" 'selector plugin must not be listed as a bundle'
}

test_installs_both_profiles_idempotently() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-install-test.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  printf 'UNRELATED_ONE=alpha\r\n# preserve trailing spaces  \r\n' > "$sandbox/dsh-home/.env"
  chmod 640 "$sandbox/dsh-home/.env"
  local web_mode_before headless_mode_before
  web_mode_before=$(stat -c '%a' "$sandbox/dsh-home/profiles/web/package.json")
  headless_mode_before=$(stat -c '%a' "$sandbox/dsh-home/profiles/headless/package.json")
  run_installer "$sandbox" --role client --manager-url http://192.168.50.10:8080

  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
  assert_installed_profile "$sandbox/dsh-home/profiles/headless/package.json" "$sandbox/dsh-home"
  assert_eq 3 "$(find "$sandbox/dsh-home/.gpu-workload-manager/packages" -type f -name '*.tgz' | wc -l | tr -d ' ')" 'the persistent store must contain exactly the verified release archives'
  assert_eq preserved-web "$(<"$sandbox/dsh-home/profiles/web/cordis.patch.yml")" 'web user patch must survive'
  assert_eq preserved-headless "$(<"$sandbox/dsh-home/profiles/headless/cordis.patch.yml")" 'headless user patch must survive'
  assert_eq "$web_mode_before" "$(stat -c '%a' "$sandbox/dsh-home/profiles/web/package.json")" 'web manifest mode must be preserved'
  assert_eq "$headless_mode_before" "$(stat -c '%a' "$sandbox/dsh-home/profiles/headless/package.json")" 'headless manifest mode must be preserved'
  assert_no_file "$sandbox/dsh-home/gpu-workload-manager.env"
  assert_eq 640 "$(stat -c '%a' "$sandbox/dsh-home/.env")" 'existing layered-env mode must be preserved'
  "$TEST_REAL_NODE" - "$sandbox/dsh-home/.env" <<'NODE'
const fs = require('node:fs');
const actual = fs.readFileSync(process.argv[2]);
const expected = Buffer.from(
  'UNRELATED_ONE=alpha\r\n# preserve trailing spaces  \r\n'
  + '# >>> GPU Workload Manager (managed by install-dsh-bundle.sh) >>>\r\n'
  + 'GPU_WORKLOAD_ROLE=client\r\n'
  + 'GPU_WORKLOAD_MANAGER_URL=http://192.168.50.10:8080\r\n'
  + '# <<< GPU Workload Manager (managed by install-dsh-bundle.sh) <<<\r\n',
);
if (!actual.equals(expected)) process.exit(1);
NODE

  local web_before headless_before env_before env_inode_before
  web_before=$(<"$sandbox/dsh-home/profiles/web/package.json")
  headless_before=$(<"$sandbox/dsh-home/profiles/headless/package.json")
  env_before=$(<"$sandbox/dsh-home/.env")
  env_inode_before=$(stat -c '%i' "$sandbox/dsh-home/.env")
  run_installer "$sandbox" --role client --manager-url http://192.168.50.10:8080
  assert_eq "$web_before" "$(<"$sandbox/dsh-home/profiles/web/package.json")" 'second run must not rewrite the web manifest'
  assert_eq "$headless_before" "$(<"$sandbox/dsh-home/profiles/headless/package.json")" 'second run must not rewrite the headless manifest'
  assert_eq "$env_before" "$(<"$sandbox/dsh-home/.env")" 'second run must preserve layered-env content'
  assert_eq "$env_inode_before" "$(stat -c '%i' "$sandbox/dsh-home/.env")" 'second run must not replace an unchanged layered-env file'
  assert_eq 4 "$(grep -c '^add ' "$sandbox/dsh.log")" 'each run must verify or repair both profiles from immutable tarballs'
  assert_eq 4 "$(grep -c '^dump ' "$sandbox/dsh.log")" 'both profiles must be composition-validated on every run'
  assert_eq 4 "$(grep -c ' source=home-env$' "$sandbox/dsh.log")" 'dump validation must consume ordinary DSH layered-env configuration'
}

test_rerun_from_relocated_source_uses_persistent_archives() {
  local sandbox relocated web_before headless_before
  sandbox=$(mktemp -d /tmp/gwm-install-relocated.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  run_installer "$sandbox" --role client --manager-url "$TEST_CLIENT_URL"
  web_before=$(<"$sandbox/dsh-home/profiles/web/package.json")
  headless_before=$(<"$sandbox/dsh-home/profiles/headless/package.json")

  relocated="$sandbox/relocated"
  mkdir -p "$relocated"
  cp -R "$sandbox/repo" "$relocated/repo"
  find "$sandbox/repo" -depth -delete
  PATH="$relocated/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$relocated/repo/deploy/scripts/install-dsh-bundle.sh" \
      --dsh-home "$sandbox/dsh-home" --role client --manager-url "$TEST_CLIENT_URL"

  assert_eq "$web_before" "$(<"$sandbox/dsh-home/profiles/web/package.json")" 'relocating the release source must not rewrite the web dependency specs'
  assert_eq "$headless_before" "$(<"$sandbox/dsh-home/profiles/headless/package.json")" 'relocating the release source must not rewrite the headless dependency specs'
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
  assert_installed_profile "$sandbox/dsh-home/profiles/headless/package.json" "$sandbox/dsh-home"
}

test_real_layered_env_loader_reads_managed_values() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-install-real-env.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  run_installer "$sandbox" --role server
  assert_eq 600 "$(stat -c '%a' "$sandbox/dsh-home/.env")" 'new layered-env file must be private'
  mkdir -p "$sandbox/invocation"
  (
    cd "$repo_root/packages/bundle"
    "$TEST_REAL_NODE" --input-type=module - "$sandbox/dsh-home" "$sandbox/invocation" <<'NODE'
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [home, cwd] = process.argv.slice(2);
process.env.DSH_HOME = home;
delete process.env.GPU_WORKLOAD_ROLE;
delete process.env.GPU_WORKLOAD_MANAGER_URL;
const require = createRequire(resolve('package.json'));
const runtime = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
runtime.loadLayeredEnv('dsh', cwd, () => {});
if (process.env.GPU_WORKLOAD_ROLE !== 'server') process.exit(1);
if (process.env.GPU_WORKLOAD_MANAGER_URL !== 'http://127.0.0.1:8080') process.exit(2);
NODE
  )
}

test_live_verifier_matches_installer_contract_and_composition() {
  local sandbox output status
  sandbox=$(mktemp -d /tmp/gwm-install-live-verify.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  printf 'PRESERVED=yes\r\n' >"$sandbox/dsh-home/.env"
  chmod 640 "$sandbox/dsh-home/.env"
  ln -s "$sandbox/dsh-home" "$sandbox/dsh-link"

  run_installer "$sandbox" --role client --manager-url http://192.168.50.10:8080/
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role mac \
      --dsh-home "$sandbox/dsh-link" --manager-url http://192.168.50.10:8080/ --dsh-only 2>&1)
  assert_contains "$output" 'PASS  dsh_same_bundle_role' 'Mac verifier must accept the client role, canonical URL, CRLF env, symlinked home, and persistent store'
  assert_contains "$output" 'LIVE VERIFICATION: PASS role=mac scope=dsh-only' 'Mac DSH-only verification must pass'

  run_installer "$sandbox" --role server
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  assert_contains "$output" 'LIVE VERIFICATION: PASS role=ubuntu scope=dsh-only' 'Ubuntu verifier must map to the server role'

  printf '%s\n' \
    'process.getuid = () => 0;' \
    'process.getgid = () => 0;' \
    > "$sandbox/pretend-root.cjs"
  set +e
  output=$(NODE_OPTIONS="--require=$sandbox/pretend-root.cjs" \
    PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    printf 'owner-relative verifier output:\n%s\n' "$output" >&2
    fail 'canonical DSH-home ownership must not depend on the verifier process UID'
  fi
  assert_contains "$output" 'PASS  dsh_same_bundle_role' 'payload ownership must be compared with the canonical DSH home owner instead of the verifier process UID'

  printf 'tampered\n' >> "$sandbox/dsh-home/profiles/web/node_modules/@local/dsh-gpu-workload-manager/lib/index.js"
  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'verifier must reject modified installed package content'
  assert_contains "$output" 'FAIL  dsh_same_bundle_role' 'payload hash rejection must identify the DSH bundle gate'
  run_installer "$sandbox" --role server

  printf 'unexpected\n' > "$sandbox/dsh-home/profiles/headless/node_modules/@local/dsh-gpu-model-selection/unexpected.js"
  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'verifier must reject unexpected installed package files'
  assert_contains "$output" 'FAIL  dsh_same_bundle_role' 'unexpected-file rejection must identify the DSH bundle gate'
  run_installer "$sandbox" --role server

  rm "$sandbox/dsh-home/profiles/web/node_modules/@local/dsh-gpu-workload-bundle/lib/index.js"
  ln -s /dev/null "$sandbox/dsh-home/profiles/web/node_modules/@local/dsh-gpu-workload-bundle/lib/index.js"
  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'verifier must reject symlinks inside installed package payloads'
  assert_contains "$output" 'FAIL  dsh_same_bundle_role' 'payload symlink rejection must identify the DSH bundle gate'
  run_installer "$sandbox" --role server

  mv "$sandbox/dsh-home/profiles/web/node_modules" "$sandbox/dsh-home/profiles/web/node_modules-real"
  ln -s node_modules-real "$sandbox/dsh-home/profiles/web/node_modules"
  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'verifier must reject a profile whose whole node_modules root is a symlink'
  assert_contains "$output" 'FAIL  dsh_same_bundle_role' 'node_modules-root symlink rejection must identify the DSH bundle gate'
  rm "$sandbox/dsh-home/profiles/web/node_modules"
  mv "$sandbox/dsh-home/profiles/web/node_modules-real" "$sandbox/dsh-home/profiles/web/node_modules"

  mv "$sandbox/dsh-home/.env" "$sandbox/dsh-home/.env-real"
  ln -s .env-real "$sandbox/dsh-home/.env"
  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'verifier must reject a symlinked DSH .env file'
  assert_contains "$output" 'FAIL  dsh_same_bundle_role' 'DSH .env symlink rejection must identify the bundle gate'
  rm "$sandbox/dsh-home/.env"
  mv "$sandbox/dsh-home/.env-real" "$sandbox/dsh-home/.env"

  mv "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home/profiles/web/package.json-real"
  ln -s package.json-real "$sandbox/dsh-home/profiles/web/package.json"
  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'verifier must reject a symlinked DSH profile manifest'
  assert_contains "$output" 'FAIL  dsh_same_bundle_role' 'profile manifest symlink rejection must identify the bundle gate'
  rm "$sandbox/dsh-home/profiles/web/package.json"
  mv "$sandbox/dsh-home/profiles/web/package.json-real" "$sandbox/dsh-home/profiles/web/package.json"

  ln -s "$sandbox/dsh-home/.gpu-workload-manager/packages" "$sandbox/dsh-home/archive-store-alias"
  cp -p "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/web.package.json-real"
  "$TEST_REAL_NODE" - "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home/archive-store-alias" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [manifestPath, alias] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const name = '@local/dsh-gpu-workload-manager';
manifest.dependencies[name] = `file:${path.join(alias, path.basename(manifest.dependencies[name].slice('file:'.length)))}`;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'verifier must reject a file dependency reached through a symlinked store path'
  assert_contains "$output" 'FAIL  dsh_same_bundle_role' 'archive input symlink rejection must identify the bundle gate'
  mv "$sandbox/web.package.json-real" "$sandbox/dsh-home/profiles/web/package.json"
  rm "$sandbox/dsh-home/archive-store-alias"

  cp -p "$sandbox/dsh-home/.env" "$sandbox/server.env"
  printf 'export GPU_WORKLOAD_ROLE=client\r\n' >>"$sandbox/dsh-home/.env"
  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'verifier must reject an unmanaged role override outside the managed block'
  assert_contains "$output" 'FAIL  dsh_same_bundle_role' 'unmanaged override rejection must identify the DSH bundle gate'
  mv "$sandbox/server.env" "$sandbox/dsh-home/.env"

  set +e
  output=$(PATH="$sandbox/repo/fake-bin:$PATH" \
    FAKE_DSH_LOG="$sandbox/dsh.log" FAKE_DSH_DISABLE_MANAGER_PROFILE=headless \
    "$sandbox/repo/deploy/scripts/verify-live.sh" --role ubuntu \
      --dsh-home "$sandbox/dsh-link" --dsh-only 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'verifier must reject a disabled manager in actual DSH composition'
  assert_contains "$output" 'FAIL  dsh_same_bundle_role' 'composition rejection must identify the DSH bundle gate'
}

test_dump_validation_ignores_invoking_directory_env() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-install-project-env.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  mkdir -p "$sandbox/project"
  printf '%s\n' \
    'GPU_WORKLOAD_ROLE=client' \
    'GPU_WORKLOAD_MANAGER_URL=http://192.168.3.77:8080' > "$sandbox/project/.env"
  (
    cd "$sandbox/project"
    run_installer "$sandbox" --role server
  )
  assert_eq 2 "$(grep -c 'dump .* server http://127.0.0.1:8080 source=home-env$' "$sandbox/dsh.log")" 'validation must run from an empty cwd and consume the home layer'
  [[ "$(<"$sandbox/dsh.log")" != *'192.168.3.77'* ]] || fail 'invoking-directory .env must not shadow installer validation'
}

test_rejects_unmanaged_or_duplicate_layered_env_keys_without_logging_values() {
  local sandbox output status before
  sandbox=$(mktemp -d /tmp/gwm-install-env-conflict.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  printf 'PRESERVE=yes\nGPU_WORKLOAD_MANAGER_URL=do-not-log-this\n' > "$sandbox/dsh-home/.env"
  before=$(<"$sandbox/dsh-home/.env")
  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an unmanaged GPU workload key must be rejected'
  assert_contains "$output" 'unmanaged GPU_WORKLOAD_MANAGER_URL definition' 'failure must identify only the conflicting key'
  [[ "$output" != *'do-not-log-this'* ]] || fail 'failure must not log layered-env values'
  assert_eq "$before" "$(<"$sandbox/dsh-home/.env")" 'env conflict must preserve every existing byte'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'env conflict must precede DSH calls'

  cleanup_tree "$sandbox"
  sandbox=$(mktemp -d /tmp/gwm-install-env-duplicate.XXXXXX)
  setup_install_fixture "$sandbox"
  printf '%s\n' \
    '# >>> GPU Workload Manager (managed by install-dsh-bundle.sh) >>>' \
    'GPU_WORKLOAD_ROLE=client' \
    'GPU_WORKLOAD_MANAGER_URL=http://192.168.50.10:8080' \
    '# <<< GPU Workload Manager (managed by install-dsh-bundle.sh) <<<' \
    '# >>> GPU Workload Manager (managed by install-dsh-bundle.sh) >>>' \
    'GPU_WORKLOAD_ROLE=client' \
    'GPU_WORKLOAD_MANAGER_URL=http://192.168.50.10:8080' \
    '# <<< GPU Workload Manager (managed by install-dsh-bundle.sh) <<<' > "$sandbox/dsh-home/.env"
  set +e
  output=$(run_installer "$sandbox" --role client --manager-url "$TEST_CLIENT_URL" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'duplicate managed blocks must be rejected'
  assert_contains "$output" 'duplicate or malformed managed block'
}

test_repairs_missing_installed_package_directories() {
  local sandbox manager_dir selector_dir
  sandbox=$(mktemp -d /tmp/gwm-install-repair.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  run_installer "$sandbox" --role client --manager-url "$TEST_CLIENT_URL"
  manager_dir="$sandbox/dsh-home/profiles/web/node_modules/@local/dsh-gpu-workload-manager"
  selector_dir="$sandbox/dsh-home/profiles/web/node_modules/@local/dsh-gpu-model-selection"
  assert_file "$manager_dir/package.json"
  assert_file "$selector_dir/package.json"
  find "$manager_dir" -depth -delete
  find "$selector_dir" -depth -delete
  run_installer "$sandbox" --role client --manager-url "$TEST_CLIENT_URL"
  assert_file "$manager_dir/package.json"
  assert_file "$manager_dir/lib/index.js"
  assert_file "$selector_dir/package.json"
  assert_file "$selector_dir/lib/client.js"
}

test_fails_closed_when_same_version_archive_bytes_change() {
  local sandbox old_archive old_filename new_hash new_filename packages_dir output status rebuilt_root rebuilt_archive
  sandbox=$(mktemp -d /tmp/gwm-install-immutable.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  run_installer "$sandbox" --role client --manager-url "$TEST_CLIENT_URL"
  packages_dir="$sandbox/repo/dist/packages"
  old_archive=$(find_fixture_archive "$packages_dir" '@local/dsh-gpu-workload-manager')
  old_filename=$(basename "$old_archive")
  rebuilt_root="$sandbox/rebuilt-manager"
  rebuilt_archive="$sandbox/rebuilt-manager.tgz"
  mkdir -p "$rebuilt_root"
  tar -xzf "$old_archive" -C "$rebuilt_root"
  printf 'export const rebuilt = true;\n' >> "$rebuilt_root/package/lib/index.js"
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -czf "$rebuilt_archive" -C "$rebuilt_root" package
  new_hash=$(sha256sum "$rebuilt_archive" | awk '{print $1}')
  new_filename=$(printf '%s' "$old_filename" | sed -E "s/-[0-9a-f]{64}\\.tgz$/-$new_hash.tgz/")
  mv "$old_archive" "$sandbox/old-manager.tgz"
  mv "$rebuilt_archive" "$packages_dir/$new_filename"
  (
    cd "$packages_dir"
    for archive in *.tgz; do
      printf '%s  %s\n' "$(sha256sum "$archive" | awk '{print $1}')" "$archive"
    done | LC_ALL=C sort > SHA256SUMS.next
    mv SHA256SUMS.next SHA256SUMS
  )
  set +e
  output=$(run_installer "$sandbox" --role client --manager-url "$TEST_CLIENT_URL" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'same-version archives with different bytes must not replace an installed immutable spec'
  assert_contains "$output" 'conflicting dependency' 'immutable artifact mismatch must fail closed at dependency preflight'
  assert_eq 2 "$(grep -c '^add ' "$sandbox/dsh.log")" 'immutable conflict must precede package writes'
}

test_rejects_disabled_manager_in_either_profile() {
  local profile sandbox output status
  for profile in web headless; do
    sandbox=$(mktemp -d /tmp/gwm-install-disabled.XXXXXX)
    setup_install_fixture "$sandbox"
    set +e
    output=$(FAKE_DSH_DISABLE_MANAGER_PROFILE="$profile" run_installer "$sandbox" --role server 2>&1)
    status=$?
    set -e
    [[ $status -ne 0 ]] || fail "disabled manager must fail $profile validation"
    assert_contains "$output" "$profile profile composition validation failed"
    assert_no_file "$sandbox/dsh-home/.env"
    cleanup_tree "$sandbox"
  done
}

test_rejects_checksum_tampering_before_writes() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-install-checksum.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  local selector_archive
  selector_archive=$(find_fixture_archive "$sandbox/repo/dist/packages" '@local/dsh-gpu-model-selection')
  printf 'tampered\n' >> "$selector_archive"
  local before output status
  before=$(<"$sandbox/dsh-home/profiles/web/package.json")
  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'tampered archive must be rejected'
  assert_contains "$output" 'checksum' 'failure must identify checksum validation'
  assert_eq "$before" "$(<"$sandbox/dsh-home/profiles/web/package.json")" 'checksum failure must precede profile writes'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'checksum failure must precede DSH calls'
}

test_rejects_conflicting_dependency_before_writes() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-install-conflict.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  "$TEST_REAL_NODE" - "$sandbox/dsh-home/profiles/web/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.dependencies['@local/dsh-gpu-workload-manager'] = '0.0.9';
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
  local headless_before output status
  headless_before=$(<"$sandbox/dsh-home/profiles/headless/package.json")
  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'conflicting dependency spec must be rejected'
  assert_contains "$output" 'conflicting dependency' 'failure must identify the manifest conflict'
  assert_eq "$headless_before" "$(<"$sandbox/dsh-home/profiles/headless/package.json")" 'conflict preflight must be transactional across profiles'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'conflict must be detected before DSH calls'
}

test_rejects_role_incompatible_manager_urls_before_writes() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-install-url.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  local before output status candidate
  before=$(<"$sandbox/dsh-home/profiles/web/package.json")
  for candidate in \
    'server|http://192.168.50.10:8080' \
    'client|https://192.168.50.10:8080' \
    'client|http://203.0.113.10:8080'; do
    set +e
    output=$(run_installer "$sandbox" --role "${candidate%%|*}" --manager-url "${candidate#*|}" 2>&1)
    status=$?
    set -e
    [[ $status -ne 0 ]] || fail "role-incompatible manager URL must be rejected: $candidate"
    assert_contains "$output" 'manager-url' 'failure must identify the invalid manager URL'
  done
  assert_eq "$before" "$(<"$sandbox/dsh-home/profiles/web/package.json")" 'URL failure must precede profile writes'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'URL failure must precede DSH calls'
}

test_acquires_install_lock_before_reading_profile_state() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-install-lock.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  mkdir "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  "$TEST_REAL_NODE" - "$sandbox/dsh-home/.gpu-workload-manager-install.lock/owner.json" "$$" <<'NODE'
const cp = require('node:child_process');
const fs = require('node:fs');
const [file, rawPid] = process.argv.slice(2);
const pid = Number(rawPid);
const start = cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
  encoding: 'utf8',
  env: { LC_ALL: 'C' },
}).trim();
fs.writeFileSync(file, `${JSON.stringify({ version: 1, pid, start, token: 'test-active-owner' })}\n`, { mode: 0o600 });
NODE
  "$TEST_REAL_NODE" - "$sandbox/dsh-home/profiles/web/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.dependencies['@local/dsh-gpu-workload-manager'] = '0.0.9';
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
  local output status
  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'an existing installation lock must reject a second installer'
  assert_contains "$output" 'another GPU Workload Manager installation is active' 'lock must be checked before mutable profile state'
  [[ "$output" != *'conflicting dependency'* ]] || fail 'profile state must not be inspected before acquiring the lock'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'locked installer must not call DSH'
}

test_rejects_empty_legacy_install_lock() {
  local sandbox legacy_pid output status legacy_alive lock_preserved
  sandbox=$(mktemp -d /tmp/gwm-install-legacy-lock.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"

  (
    mkdir "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
    : > "$sandbox/legacy-ready"
    legacy_attempt=0
    while [[ ! -e "$sandbox/legacy-release" && $legacy_attempt -lt 1000 ]]; do
      legacy_attempt=$((legacy_attempt + 1))
      sleep 0.01
    done
    rmdir "$sandbox/dsh-home/.gpu-workload-manager-install.lock" 2>/dev/null || true
  ) &
  legacy_pid=$!
  wait_for_file "$sandbox/legacy-ready" 'legacy installer did not publish its empty canonical lock'

  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  legacy_alive=0
  kill -0 "$legacy_pid" 2>/dev/null && legacy_alive=1
  lock_preserved=0
  [[ -d "$sandbox/dsh-home/.gpu-workload-manager-install.lock" ]] && lock_preserved=1
  : > "$sandbox/legacy-release"
  wait "$legacy_pid"

  [[ $status -ne 0 ]] || fail 'an empty canonical lock must not be reclaimed because a legacy installer may own it'
  assert_contains "$output" 'unsafe or unverifiable GPU Workload Manager installation lock'
  assert_eq 1 "$legacy_alive" 'the legacy lock holder must remain alive while the new installer refuses its lock'
  assert_eq 1 "$lock_preserved" 'the new installer must not move or remove a legacy empty lock'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'an unverifiable legacy lock must be rejected before DSH calls'
}

test_rejects_dead_legacy_owner_without_process_group_proof() {
  local sandbox output status lock_before
  sandbox=$(mktemp -d /tmp/gwm-install-dead-legacy-lock.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  mkdir "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  "$TEST_REAL_NODE" - "$sandbox/dsh-home/.gpu-workload-manager-install.lock/owner.json" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], `${JSON.stringify({
  version: 1,
  pid: 99999999,
  start: 'legacy owner start identity',
  token: 'dead-legacy-owner',
})}\n`, { mode: 0o600 });
NODE
  lock_before=$(filesystem_tree_snapshot "$sandbox/dsh-home/.gpu-workload-manager-install.lock")

  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail 'a dead legacy v1 owner must fail closed because it has no isolated process-group proof'
  assert_contains "$output" 'unsafe or unverifiable GPU Workload Manager installation lock'
  assert_eq "$lock_before" "$(filesystem_tree_snapshot "$sandbox/dsh-home/.gpu-workload-manager-install.lock")" 'a dead legacy v1 lock must remain untouched for manual inspection'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'a dead legacy v1 lock must be rejected before DSH calls'
}

test_atomic_lock_claim_does_not_replace_late_legacy_lock() {
  local sandbox installer_pid installer_status output
  sandbox=$(mktemp -d /tmp/gwm-install-legacy-claim-race.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"

  (
    FAKE_NODE_PAUSE_ACTION=lock-acquire-claim \
      FAKE_NODE_PAUSE_READY="$sandbox/claim-ready" \
      FAKE_NODE_PAUSE_RELEASE="$sandbox/claim-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/installer.out" 2>&1 &
  installer_pid=$!
  wait_for_file "$sandbox/claim-ready" 'new installer did not pause immediately before its canonical lock claim'
  mkdir "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  : > "$sandbox/claim-release"
  set +e
  wait "$installer_pid"
  installer_status=$?
  set -e
  output=$(<"$sandbox/installer.out")

  [[ $installer_status -ne 0 ]] || fail 'a late legacy mkdir must win the canonical no-replace claim'
  assert_contains "$output" 'unsafe or unverifiable GPU Workload Manager installation lock'
  [[ -d "$sandbox/dsh-home/.gpu-workload-manager-install.lock" ]] || fail 'the late legacy canonical lock must remain in place'
  assert_eq '' "$(find "$sandbox/dsh-home/.gpu-workload-manager-install.lock" -mindepth 1 -maxdepth 1 -print -quit)" 'the new installer must not move into or populate the legacy empty lock'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'the losing installer must not call DSH'
}

test_sigkill_before_and_after_file_lock_claim_recovers_on_retry() {
  local sandbox launcher_pid owner_temp owner_pid paused_node_pid status
  sandbox=$(mktemp -d /tmp/gwm-install-file-claim-kill.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"

  (
    FAKE_NODE_PAUSE_ACTION=lock-acquire-claim \
      FAKE_NODE_PAUSE_READY="$sandbox/preclaim-ready" \
      FAKE_NODE_PAUSE_RELEASE="$sandbox/preclaim-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/preclaim.out" 2>&1 &
  launcher_pid=$!
  wait_for_file "$sandbox/preclaim-ready" 'installer did not pause before its regular-file lock claim'
  owner_temp=$(find "$sandbox/dsh-home" -maxdepth 1 -type f \
    -name '.gpu-workload-manager-install.owner-*-*-*.tmp' -print -quit)
  [[ -n "$owner_temp" ]] || fail 'pre-claim SIGKILL fixture must expose the durable owner temporary'
  owner_pid=${owner_temp##*/.gpu-workload-manager-install.owner-}
  owner_pid=${owner_pid%%-*}
  paused_node_pid=$(<"$sandbox/preclaim-ready")
  kill -9 "$owner_pid" "$paused_node_pid" 2>/dev/null || true
  set +e
  wait "$launcher_pid"
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'pre-claim fault injector must SIGKILL the installer'
  assert_file "$owner_temp"
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"

  run_installer "$sandbox" --role server >/dev/null
  assert_no_file "$owner_temp"

  (
    FAKE_NODE_PAUSE_ACTION=lock-acquire-finalize \
      FAKE_NODE_PAUSE_READY="$sandbox/postclaim-ready" \
      FAKE_NODE_PAUSE_RELEASE="$sandbox/postclaim-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/postclaim.out" 2>&1 &
  launcher_pid=$!
  wait_for_file "$sandbox/postclaim-ready" 'installer did not pause after hard-linking its regular canonical lock'
  owner_temp=$(find "$sandbox/dsh-home" -maxdepth 1 -type f \
    -name '.gpu-workload-manager-install.owner-*-*-*.tmp' -print -quit)
  [[ -n "$owner_temp" ]] || fail 'post-claim SIGKILL fixture must retain the linked owner temporary'
  assert_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  assert_eq "$(stat -c '%i' "$owner_temp")" "$(stat -c '%i' "$sandbox/dsh-home/.gpu-workload-manager-install.lock")" 'canonical claim and owner temporary must be hard links to one fsynced record'
  owner_pid=${owner_temp##*/.gpu-workload-manager-install.owner-}
  owner_pid=${owner_pid%%-*}
  paused_node_pid=$(<"$sandbox/postclaim-ready")
  kill -9 "$owner_pid" "$paused_node_pid" 2>/dev/null || true
  set +e
  wait "$launcher_pid"
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'post-claim fault injector must SIGKILL the installer'

  run_installer "$sandbox" --role server >/dev/null
  assert_no_file "$owner_temp"
  assert_installed_profile "$sandbox/dsh-home/profiles/headless/package.json" "$sandbox/dsh-home"
}

test_sigkill_stale_file_fence_is_completed_on_retry() {
  local sandbox launcher_pid owner_temp owner_pid paused_node_pid status tombstone
  sandbox=$(mktemp -d /tmp/gwm-install-file-fence-kill.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  "$TEST_REAL_NODE" - "$sandbox/dsh-home/.gpu-workload-manager-install.lock" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], `${JSON.stringify({
  version: 2,
  pid: 99999999,
  start: 'stale',
  pgid: 99999999,
  token: '00000000000000000000000000000000',
})}\n`, { mode: 0o600 });
NODE
  tombstone="$sandbox/dsh-home/.gpu-workload-manager-install.lock.stale-00000000000000000000000000000000-tombstone"

  (
    FAKE_NODE_PAUSE_ACTION=stale-lock-canonical-unlink \
      FAKE_NODE_PAUSE_READY="$sandbox/fence-ready" \
      FAKE_NODE_PAUSE_RELEASE="$sandbox/fence-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/fence.out" 2>&1 &
  launcher_pid=$!
  wait_for_file "$sandbox/fence-ready" 'installer did not pause after hard-link fencing the stale regular lock'
  assert_file "$tombstone"
  assert_eq "$(stat -c '%i' "$tombstone")" "$(stat -c '%i' "$sandbox/dsh-home/.gpu-workload-manager-install.lock")" 'stale canonical and permanent tombstone must share an inode before unlink'
  owner_temp=$(find "$sandbox/dsh-home" -maxdepth 1 -type f \
    -name '.gpu-workload-manager-install.owner-*-*-*.tmp' -print -quit)
  owner_pid=${owner_temp##*/.gpu-workload-manager-install.owner-}
  owner_pid=${owner_pid%%-*}
  paused_node_pid=$(<"$sandbox/fence-ready")
  kill -9 "$owner_pid" "$paused_node_pid" 2>/dev/null || true
  set +e
  wait "$launcher_pid"
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'stale-fence fault injector must SIGKILL the installer'

  run_installer "$sandbox" --role server >/dev/null
  assert_file "$tombstone"
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
}

test_recovers_crossed_claim_and_stale_fence_sigkills() {
  local sandbox a_launcher a_owner_temp a_owner_pid a_node_pid a_status
  local b_launcher b_owner_temp b_owner_pid b_node_pid b_status tombstone token
  local inode output status
  sandbox=$(mktemp -d /tmp/gwm-install-crossed-lock-kills.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"

  (
    FAKE_NODE_PAUSE_ACTION=lock-acquire-finalize \
      FAKE_NODE_PAUSE_READY="$sandbox/a-ready" \
      FAKE_NODE_PAUSE_RELEASE="$sandbox/a-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/a.out" 2>&1 &
  a_launcher=$!
  wait_for_file "$sandbox/a-ready" 'installer A did not pause after hard-linking its canonical claim'
  a_owner_temp=$(find "$sandbox/dsh-home" -maxdepth 1 -type f \
    -name '.gpu-workload-manager-install.owner-*-*-*.tmp' -print -quit)
  [[ -n "$a_owner_temp" ]] || fail 'installer A must retain its hard-linked owner temporary'
  a_owner_pid=$(json_eval "$sandbox/dsh-home/.gpu-workload-manager-install.lock" 'data.pid')
  a_node_pid=$(<"$sandbox/a-ready")
  kill -9 "$a_owner_pid"
  set +e
  wait "$a_launcher"
  a_status=$?
  set -e
  [[ $a_status -ne 0 ]] || fail 'installer A leader-only SIGKILL must fail its launcher'
  kill -0 "$a_node_pid" 2>/dev/null || fail 'installer A paused child must survive its group leader'
  assert_eq 2 "$(stat -c '%h' "$a_owner_temp")" 'installer A temporary and canonical lock must initially be the only two links'

  (
    FAKE_NODE_PAUSE_ACTION=stale-lock-canonical-unlink \
      FAKE_NODE_PAUSE_READY="$sandbox/b-ready" \
      FAKE_NODE_PAUSE_RELEASE="$sandbox/b-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/b.out" 2>&1 &
  b_launcher=$!
  wait_for_file "$sandbox/b-ready" 'installer B did not pause after fencing installer A stale lock'
  b_node_pid=$(<"$sandbox/b-ready")
  b_owner_pid=$(/bin/ps -p "$b_node_pid" -o pgid= | tr -d '[:space:]')
  [[ "$b_owner_pid" =~ ^[0-9]+$ ]] || fail 'installer B paused node must expose its isolated owner PGID'
  b_owner_temp=$(find "$sandbox/dsh-home" -maxdepth 1 -type f \
    -name ".gpu-workload-manager-install.owner-$b_owner_pid-*-*.tmp" -print -quit)
  [[ -n "$b_owner_temp" ]] || fail 'installer B must retain its unclaimed owner temporary'
  token=$(json_eval "$sandbox/dsh-home/.gpu-workload-manager-install.lock" 'data.token')
  tombstone="$sandbox/dsh-home/.gpu-workload-manager-install.lock.stale-$token-tombstone"
  assert_file "$tombstone"
  inode=$(stat -c '%i' "$a_owner_temp")
  assert_eq "$inode" "$(stat -c '%i' "$sandbox/dsh-home/.gpu-workload-manager-install.lock")" 'installer A temporary and canonical must still share one inode'
  assert_eq "$inode" "$(stat -c '%i' "$tombstone")" 'installer B fence must be a third link to installer A owner record'
  assert_eq 3 "$(stat -c '%h' "$a_owner_temp")" 'the crossed interruption fixture must reach the three-link recovery state'

  kill -9 "$b_owner_pid" "$b_node_pid" 2>/dev/null || true
  set +e
  wait "$b_launcher"
  b_status=$?
  set -e
  [[ $b_status -ne 0 ]] || fail 'installer B SIGKILL must fail its launcher before canonical unlink'

  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    printf 'crossed-lock retry output:\n%s\n' "$output" >&2
    fail 'installer C must recover the valid temp+canonical+tombstone three-link state'
  fi
  assert_no_file "$a_owner_temp"
  assert_no_file "$b_owner_temp"
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  assert_file "$tombstone"
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
  assert_installed_profile "$sandbox/dsh-home/profiles/headless/package.json" "$sandbox/dsh-home"
}

test_rejects_unexpected_three_link_owner_temporary() {
  local sandbox start digest token owner_temp unexpected output status
  sandbox=$(mktemp -d /tmp/gwm-install-unexpected-three-links.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  start='stale unexpected owner identity'
  digest=$("$TEST_REAL_NODE" -e "process.stdout.write(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$start")
  token='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  owner_temp="$sandbox/dsh-home/.gpu-workload-manager-install.owner-99999999-$digest-$token.tmp"
  unexpected="$sandbox/dsh-home/unexpected-owner-hardlink"
  "$TEST_REAL_NODE" - "$owner_temp" "$start" "$token" <<'NODE'
const fs = require('node:fs');
const [file, start, token] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  version: 2,
  pid: 99999999,
  start,
  pgid: 99999999,
  token,
})}\n`, { mode: 0o600 });
NODE
  ln "$owner_temp" "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  ln "$owner_temp" "$unexpected"
  assert_eq 3 "$(stat -c '%h' "$owner_temp")" 'negative fixture must expose an unexpected third hard link'

  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail 'an unexplained owner-record third link must fail closed'
  assert_contains "$output" 'unsafe or unverifiable GPU Workload Manager installation lock'
  assert_file "$owner_temp"
  assert_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  assert_file "$unexpected"
  assert_eq 3 "$(stat -c '%h' "$owner_temp")" 'fail-closed GC must preserve every unexplained owner-record link'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'an unexplained link must be rejected before DSH calls'
}

test_orphan_dsh_process_group_is_quiesced_before_recovery() {
  local sandbox before launcher_pid owner_pid child_pid launcher_status output status child_state
  sandbox=$(mktemp -d /tmp/gwm-install-orphan-dsh-group.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  before=$(filesystem_tree_snapshot "$sandbox/dsh-home/profiles")

  (
    FAKE_DSH_PAUSE_ADD_PROFILE=web \
      FAKE_DSH_PAUSE_READY="$sandbox/orphan-child-ready" \
      FAKE_DSH_PAUSE_RELEASE="$sandbox/orphan-child-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/orphan-owner.out" 2>&1 &
  launcher_pid=$!
  wait_for_file "$sandbox/orphan-child-ready" 'first installer did not pause its DSH child before mutation'
  owner_pid=$(json_eval "$sandbox/dsh-home/.gpu-workload-manager-install.lock" 'data.pid')
  child_pid=$(<"$sandbox/orphan-child-ready")
  kill -9 "$owner_pid"
  set +e
  wait "$launcher_pid"
  launcher_status=$?
  set -e
  [[ $launcher_status -ne 0 ]] || fail 'fault injector must SIGKILL only the isolated installer group leader'
  kill -0 "$child_pid" 2>/dev/null || fail 'the paused DSH child must initially survive its shell owner'

  set +e
  output=$(FAKE_DSH_FAIL_ADD_PROFILE=web run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'second installer fault injection must fail after quiescing and recovering the orphan group'
  assert_contains "$output" 'recovering interrupted DSH installation transaction'
  child_state=$(/bin/ps -p "$child_pid" -o state= 2>/dev/null || true)
  [[ -z "$child_state" || "$child_state" == Z* ]] || fail 'orphan DSH descendants must be TERM/KILL quiescent before recovery mutates profiles'
  assert_eq "$before" "$(filesystem_tree_snapshot "$sandbox/dsh-home/profiles")" 'failed retry must roll back to baseline after the orphan process group is quiescent'
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager/transaction"

  : > "$sandbox/orphan-child-release"
  assert_eq "$before" "$(filesystem_tree_snapshot "$sandbox/dsh-home/profiles")" 'a quiesced orphan child must never perform a late profile mutation'
  run_installer "$sandbox" --role server >/dev/null
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
  assert_installed_profile "$sandbox/dsh-home/profiles/headless/package.json" "$sandbox/dsh-home"
}

test_lock_liveness_checks_ignore_path_injected_ps() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-install-ps-path.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    ': > "${FAKE_PS_MARKER:?}"' \
    'exit 99' \
    > "$sandbox/repo/fake-bin/ps"
  chmod +x "$sandbox/repo/fake-bin/ps"

  FAKE_PS_MARKER="$sandbox/fake-ps-used" run_installer "$sandbox" --role server >/dev/null
  assert_no_file "$sandbox/fake-ps-used"
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
}

test_rejects_forged_process_group_isolation_marker() {
  local sandbox output status
  sandbox=$(mktemp -d /tmp/gwm-install-forged-pgid.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"

  set +e
  output=$(GWM_INSTALL_PROCESS_GROUP=1 run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a user-forged supervisor marker outside an isolated process group must fail closed'
  assert_contains "$output" 'supervised installer is not its process-group leader'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'forged process-group isolation must be rejected before DSH calls'
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
}

test_rejects_stale_legacy_incomplete_owner_lock() {
  local sandbox incomplete_owner lock_before output status
  sandbox=$(mktemp -d /tmp/gwm-install-incomplete-owner.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  mkdir "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  incomplete_owner="$sandbox/dsh-home/.gpu-workload-manager-install.lock/.owner-99999999-$(printf '%064d' 0)-$(printf '%032d' 0).tmp"
  : > "$incomplete_owner"
  lock_before=$(filesystem_tree_snapshot "$sandbox/dsh-home/.gpu-workload-manager-install.lock")

  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e

  [[ $status -ne 0 ]] || fail 'a stale legacy incomplete-owner directory must fail closed without process-group proof'
  assert_contains "$output" 'unsafe or unverifiable GPU Workload Manager installation lock'
  assert_eq "$lock_before" "$(filesystem_tree_snapshot "$sandbox/dsh-home/.gpu-workload-manager-install.lock")" 'a stale legacy incomplete-owner lock must remain untouched for manual inspection'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'a stale legacy incomplete-owner lock must be rejected before DSH calls'
}

test_stale_reclaim_tombstone_prevents_three_party_aba() {
  local sandbox a_pid b_pid a_status
  sandbox=$(mktemp -d /tmp/gwm-install-lock-aba.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  "$TEST_REAL_NODE" - "$sandbox/dsh-home/.gpu-workload-manager-install.lock" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], `${JSON.stringify({
  version: 2,
  pid: 99999999,
  start: 'stale',
  pgid: 99999999,
  token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
})}\n`, { mode: 0o600 });
NODE

  (
    FAKE_NODE_PAUSE_ACTION=stale-lock-finalize \
      FAKE_NODE_PAUSE_READY="$sandbox/a-ready" \
      FAKE_NODE_PAUSE_RELEASE="$sandbox/a-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/a.out" 2>&1 &
  a_pid=$!
  wait_for_file "$sandbox/a-ready" 'first stale contender did not reach its deterministic pause'

  (
    FAKE_DSH_PAUSE_ADD_PROFILE=web \
      FAKE_DSH_PAUSE_READY="$sandbox/b-ready" \
      FAKE_DSH_PAUSE_RELEASE="$sandbox/b-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/b.out" 2>&1 &
  b_pid=$!
  wait_for_file "$sandbox/b-ready" 'replacement lock owner did not acquire the lock and reach DSH add'
  assert_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
  assert_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock.stale-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-tombstone"

  : > "$sandbox/a-release"
  set +e
  wait "$a_pid"
  a_status=$?
  set -e
  [[ $a_status -ne 0 ]] || fail 'the paused stale contender must reject the replacement active lock'
  assert_contains "$(<"$sandbox/a.out")" 'another GPU Workload Manager installation is active'
  kill -0 "$b_pid" 2>/dev/null || fail 'replacement installer must remain alive after the stale contender resumes'
  assert_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"

  : > "$sandbox/b-release"
  wait "$b_pid"
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
}

test_recovers_a_sigkill_interrupted_transaction_before_retrying() {
  local sandbox web_before headless_before modules_before output status
  sandbox=$(mktemp -d /tmp/gwm-install-sigkill-recovery.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  printf 'PRESERVE=yes\n' > "$sandbox/dsh-home/.env"
  web_before=$(<"$sandbox/dsh-home/profiles/web/package.json")
  headless_before=$(<"$sandbox/dsh-home/profiles/headless/package.json")
  modules_before=$(node_modules_tree_snapshot "$sandbox/dsh-home/profiles")

  set +e
  output=$(FAKE_DSH_KILL_INSTALLER_PROFILE=web run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'the fault injector must kill the installer after a partial profile mutation'
  assert_file "$sandbox/dsh-home/.gpu-workload-manager/transaction/journal.json"
  [[ "$web_before" != "$(<"$sandbox/dsh-home/profiles/web/package.json")" ]] || fail 'the killed transaction must leave an observable partial mutation'

  set +e
  output=$(FAKE_NODE_FAIL_ACTION=target-state-durability-barrier run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'recovery must fail closed when restored target state cannot pass its durability barrier'
  assert_contains "$output" 'could not persist recovered DSH target state'
  assert_file "$sandbox/dsh-home/.gpu-workload-manager/transaction/journal.json"
  assert_eq "$web_before" "$(<"$sandbox/dsh-home/profiles/web/package.json")" 'failed recovery durability must retain the journal after restoring the web manifest'
  assert_eq "$headless_before" "$(<"$sandbox/dsh-home/profiles/headless/package.json")" 'failed recovery durability must retain the journal after restoring the headless manifest'
  assert_eq "$modules_before" "$(node_modules_tree_snapshot "$sandbox/dsh-home/profiles")" 'failed recovery durability must retain a replayable node_modules baseline'

  set +e
  output=$(FAKE_DSH_FAIL_ADD_PROFILE=web run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'the second fault injector must stop the retry after crash recovery'
  assert_contains "$output" 'recovering interrupted DSH installation transaction'
  assert_eq "$web_before" "$(<"$sandbox/dsh-home/profiles/web/package.json")" 'crash recovery must restore the web manifest before the retry mutates it'
  assert_eq "$headless_before" "$(<"$sandbox/dsh-home/profiles/headless/package.json")" 'crash recovery must restore the headless manifest before the retry mutates it'
  assert_eq PRESERVE=yes "$(<"$sandbox/dsh-home/.env")" 'crash recovery must restore the layered environment'
  assert_eq "$modules_before" "$(node_modules_tree_snapshot "$sandbox/dsh-home/profiles")" 'crash recovery must restore all node_modules roots'

  run_installer "$sandbox" --role server
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
  assert_installed_profile "$sandbox/dsh-home/profiles/headless/package.json" "$sandbox/dsh-home"
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager/transaction"
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager-install.lock"
}

test_retains_journal_until_rollback_target_state_is_durable() {
  local sandbox web_before headless_before modules_before output status
  sandbox=$(mktemp -d /tmp/gwm-install-target-fsync.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  web_before=$(<"$sandbox/dsh-home/profiles/web/package.json")
  headless_before=$(<"$sandbox/dsh-home/profiles/headless/package.json")
  modules_before=$(node_modules_tree_snapshot "$sandbox/dsh-home/profiles")

  set +e
  output=$(FAKE_NODE_FAIL_ACTION=target-state-durability-barrier run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'commit must fail closed when installed target state cannot pass its durability barrier'
  assert_contains "$output" 'could not persist installed DSH target state'
  assert_contains "$output" 'target-state durability barrier failed during rollback'
  assert_contains "$output" 'recovery backup retained'
  assert_file "$sandbox/dsh-home/.gpu-workload-manager/transaction/journal.json"
  assert_eq "$web_before" "$(<"$sandbox/dsh-home/profiles/web/package.json")" 'rollback must restore the web manifest even when its durability barrier fails'
  assert_eq "$headless_before" "$(<"$sandbox/dsh-home/profiles/headless/package.json")" 'rollback must restore the headless manifest even when its durability barrier fails'
  assert_eq "$modules_before" "$(node_modules_tree_snapshot "$sandbox/dsh-home/profiles")" 'rollback must restore node_modules while retaining the replayable journal'

  run_installer "$sandbox" --role server
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager/transaction"
}

test_commit_write_failure_cannot_reuse_pre_rollback_durability() {
  local sandbox web_before headless_before output status
  sandbox=$(mktemp -d /tmp/gwm-install-commit-rollback-barrier.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  web_before=$(<"$sandbox/dsh-home/profiles/web/package.json")
  headless_before=$(<"$sandbox/dsh-home/profiles/headless/package.json")

  set +e
  output=$(FAKE_NODE_FAIL_ACTION=transaction-journal-commit \
    FAKE_NODE_FAIL_MARKER="$sandbox/commit-failed" \
    FAKE_NODE_FAIL_WHEN_MARKED_ACTION=target-state-durability-barrier \
    run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'the injected committed-journal write failure must fail installation'
  assert_contains "$output" 'could not commit the durable DSH installation journal'
  assert_contains "$output" 'target-state durability barrier failed during rollback'
  assert_file "$sandbox/dsh-home/.gpu-workload-manager/transaction/journal.json"
  assert_eq prepared "$(json_eval "$sandbox/dsh-home/.gpu-workload-manager/transaction/journal.json" 'data.phase')" 'failed rollback durability must retain the prepared recovery journal'
  assert_eq "$web_before" "$(<"$sandbox/dsh-home/profiles/web/package.json")" 'rollback must restore the web manifest before retaining its journal'
  assert_eq "$headless_before" "$(<"$sandbox/dsh-home/profiles/headless/package.json")" 'rollback must restore the headless manifest before retaining its journal'
}

test_committed_journal_survives_retire_failure_without_rollback() {
  local sandbox output status
  sandbox=$(mktemp -d /tmp/gwm-install-commit-retire.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"

  set +e
  output=$(FAKE_NODE_FAIL_ACTION=transaction-retire run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a committed transaction retirement failure must remain nonzero'
  assert_contains "$output" 'target state is committed but the transaction journal could not be retired'
  [[ "$output" != *'Installed GPU Workload Manager DSH bundle'* ]] || fail 'installer must not announce success before durable journal retirement'
  assert_eq committed "$(json_eval "$sandbox/dsh-home/.gpu-workload-manager/transaction/journal.json" 'data.phase')" 'retire failure must retain a committed journal'
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"

  output=$(run_installer "$sandbox" --role server 2>&1)
  assert_contains "$output" 'Installed GPU Workload Manager DSH bundle'
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager/transaction"
  assert_installed_profile "$sandbox/dsh-home/profiles/headless/package.json" "$sandbox/dsh-home"
}

test_partial_commit_write_failure_retains_visible_committed_journal() {
  local sandbox output status
  sandbox=$(mktemp -d /tmp/gwm-install-partial-commit.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"

  set +e
  output=$(FAKE_NODE_FAIL_AFTER_ACTION=transaction-journal-commit run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a post-rename committed-journal failure must fail installation'
  assert_contains "$output" 'could not commit the durable DSH installation journal'
  [[ "$output" != *'Installed GPU Workload Manager DSH bundle'* ]] || fail 'partial commit failure must precede the success message'
  [[ "$output" != *'rolling back profile changes'* ]] || fail 'a visibly committed journal must never be rolled back'
  assert_eq committed "$(json_eval "$sandbox/dsh-home/.gpu-workload-manager/transaction/journal.json" 'data.phase')" 'a visible but unconfirmed committed journal must be retained for recovery'
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
}

test_darwin_volume_barrier_failure_retains_committed_journal() {
  local sandbox output status stages
  sandbox=$(mktemp -d /tmp/gwm-install-darwin-barrier.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  make_fake_darwin_toolchain "$sandbox/repo/fake-bin"
  : > "$sandbox/durability.log"
  : > "$sandbox/compile.log"

  set +e
  output=$(FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    FAKE_DURABILITY_COMPILE_LOG="$sandbox/compile.log" \
    FAKE_DURABILITY_FAIL_STAGE=transaction-committed \
    run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a failed macOS committed-journal volume barrier must fail installation'
  [[ "$output" != *'Installed GPU Workload Manager DSH bundle'* ]] || fail 'macOS barrier failure must precede the success message'
  assert_eq committed "$(json_eval "$sandbox/dsh-home/.gpu-workload-manager/transaction/journal.json" 'data.phase')" 'a failed macOS commit barrier must retain the replayable committed journal'
  stages=$(awk -F '|' '$1 ~ /^transaction-|^target-state$/ { print $1 }' "$sandbox/durability.log" | paste -sd, -)
  assert_eq 'transaction-prepared,target-state,transaction-committed' "$stages" 'macOS commit durability must follow target durability and precede journal retirement'

  output=$(FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    FAKE_DURABILITY_COMPILE_LOG="$sandbox/compile.log" \
    run_installer "$sandbox" --role server 2>&1)
  assert_contains "$output" 'finishing a committed DSH installation transaction'
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager/transaction"
  stages=$(awk -F '|' '$1 ~ /^transaction-|^target-state$/ { print $1 }' "$sandbox/durability.log" | paste -sd, -)
  assert_eq 'transaction-prepared,target-state,transaction-committed,target-state,transaction-retired,transaction-prepared,target-state,transaction-committed,transaction-retired' "$stages" 'recovery must make target state durable before consuming the committed journal and starting the idempotent retry'
  assert_eq 2 "$(wc -l < "$sandbox/compile.log" | tr -d ' ')" 'the private macOS volume-sync helper must be rebuilt from trusted source on every installer invocation'
}

test_darwin_persists_owner_record_before_publishing_lock_claim() {
  local sandbox stages
  sandbox=$(mktemp -d /tmp/gwm-install-darwin-lock-order.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  make_fake_darwin_toolchain "$sandbox/repo/fake-bin"
  : > "$sandbox/durability.log"
  : > "$sandbox/compile.log"

  FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    run_installer "$sandbox" --role server >/dev/null

  stages=$(awk -F '|' '$1 ~ /^lock-/ { print $1 }' "$sandbox/durability.log" | paste -sd, -)
  assert_eq 'lock-owner-prepared,lock-acquired,lock-released' "$stages" 'macOS must durably order owner contents before publishing the canonical hard-link claim'
}

test_darwin_retire_barrier_failure_does_not_announce_success() {
  local sandbox output status stages
  sandbox=$(mktemp -d /tmp/gwm-install-darwin-retire.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  make_fake_darwin_toolchain "$sandbox/repo/fake-bin"
  : > "$sandbox/durability.log"

  set +e
  output=$(FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    FAKE_DURABILITY_FAIL_STAGE=transaction-retired \
    run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'a failed macOS transaction-retire volume barrier must fail installation'
  [[ "$output" != *'Installed GPU Workload Manager DSH bundle'* ]] || fail 'retire volume barrier failure must precede the success message'
  assert_no_file "$sandbox/dsh-home/.gpu-workload-manager/transaction"
  [[ -n "$(find "$sandbox/dsh-home/.gpu-workload-manager" -maxdepth 1 -type d -name 'transaction.retired-*' -print -quit)" ]] || fail 'an unconfirmed retired transaction must remain recoverable garbage'
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"
  stages=$(awk -F '|' '$1 ~ /^transaction-|^target-state$/ { print $1 }' "$sandbox/durability.log" | paste -sd, -)
  assert_eq 'transaction-prepared,target-state,transaction-committed,transaction-retired' "$stages" 'retirement must be the final durability stage before success'
}

test_darwin_recompiles_persisted_durability_helper() {
  local sandbox helper output
  sandbox=$(mktemp -d /tmp/gwm-install-darwin-helper-integrity.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  make_fake_darwin_toolchain "$sandbox/repo/fake-bin"
  : > "$sandbox/durability.log"
  : > "$sandbox/compile.log"

  FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    FAKE_DURABILITY_COMPILE_LOG="$sandbox/compile.log" \
    run_installer "$sandbox" --role server >/dev/null
  helper="$sandbox/dsh-home/.gpu-workload-manager/gwm-volume-sync-v1"
  chmod 700 "$helper"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$helper"
  chmod 500 "$helper"
  : > "$sandbox/durability.log"

  output=$(FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    FAKE_DURABILITY_COMPILE_LOG="$sandbox/compile.log" \
    run_installer "$sandbox" --role server 2>&1)
  assert_contains "$output" 'Installed GPU Workload Manager DSH bundle'
  assert_eq 2 "$(wc -l < "$sandbox/compile.log" | tr -d ' ')" 'a persisted same-owner no-op helper must be overwritten by a trusted rebuild on the next invocation'
  assert_contains "$(<"$sandbox/durability.log")" 'helper-installed|' 'the rebuilt helper must complete its full-volume installation barrier'
  assert_contains "$(<"$sandbox/durability.log")" 'transaction-retired|' 'the rebuilt helper must execute the transaction retirement barrier'

  ln "$helper" "$sandbox/helper-hardlink"
  : > "$sandbox/durability.log"
  FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    FAKE_DURABILITY_COMPILE_LOG="$sandbox/compile.log" \
    run_installer "$sandbox" --role server >/dev/null
  assert_eq 3 "$(wc -l < "$sandbox/compile.log" | tr -d ' ')" 'a hard-linked helper must be rebuilt instead of reused'
  assert_eq 1 "$(stat -c '%h' "$helper")" 'the rebuilt helper must have a single link'
  assert_contains "$(<"$sandbox/durability.log")" 'helper-installed|' 'the replacement for a hard-linked helper must be durably published'
}

test_darwin_recompiles_coordinated_noop_helper_replacement() {
  local sandbox helper metadata digest output
  sandbox=$(mktemp -d /tmp/gwm-install-darwin-helper-protocol.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  make_fake_darwin_toolchain "$sandbox/repo/fake-bin"
  : > "$sandbox/durability.log"
  : > "$sandbox/compile.log"

  FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    FAKE_DURABILITY_COMPILE_LOG="$sandbox/compile.log" \
    run_installer "$sandbox" --role server >/dev/null
  helper="$sandbox/dsh-home/.gpu-workload-manager/gwm-volume-sync-v1"
  metadata="$helper.sha256"
  chmod 700 "$helper"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [[ $# -eq 1 && "$1" == --protocol ]]; then' \
    '  printf "gwm-volume-sync-v1\\n"' \
    'fi' \
    'exit 0' \
    > "$helper"
  chmod 500 "$helper"
  digest=$("$TEST_REAL_NODE" -e "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" "$helper")
  chmod 600 "$metadata"
  printf 'gwm-volume-sync-v1 %s\n' "$digest" > "$metadata"
  chmod 400 "$metadata"
  : > "$sandbox/dsh.log"
  : > "$sandbox/durability.log"

  output=$(FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    FAKE_DURABILITY_COMPILE_LOG="$sandbox/compile.log" \
    run_installer "$sandbox" --role server 2>&1)
  assert_contains "$output" 'Installed GPU Workload Manager DSH bundle'
  assert_eq 2 "$(wc -l < "$sandbox/compile.log" | tr -d ' ')" 'a coordinated same-owner helper and checksum replacement must still be overwritten by a trusted rebuild'
  assert_contains "$(<"$sandbox/durability.log")" 'helper-installed|' 'the trusted rebuild must execute its helper publication barrier'
  assert_contains "$(<"$sandbox/durability.log")" 'transaction-retired|' 'the trusted rebuild, rather than the coordinated no-op replacement, must execute transaction barriers'
}

test_darwin_sanitizes_compiler_environment() {
  local sandbox output
  sandbox=$(mktemp -d /tmp/gwm-install-darwin-compiler-env.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  make_fake_darwin_toolchain "$sandbox/repo/fake-bin"
  mkdir -p "$sandbox/poison-include"
  : > "$sandbox/durability.log"
  : > "$sandbox/compile.log"

  output=$(CPATH="$sandbox/poison-include" \
    C_INCLUDE_PATH="$sandbox/poison-include" \
    CCC_OVERRIDE_OPTIONS='+ -Dsync_volume_np(path,flags)=0' \
    SDKROOT="$sandbox/poison-sdk" \
    DEVELOPER_DIR="$sandbox/poison-developer" \
    TOOLCHAINS=poison-toolchain \
    FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    run_installer "$sandbox" --role server 2>&1)
  assert_contains "$output" 'Installed GPU Workload Manager DSH bundle'
  assert_eq 1 "$(wc -l < "$sandbox/compile.log" | tr -d ' ')" 'the helper must still be compiled exactly once in the sanitized compiler environment'
  assert_contains "$(<"$sandbox/durability.log")" 'helper-installed|' 'poisoned caller include and driver variables must not change the compiled helper semantics'
  assert_contains "$(<"$sandbox/durability.log")" 'transaction-retired|' 'the sanitized helper must execute the final transaction barrier'
}

test_sigkill_compiler_tmpdir_is_collected_on_retry() {
  local sandbox launcher_pid compiler_orphan owner_pid compiler_pid status
  sandbox=$(mktemp -d /tmp/gwm-install-compiler-orphan.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  make_fake_darwin_toolchain "$sandbox/repo/fake-bin"
  : > "$sandbox/compiler-pause-request"
  : > "$sandbox/durability.log"
  : > "$sandbox/compile.log"

  (
    FAKE_NODE_PLATFORM=darwin \
      FAKE_DURABILITY_LOG="$sandbox/durability.log" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/killed.out" 2>&1 &
  launcher_pid=$!
  wait_for_file "$sandbox/compiler-pause-ready" 'compiler did not pause inside its identity-addressed private TMPDIR'
  compiler_orphan=$(find "$sandbox/dsh-home/.gpu-workload-manager" -maxdepth 1 -type d \
    -name '.gwm-compiler-tmp-*-*-*' -print -quit)
  [[ -n "$compiler_orphan" ]] || fail 'SIGKILL fixture must expose the private compiler TMPDIR'
  owner_pid=${compiler_orphan##*/.gwm-compiler-tmp-}
  owner_pid=${owner_pid%%-*}
  compiler_pid=$(<"$sandbox/compiler-pause-ready")
  kill -9 "$owner_pid" "$compiler_pid" 2>/dev/null || true
  set +e
  wait "$launcher_pid"
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'compiler fault injector must SIGKILL the installer'
  [[ -d "$compiler_orphan" ]] || fail 'the killed compiler must leave its private TMPDIR for recovery'
  find "$sandbox/compiler-pause-request" -delete

  FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    run_installer "$sandbox" --role server >/dev/null
  assert_no_file "$compiler_orphan"
  assert_eq 2 "$(wc -l < "$sandbox/compile.log" | tr -d ' ')" 'retry must collect the dead compiler TMPDIR before compiling in a fresh private directory'
}

test_sigkill_helper_publish_orphan_is_collected_on_retry() {
  local sandbox launcher_pid helper_orphan owner_pid paused_node_pid status
  sandbox=$(mktemp -d /tmp/gwm-install-helper-orphan.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  make_fake_darwin_toolchain "$sandbox/repo/fake-bin"
  : > "$sandbox/durability.log"
  : > "$sandbox/compile.log"

  (
    FAKE_NODE_PLATFORM=darwin \
      FAKE_DURABILITY_LOG="$sandbox/durability.log" \
      FAKE_NODE_PAUSE_ACTION=durability-helper-publish \
      FAKE_NODE_PAUSE_READY="$sandbox/helper-publish-ready" \
      FAKE_NODE_PAUSE_RELEASE="$sandbox/helper-publish-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/killed.out" 2>&1 &
  launcher_pid=$!
  wait_for_file "$sandbox/helper-publish-ready" 'installer did not pause with a compiled helper temporary'
  helper_orphan=$(find "$sandbox/dsh-home/.gpu-workload-manager" -maxdepth 1 -type f \
    -name '.gwm-volume-sync-v1-*-*-*.tmp' -print -quit)
  [[ -n "$helper_orphan" ]] || fail 'SIGKILL fixture must expose the identity-addressed helper temporary'
  owner_pid=${helper_orphan##*/.gwm-volume-sync-v1-}
  owner_pid=${owner_pid%%-*}
  paused_node_pid=$(<"$sandbox/helper-publish-ready")
  kill -9 "$owner_pid" "$paused_node_pid" 2>/dev/null || true
  set +e
  wait "$launcher_pid"
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'helper-publish fault injector must SIGKILL the installer'
  assert_file "$helper_orphan"

  FAKE_NODE_PLATFORM=darwin \
    FAKE_DURABILITY_LOG="$sandbox/durability.log" \
    run_installer "$sandbox" --role server >/dev/null
  assert_no_file "$helper_orphan"
  assert_eq 2 "$(wc -l < "$sandbox/compile.log" | tr -d ' ')" 'retry must collect the dead helper temporary before performing its own trusted rebuild'
}

test_sigkill_release_quarantine_is_collected_on_retry() {
  local sandbox launcher_pid release_orphan empty_release owner_pid paused_node_pid status
  sandbox=$(mktemp -d /tmp/gwm-install-release-orphan.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"

  (
    FAKE_NODE_PAUSE_ACTION=lock-release-cleanup \
      FAKE_NODE_PAUSE_READY="$sandbox/release-ready" \
      FAKE_NODE_PAUSE_RELEASE="$sandbox/release-release" \
      run_installer "$sandbox" --role server
  ) > "$sandbox/killed.out" 2>&1 &
  launcher_pid=$!
  wait_for_file "$sandbox/release-ready" 'installer did not pause after quarantining its released lock'
  release_orphan=$(find "$sandbox/dsh-home" -maxdepth 1 -type f \
    -name '.gpu-workload-manager-install.lock.release-*-*-*' -print -quit)
  [[ -n "$release_orphan" ]] || fail 'SIGKILL fixture must expose the identity-addressed release quarantine'
  owner_pid=${release_orphan##*/.gpu-workload-manager-install.lock.release-}
  owner_pid=${owner_pid%%-*}
  paused_node_pid=$(<"$sandbox/release-ready")
  kill -9 "$owner_pid" "$paused_node_pid" 2>/dev/null || true
  set +e
  wait "$launcher_pid"
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'release-cleanup fault injector must SIGKILL the installer'
  [[ -f "$release_orphan" ]] || fail 'the killed release cleanup must leave its quarantine for recovery'

  run_installer "$sandbox" --role server >/dev/null
  assert_no_file "$release_orphan"
  assert_installed_profile "$sandbox/dsh-home/profiles/web/package.json" "$sandbox/dsh-home"

  empty_release="$sandbox/dsh-home/.gpu-workload-manager-install.lock.release-99999999-$(printf '%064d' 0)-$(printf '%032d' 0)"
  mkdir "$empty_release"
  run_installer "$sandbox" --role server >/dev/null
  assert_no_file "$empty_release"
}

test_rejects_symlinked_profile_lockfiles_before_mutation() {
  local sandbox external output status
  sandbox=$(mktemp -d /tmp/gwm-install-lockfile-link.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  external="$sandbox/external-lock.yaml"
  printf 'outside-must-survive\n' > "$external"
  ln -s "$external" "$sandbox/dsh-home/profiles/web/pnpm-lock.yaml"
  set +e
  output=$(run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'symlinked profile lockfile must be rejected'
  assert_contains "$output" 'pnpm-lock.yaml must not be a symlink'
  assert_eq outside-must-survive "$(<"$external")" 'installer must never follow or overwrite an out-of-profile lockfile target'
  assert_eq '' "$(<"$sandbox/dsh.log")" 'lockfile preflight must precede DSH calls'
}

test_rolls_back_only_new_dependencies_after_validation_failure() {
  local sandbox
  sandbox=$(mktemp -d /tmp/gwm-install-rollback.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  local manager_archive
  manager_archive=$(find_fixture_archive "$sandbox/repo/dist/packages" '@local/dsh-gpu-workload-manager')
  "$TEST_REAL_NODE" - "$sandbox/dsh-home/profiles/web/package.json" "$manager_archive" <<'NODE'
const fs = require('node:fs');
const [file, archive] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.dependencies['@local/dsh-gpu-workload-manager'] = `file:${archive}`;
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
  mkdir -p "$sandbox/dsh-home/profiles/web/node_modules/@local"
  ln -s ../@example/preserved "$sandbox/dsh-home/profiles/web/node_modules/@local/dsh-gpu-workload-manager"
  local modules_root metadata
  for modules_root in \
    "$sandbox/dsh-home/profiles/node_modules" \
    "$sandbox/dsh-home/profiles/web/node_modules" \
    "$sandbox/dsh-home/profiles/headless/node_modules"; do
    mkdir -p "$modules_root/.pnpm"
    for metadata in .modules.yaml .package-map.json .pnpm-workspace-state-v1.json .pnpm/lock.yaml; do
      printf 'preserve-%s\n' "$metadata" > "$modules_root/$metadata"
      chmod 640 "$modules_root/$metadata"
    done
  done
  printf '%s\n' \
    'PRESERVE_BEFORE=yes' \
    '# >>> GPU Workload Manager (managed by install-dsh-bundle.sh) >>>' \
    'GPU_WORKLOAD_ROLE=client' \
    'GPU_WORKLOAD_MANAGER_URL=http://192.168.50.10:8080' \
    '# <<< GPU Workload Manager (managed by install-dsh-bundle.sh) <<<' \
    'PRESERVE_AFTER=yes' > "$sandbox/dsh-home/.env"
  chmod 640 "$sandbox/dsh-home/.env"
  local web_before headless_before env_before modules_before output status
  web_before=$(<"$sandbox/dsh-home/profiles/web/package.json")
  headless_before=$(<"$sandbox/dsh-home/profiles/headless/package.json")
  env_before=$(<"$sandbox/dsh-home/.env")
  modules_before=$(node_modules_tree_snapshot "$sandbox/dsh-home/profiles")
  set +e
  output=$(FAKE_DSH_FAIL_DUMP_PROFILE=headless run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'headless composition failure must fail installation'
  assert_contains "$output" 'validation' 'failure must identify composition validation'
  assert_eq "$web_before" "$(<"$sandbox/dsh-home/profiles/web/package.json")" 'rollback must preserve the preexisting manager dependency'
  assert_eq "$headless_before" "$(<"$sandbox/dsh-home/profiles/headless/package.json")" 'rollback must restore the untouched headless manifest'
  assert_eq "$env_before" "$(<"$sandbox/dsh-home/.env")" 'rollback must restore the exact preexisting layered-env bytes'
  assert_eq 640 "$(stat -c '%a' "$sandbox/dsh-home/.env")" 'rollback must restore layered-env mode'
  assert_eq "$modules_before" "$(node_modules_tree_snapshot "$sandbox/dsh-home/profiles")" 'rollback must restore all three node_modules roots without package or transitive residue'
  assert_eq 2 "$(grep -c '^remove ' "$sandbox/dsh.log")" 'rollback must use the pnpm 11-compatible ignore-scripts configuration for both profiles'
  assert_contains "$(<"$sandbox/dsh.log")" 'dump web server http://127.0.0.1:8080 source=home-env' 'validation must observe the updated managed block before rollback'
  assert_no_file "$sandbox/dsh-home/gpu-workload-manager.env"
}

test_removes_node_modules_roots_created_by_a_failed_install() {
  local sandbox shared_before output status
  sandbox=$(mktemp -d /tmp/gwm-install-rollback-empty-modules.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  find "$sandbox/dsh-home/profiles/web/node_modules" -depth -delete
  find "$sandbox/dsh-home/profiles/headless/node_modules" -depth -delete
  shared_before=$(node_modules_tree_snapshot "$sandbox/dsh-home/profiles")
  set +e
  output=$(FAKE_DSH_FAIL_DUMP_PROFILE=headless run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'headless composition failure must fail installation'
  assert_contains "$output" 'rolling back profile changes'
  assert_no_file "$sandbox/dsh-home/profiles/web/node_modules"
  assert_no_file "$sandbox/dsh-home/profiles/headless/node_modules"
  assert_eq "$shared_before" "$(node_modules_tree_snapshot "$sandbox/dsh-home/profiles")" 'rollback must preserve a preexisting shared node_modules root exactly'
  assert_eq 2 "$(grep -c '^remove ' "$sandbox/dsh.log")" 'both profiles must remove only dependencies introduced by the failed transaction'
}

test_reports_remove_failure_while_restoring_transaction_paths() {
  local sandbox before output status
  sandbox=$(mktemp -d /tmp/gwm-install-rollback-remove-error.XXXXXX)
  trap 'cleanup_tree "$sandbox"' RETURN
  setup_install_fixture "$sandbox"
  before=$(filesystem_tree_snapshot "$sandbox/dsh-home/profiles")
  set +e
  output=$(FAKE_DSH_FAIL_DUMP_PROFILE=headless FAKE_DSH_FAIL_REMOVE_PROFILE=headless run_installer "$sandbox" --role server 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail 'composition failure must remain nonzero when package removal also fails'
  assert_contains "$output" 'headless dependency cleanup failed during rollback' 'rollback must not suppress a pnpm remove failure'
  assert_contains "$output" 'rollback encountered an error'
  assert_eq "$before" "$(filesystem_tree_snapshot "$sandbox/dsh-home/profiles")" 'profile path reconciliation must restore the baseline even when pnpm remove fails'
  assert_no_file "$sandbox/dsh-home/.env"
}

test_client_requires_explicit_manager_url_before_writes
test_installs_both_profiles_idempotently
test_rerun_from_relocated_source_uses_persistent_archives
test_real_layered_env_loader_reads_managed_values
test_live_verifier_matches_installer_contract_and_composition
test_dump_validation_ignores_invoking_directory_env
test_rejects_unmanaged_or_duplicate_layered_env_keys_without_logging_values
test_repairs_missing_installed_package_directories
test_fails_closed_when_same_version_archive_bytes_change
test_rejects_disabled_manager_in_either_profile
test_rejects_checksum_tampering_before_writes
test_rejects_conflicting_dependency_before_writes
test_rejects_role_incompatible_manager_urls_before_writes
test_acquires_install_lock_before_reading_profile_state
test_rejects_empty_legacy_install_lock
test_rejects_dead_legacy_owner_without_process_group_proof
test_atomic_lock_claim_does_not_replace_late_legacy_lock
test_sigkill_before_and_after_file_lock_claim_recovers_on_retry
test_sigkill_stale_file_fence_is_completed_on_retry
test_recovers_crossed_claim_and_stale_fence_sigkills
test_rejects_unexpected_three_link_owner_temporary
test_orphan_dsh_process_group_is_quiesced_before_recovery
test_lock_liveness_checks_ignore_path_injected_ps
test_rejects_forged_process_group_isolation_marker
test_rejects_stale_legacy_incomplete_owner_lock
test_stale_reclaim_tombstone_prevents_three_party_aba
test_recovers_a_sigkill_interrupted_transaction_before_retrying
test_retains_journal_until_rollback_target_state_is_durable
test_commit_write_failure_cannot_reuse_pre_rollback_durability
test_committed_journal_survives_retire_failure_without_rollback
test_partial_commit_write_failure_retains_visible_committed_journal
test_darwin_volume_barrier_failure_retains_committed_journal
test_darwin_persists_owner_record_before_publishing_lock_claim
test_darwin_retire_barrier_failure_does_not_announce_success
test_darwin_recompiles_persisted_durability_helper
test_darwin_recompiles_coordinated_noop_helper_replacement
test_darwin_sanitizes_compiler_environment
test_sigkill_compiler_tmpdir_is_collected_on_retry
test_sigkill_helper_publish_orphan_is_collected_on_retry
test_sigkill_release_quarantine_is_collected_on_retry
test_rejects_symlinked_profile_lockfiles_before_mutation
test_rolls_back_only_new_dependencies_after_validation_failure
test_removes_node_modules_roots_created_by_a_failed_install
test_reports_remove_failure_while_restoring_transaction_paths
printf 'ok - install-dsh-bundle tests\n'
