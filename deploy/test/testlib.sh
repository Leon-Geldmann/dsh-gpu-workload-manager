#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

assert_eq() {
  local expected=$1
  local actual=$2
  local message=${3:-"expected values to match"}
  if [[ "$expected" != "$actual" ]]; then
    printf 'expected: %s\nactual:   %s\n' "$expected" "$actual" >&2
    fail "$message"
  fi
}

assert_contains() {
  local haystack=$1
  local needle=$2
  local message=${3:-"expected output to contain text"}
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'missing text: %s\noutput:\n%s\n' "$needle" "$haystack" >&2
    fail "$message"
  fi
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file: $1"
}

assert_no_file() {
  [[ ! -e "$1" ]] || fail "expected path to be absent: $1"
}

cleanup_tree() {
  local target=${1:-}
  if [[ -n "$target" && -d "$target" && "$target" == /tmp/* ]]; then
    find "$target" -depth -delete
  fi
}

json_eval() {
  local file=$1
  local expression=$2
  "$TEST_REAL_NODE" - "$file" "$expression" <<'NODE'
const fs = require('node:fs');
const [file, expression] = process.argv.slice(2);
const value = Function('data', `return (${expression})`)(JSON.parse(fs.readFileSync(file, 'utf8')));
if (typeof value === 'object') process.stdout.write(JSON.stringify(value));
else process.stdout.write(String(value));
NODE
}

write_package_fixture() {
  local workspace=$1
  local directory=$2
  local name=$3
  local extra_json=${4:-}
  local package_dir="$workspace/packages/$directory/_pack/package"
  mkdir -p "$package_dir/lib"
  printf 'export function apply() {}\n' > "$package_dir/lib/index.js"
  if [[ "$directory" == dsh-model-selection ]]; then
    printf 'export function apply() {}\n' > "$package_dir/lib/client.js"
  fi
  if [[ "$directory" == bundle ]]; then
    printf '%s\n' \
      '- id: ui-model-selection' \
      "  name: '@deepseek-ai/dsh-client-ui-model-selection'" \
      '  disabled: true' \
      '- insert:' \
      '    - id: gpu-workload-manager' \
      "      name: '@local/dsh-gpu-workload-manager'" \
      '    - id: gpu-workload-model-selection' \
      "      name: '@local/dsh-gpu-model-selection'" > "$package_dir/cordis.patch.yml"
  fi
  "$TEST_REAL_NODE" - "$package_dir/package.json" "$name" "$directory" "$extra_json" <<'NODE'
const fs = require('node:fs');
const [file, name, directory, extraJson] = process.argv.slice(2);
const value = {
  name,
  version: '0.1.0',
  private: false,
  type: 'module',
  main: './lib/index.js',
  files: ['lib/index.js'],
  peerDependencies: { '@deepseek-ai/cordis': '4.0.1' },
};
if (directory === 'dsh-model-selection') {
  value.files.push('lib/client.js');
  value.exports = { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' };
}
if (directory === 'bundle') {
  value.files.push('cordis.patch.yml');
  value.exports = { '.': './lib/index.js', './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json' };
  value.dsh = { bundle: { patch: './cordis.patch.yml' } };
}
if (extraJson) Object.assign(value, JSON.parse(extraJson));
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
  cp "$package_dir/package.json" "$workspace/packages/$directory/package.json"
}

make_fake_node() {
  local bin_dir=$1
  mkdir -p "$bin_dir"
  cat > "$bin_dir/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  printf '%s\n' "${FAKE_NODE_VERSION:-v22.17.0}"
  exit 0
fi
if [[ "${1:-}" == "-p" && "${2:-}" == "process.platform" && -n "${FAKE_NODE_PLATFORM:-}" ]]; then
  printf '%s\n' "$FAKE_NODE_PLATFORM"
  exit 0
fi
if [[ "${1:-}" == "-" && "${2:-}" == "${FAKE_NODE_FAIL_AFTER_ACTION:-__never__}" ]]; then
  "$TEST_REAL_NODE" "$@"
  exit 89
fi
if [[ "${1:-}" == "-" && "${2:-}" == "${FAKE_NODE_FAIL_ACTION:-__never__}" ]]; then
  if [[ -n "${FAKE_NODE_FAIL_MARKER:-}" ]]; then
    : > "$FAKE_NODE_FAIL_MARKER"
  fi
  exit 89
fi
if [[ "${1:-}" == "-" && "${2:-}" == "${FAKE_NODE_FAIL_WHEN_MARKED_ACTION:-__never__}"
  && -n "${FAKE_NODE_FAIL_MARKER:-}" && -e "$FAKE_NODE_FAIL_MARKER" ]]; then
  exit 89
fi
if [[ "${1:-}" == "-" && "${2:-}" == "${FAKE_NODE_PAUSE_ACTION:-__never__}" ]]; then
  printf '%s\n' "$$" > "$FAKE_NODE_PAUSE_READY"
  pause_attempt=0
  while [[ ! -e "$FAKE_NODE_PAUSE_RELEASE" && $pause_attempt -lt 1000 ]]; do
    pause_attempt=$((pause_attempt + 1))
    sleep 0.01
  done
  [[ -e "$FAKE_NODE_PAUSE_RELEASE" ]] || exit 90
fi
exec "$TEST_REAL_NODE" "$@"
EOF
  chmod +x "$bin_dir/node"
}

make_fake_darwin_toolchain() {
  local bin_dir=$1
  mkdir -p "$bin_dir/fake-sdk"
  cat > "$bin_dir/xcrun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
bin_dir=$(cd "$(dirname "$0")" && pwd -P)
if [[ "${1:-}" == "--sdk" && "${2:-}" == "macosx" && "${3:-}" == "--find" && "${4:-}" == "clang" && $# -eq 4 ]]; then
  printf '%s\n' "$bin_dir/fake-durable-clang"
elif [[ "${1:-}" == "--sdk" && "${2:-}" == "macosx" && "${3:-}" == "--show-sdk-path" && $# -eq 3 ]]; then
  printf '%s\n' "$bin_dir/fake-sdk"
else
  exit 96
fi
EOF
  cat > "$bin_dir/fake-durable-clang" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
bin_dir=$(cd "$(dirname "$0")" && pwd -P)
sandbox=$(cd "$bin_dir/../.." && pwd -P)
output=''
while (( $# )); do
  if [[ "$1" == -o && $# -ge 2 ]]; then
    output=$2
    shift 2
  else
    shift
  fi
done
[[ -n "$output" ]] || exit 97
while IFS= read -r _line; do :; done
printf 'compile\n' >> "$sandbox/compile.log"
if [[ -e "$sandbox/compiler-pause-request" ]]; then
  printf '%s\n' "$$" > "$sandbox/compiler-pause-ready"
  compiler_pause_attempt=0
  while [[ ! -e "$sandbox/compiler-pause-release" && $compiler_pause_attempt -lt 1000 ]]; do
    compiler_pause_attempt=$((compiler_pause_attempt + 1))
    sleep 0.01
  done
  [[ -e "$sandbox/compiler-pause-release" ]] || exit 90
fi
if [[ -n "${CPATH:-}${C_INCLUDE_PATH:-}${CPLUS_INCLUDE_PATH:-}${OBJC_INCLUDE_PATH:-}${CCC_OVERRIDE_OPTIONS:-}${SDKROOT:-}${DEVELOPER_DIR:-}${TOOLCHAINS:-}${MACOSX_DEPLOYMENT_TARGET:-}${LIBRARY_PATH:-}${DYLD_LIBRARY_PATH:-}${DYLD_INSERT_LIBRARIES:-}" ]]; then
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [[ $# -eq 1 && "$1" == --protocol ]]; then printf "gwm-volume-sync-v1\\n"; fi' \
    'exit 0' \
    > "$output"
  chmod 700 "$output"
  exit 0
fi
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ $# -eq 1 && "$1" == --protocol ]]; then' \
  '  printf "gwm-volume-sync-v1\\n"' \
  '  exit 0' \
  'fi' \
  '[[ $# -eq 2 ]] || exit 64' \
  'stage=$1' \
  'target=$2' \
  'printf "%s|%s\\n" "$stage" "$target" >> "$FAKE_DURABILITY_LOG"' \
  '[[ -e "$target" && ! -L "$target" ]] || exit 65' \
  '[[ "${FAKE_DURABILITY_FAIL_STAGE:-}" != "$stage" ]] || exit 98' \
  > "$output"
chmod 700 "$output"
EOF
  chmod +x "$bin_dir/xcrun" "$bin_dir/fake-durable-clang"
}

make_fake_pnpm_for_build() {
  local bin_dir=$1
  cat > "$bin_dir/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf '%s\n' "${FAKE_PNPM_VERSION:-11.19.0}"
  exit 0
fi
[[ "${1:-}" == "--filter" ]] || exit 71
package_name=$2
command_name=$3
case "$package_name" in
  '@local/dsh-gpu-workload-manager') package_dir=dsh-plugin; archive=local-dsh-gpu-workload-manager-0.1.0.tgz ;;
  '@local/dsh-gpu-model-selection') package_dir=dsh-model-selection; archive=local-dsh-gpu-model-selection-0.1.0.tgz ;;
  '@local/dsh-gpu-workload-bundle') package_dir=bundle; archive=local-dsh-gpu-workload-bundle-0.1.0.tgz ;;
  *) exit 72 ;;
esac
printf '%s %s\n' "$command_name" "$package_name" >> "$FAKE_COMMAND_LOG"
if [[ "$command_name" == build ]]; then
  exit 0
fi
[[ "$command_name" == pack ]] || exit 73
shift 3
destination=
while (( $# )); do
  case "$1" in
    --pack-destination) destination=$2; shift 2 ;;
    *) exit 74 ;;
  esac
done
[[ -n "$destination" && "$destination" == /* ]] || exit 75
mkdir -p "$destination"
if [[ "${FAKE_BAD_MANIFEST_PACKAGE:-}" == "$package_name" ]]; then
  "$TEST_REAL_NODE" - "$PWD/packages/$package_dir/_pack/package/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.dependencies = { '@local/not-publishable': 'workspace:*' };
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
fi
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -czf "$destination/$archive" -C "$PWD/packages/$package_dir/_pack" package
EOF
  chmod +x "$bin_dir/pnpm"
}

make_artifact_set() {
  local root=$1
  local packages_dir="$root/dist/packages"
  mkdir -p "$packages_dir"
  local fixture="$root/.artifact-fixture"
  mkdir -p "$fixture/packages"
  write_package_fixture "$fixture" dsh-plugin '@local/dsh-gpu-workload-manager'
  write_package_fixture "$fixture" dsh-model-selection '@local/dsh-gpu-model-selection'
  write_package_fixture "$fixture" bundle '@local/dsh-gpu-workload-bundle'
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -czf "$packages_dir/local-dsh-gpu-workload-manager-0.1.0.tgz" -C "$fixture/packages/dsh-plugin/_pack" package
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -czf "$packages_dir/local-dsh-gpu-model-selection-0.1.0.tgz" -C "$fixture/packages/dsh-model-selection/_pack" package
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -czf "$packages_dir/local-dsh-gpu-workload-bundle-0.1.0.tgz" -C "$fixture/packages/bundle/_pack" package
  (
    cd "$packages_dir"
    for file in *.tgz; do
      hash=$(sha256sum "$file" | awk '{print $1}')
      addressed=${file%.tgz}-$hash.tgz
      mv "$file" "$addressed"
      printf '%s  %s\n' "$hash" "$addressed"
    done | LC_ALL=C sort > SHA256SUMS
  )
}

find_fixture_archive() {
  local packages_dir=$1
  local expected_name=$2
  "$TEST_REAL_NODE" - "$packages_dir" "$expected_name" <<'NODE'
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [directory, expectedName] = process.argv.slice(2);
const matches = fs.readdirSync(directory).filter(name => name.endsWith('.tgz')).filter(name => {
  const pkg = JSON.parse(cp.execFileSync('tar', ['-xOf', path.join(directory, name), 'package/package.json'], { encoding: 'utf8' }));
  return pkg.name === expectedName;
});
if (matches.length !== 1) process.exit(1);
process.stdout.write(path.join(directory, matches[0]));
NODE
}

make_profile_home() {
  local dsh_home=$1
  mkdir -p \
    "$dsh_home/profiles/node_modules/@example" \
    "$dsh_home/profiles/web/node_modules/@example/preserved" \
    "$dsh_home/profiles/headless/node_modules/@example/preserved"
  printf 'shared-before\n' > "$dsh_home/profiles/node_modules/@example/preserved.txt"
  printf 'web-before\n' > "$dsh_home/profiles/web/node_modules/@example/preserved/content.txt"
  printf 'headless-before\n' > "$dsh_home/profiles/headless/node_modules/@example/preserved/content.txt"
  for profile in web headless; do
    "$TEST_REAL_NODE" - "$dsh_home/profiles/$profile/package.json" "$profile" <<'NODE'
const fs = require('node:fs');
const [file, profile] = process.argv.slice(2);
const value = {
  name: `dsh-profile-${profile}`,
  private: true,
  dependencies: { '@example/preserved': '2.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', `@deepseek-ai/dsh-${profile}`] } },
};
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
    printf 'preserved-%s\n' "$profile" > "$dsh_home/profiles/$profile/cordis.patch.yml"
  done
}

node_modules_tree_snapshot() {
  local profiles_dir=$1
  "$TEST_REAL_NODE" - "$profiles_dir" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const roots = ['node_modules', 'web/node_modules', 'headless/node_modules'];
const result = [];
const visit = (absolute, relative) => {
  const stat = fs.lstatSync(absolute);
  const item = { path: relative, mode: stat.mode & 0o777, type: stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : stat.isFile() ? 'f' : 'x' };
  if (stat.isSymbolicLink()) item.target = fs.readlinkSync(absolute);
  if (stat.isFile()) item.sha256 = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  result.push(item);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), `${relative}/${name}`);
  }
};
for (const relative of roots) {
  const absolute = path.join(root, relative);
  if (fs.existsSync(absolute)) visit(absolute, relative);
}
process.stdout.write(JSON.stringify(result));
NODE
}

filesystem_tree_snapshot() {
  local root=$1
  "$TEST_REAL_NODE" - "$root" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const result = [];
const visit = (absolute, relative) => {
  const stat = fs.lstatSync(absolute);
  const item = {
    path: relative,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    type: stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : stat.isFile() ? 'f' : 'x',
  };
  if (stat.isSymbolicLink()) item.target = fs.readlinkSync(absolute);
  if (stat.isFile()) item.sha256 = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  result.push(item);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    }
  }
};
visit(root, '');
process.stdout.write(JSON.stringify(result));
NODE
}

make_fake_pnpm_version() {
  local bin_dir=$1
  cat > "$bin_dir/pnpm" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "--version" ]] || exit 91
printf '%s\n' "${FAKE_PNPM_VERSION:-11.19.0}"
EOF
  chmod +x "$bin_dir/pnpm"
}

make_fake_dsh() {
  local bin_dir=$1
  cat > "$bin_dir/dsh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf '%s\n' "${FAKE_DSH_VERSION:-0.1.1-rc.2}"
  exit 0
fi
if [[ "${1:-}" == plugin ]]; then
  [[ "${2:-}" == --profile ]]
  profile=$3
  action=$4
  shift 4
  manifest="$DSH_HOME/profiles/$profile/package.json"
  if [[ "$action" == add ]]; then
    saw_ignore=0
    archives=()
    for argument in "$@"; do
      if [[ "$argument" == --ignore-scripts ]]; then
        saw_ignore=1
      elif [[ "$argument" == --save-exact ]]; then
        :
      elif [[ "$argument" == *.tgz ]]; then
        [[ "$argument" == /* ]] || exit 92
        archives+=("$argument")
      fi
    done
    (( saw_ignore == 1 )) || exit 93
    printf 'add %s\n' "$profile" >> "$FAKE_DSH_LOG"
    if [[ "${FAKE_DSH_FAIL_ADD_PROFILE:-}" == "$profile" ]]; then
      exit 94
    fi
    if [[ "${FAKE_DSH_PAUSE_ADD_PROFILE:-}" == "$profile" ]]; then
      printf '%s\n' "$$" > "$FAKE_DSH_PAUSE_READY"
      pause_attempt=0
      while [[ ! -e "$FAKE_DSH_PAUSE_RELEASE" && $pause_attempt -lt 1000 ]]; do
        pause_attempt=$((pause_attempt + 1))
        sleep 0.01
      done
      [[ -e "$FAKE_DSH_PAUSE_RELEASE" ]] || exit 105
    fi
    "$TEST_REAL_NODE" - "$manifest" "$DSH_HOME/profiles/$profile" "${archives[@]}" <<'NODE'
const fs = require('node:fs');
const cp = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const [manifestFile, profileDir, ...archives] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.dependencies ||= {};
for (const archive of archives) {
  const pkg = JSON.parse(cp.execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  manifest.dependencies[pkg.name] = `file:${archive}`;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gwm-fake-pnpm.'));
  cp.execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  const destination = path.join(profileDir, 'node_modules', ...pkg.name.split('/'));
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(temporary, 'package'), destination, { recursive: true });
  fs.rmSync(temporary, { recursive: true, force: true });
}
const transitive = path.join(profileDir, 'node_modules', 'zod');
fs.mkdirSync(transitive, { recursive: true });
fs.writeFileSync(path.join(transitive, 'package.json'), '{"name":"zod","version":"4.4.3"}\n');
const virtualStore = path.join(profileDir, 'node_modules', '.pnpm', 'gwm-transaction-residue');
fs.mkdirSync(virtualStore, { recursive: true });
fs.writeFileSync(path.join(virtualStore, 'marker'), 'new\n');
const sharedResidue = path.join(path.dirname(profileDir), 'node_modules', '@local', 'gwm-transaction-residue');
fs.mkdirSync(sharedResidue, { recursive: true });
fs.writeFileSync(path.join(sharedResidue, 'marker'), 'new\n');
for (const modulesRoot of [path.join(profileDir, 'node_modules'), path.join(path.dirname(profileDir), 'node_modules')]) {
  for (const relative of ['.modules.yaml', '.package-map.json', '.pnpm-workspace-state-v1.json', '.pnpm/lock.yaml']) {
    const metadata = path.join(modulesRoot, relative);
    fs.mkdirSync(path.dirname(metadata), { recursive: true });
    fs.writeFileSync(metadata, 'transaction-value\n', { mode: 0o600 });
    fs.chmodSync(metadata, 0o600);
  }
}
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
    if [[ "${FAKE_DSH_KILL_INSTALLER_PROFILE:-}" == "$profile" ]]; then
      kill -KILL "$PPID"
      exit 137
    fi
    exit 0
  fi
  if [[ "$action" == remove ]]; then
    saw_ignore=0
    names=()
    for argument in "$@"; do
      case "$argument" in
        --config.ignore-scripts=true)
          saw_ignore=1
          ;;
        --ignore-scripts)
          exit 100
          ;;
        @local/*)
          names+=("$argument")
          ;;
        *)
          exit 101
          ;;
      esac
    done
    (( saw_ignore == 1 )) || exit 102
    (( ${#names[@]} > 0 )) || exit 103
    printf 'remove %s %s\n' "$profile" "${names[*]}" >> "$FAKE_DSH_LOG"
    if [[ "${FAKE_DSH_FAIL_REMOVE_PROFILE:-}" == "$profile" ]]; then
      exit 104
    fi
    "$TEST_REAL_NODE" - "$manifest" "$DSH_HOME/profiles/$profile" "${names[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [manifestFile, profileDir, ...names] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
for (const name of names) {
  delete manifest.dependencies?.[name];
  fs.rmSync(path.join(profileDir, 'node_modules', ...name.split('/')), { recursive: true, force: true });
}
const localDirectory = path.join(profileDir, 'node_modules', '@local');
try {
  if (fs.readdirSync(localDirectory).length === 0) fs.rmdirSync(localDirectory);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
fs.rmSync(path.join(profileDir, 'node_modules', 'zod'), { recursive: true, force: true });
fs.rmSync(path.join(profileDir, 'node_modules', '.pnpm', 'gwm-transaction-residue'), { recursive: true, force: true });
const virtualStore = path.join(profileDir, 'node_modules', '.pnpm');
try {
  if (fs.readdirSync(virtualStore).length === 0) fs.rmdirSync(virtualStore);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const sharedResidue = path.join(path.dirname(profileDir), 'node_modules', '@local', 'gwm-transaction-residue');
fs.rmSync(sharedResidue, { recursive: true, force: true });
const sharedLocalDirectory = path.dirname(sharedResidue);
try {
  if (fs.readdirSync(sharedLocalDirectory).length === 0) fs.rmdirSync(sharedLocalDirectory);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
    exit 0
  fi
  exit 95
fi
if [[ "${1:-}" == --profile && "${3:-}" == --dump-config ]]; then
  profile=$2
  [[ -z "${GPU_WORKLOAD_ROLE+x}" && -z "${GPU_WORKLOAD_MANAGER_URL+x}" ]] || exit 98
  layered_values=$("$TEST_REAL_NODE" - "$DSH_HOME/.env" "$PWD/.env" <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const [homeFile, projectFile] = process.argv.slice(2);
const home = fs.existsSync(homeFile) ? parseEnv(fs.readFileSync(homeFile, 'utf8')) : {};
const project = fs.existsSync(projectFile) ? parseEnv(fs.readFileSync(projectFile, 'utf8')) : {};
const values = { ...home, ...project };
const role = values.GPU_WORKLOAD_ROLE;
const url = values.GPU_WORKLOAD_MANAGER_URL;
if (!['server', 'client'].includes(role) || typeof url !== 'string') process.exit(1);
const source = Object.hasOwn(project, 'GPU_WORKLOAD_ROLE') || Object.hasOwn(project, 'GPU_WORKLOAD_MANAGER_URL') ? 'project-env' : 'home-env';
process.stdout.write(`${role}|${url}|${source}`);
NODE
  ) || exit 99
  layered_role=${layered_values%%|*}
  layered_remainder=${layered_values#*|}
  layered_url=${layered_remainder%%|*}
  layered_source=${layered_remainder#*|}
  printf 'dump %s %s %s source=%s\n' "$profile" "$layered_role" "$layered_url" "$layered_source" >> "$FAKE_DSH_LOG"
  if [[ "${FAKE_DSH_FAIL_DUMP_PROFILE:-}" == "$profile" ]]; then
    exit 96
  fi
  printf '%s\n' \
    '- id: gpu-workload-manager' \
    "  name: '@local/dsh-gpu-workload-manager'"
  if [[ "${FAKE_DSH_DISABLE_MANAGER_PROFILE:-}" == "$profile" ]]; then
    printf '%s\n' '  disabled: true'
  fi
  if [[ "$profile" == web ]]; then
    printf '%s\n' \
      '- id: ui-model-selection' \
      "  name: '@deepseek-ai/dsh-client-ui-model-selection'" \
      '  disabled: true' \
      '- id: gpu-workload-model-selection' \
      "  name: '@local/dsh-gpu-model-selection'"
  fi
  exit 0
fi
exit 97
EOF
  chmod +x "$bin_dir/dsh"
}
