#!/usr/bin/env bash

set -uo pipefail

export LC_ALL=C

usage() {
  cat <<'EOF'
Usage: verify-live.sh --role ubuntu|mac [options]

Options:
  --role ubuntu|mac      Required host role.
  --dsh-home ABS_DIR     DSH home to inspect (defaults to $DSH_HOME or ~/.dsh).
  --release-dir ABS_DIR  Ubuntu release directory (defaults to /opt/.../current).
  --release-id SHA256    Expected manifest SHA-256 (defaults to current target name).
  --manager-url URL      Mac manager origin (required for role mac).
  --dsh-only             Verify only prerequisites and the installed DSH bundle.
  --system-only          Ubuntu root stage: verify only release, service, network,
                         credentials, firewall, and model artifacts.
  --fixture-root ABS_DIR Test-only private system root for isolated probes.
  -h, --help             Show this help.

This verifier is read-only. It never changes services, files, firewall rules, or models.
EOF
}

role=''
dsh_home=''
release_dir=''
release_id=''
manager_url=''
dsh_only=0
system_only=0
fixture_root=''
while (($#)); do
  case "$1" in
    --role) (($# >= 2)) || { printf 'verify-live: FAIL missing_role\n' >&2; exit 2; }; role=$2; shift 2 ;;
    --dsh-home) (($# >= 2)) || { printf 'verify-live: FAIL missing_dsh_home\n' >&2; exit 2; }; dsh_home=$2; shift 2 ;;
    --release-dir) (($# >= 2)) || { printf 'verify-live: FAIL missing_release_dir\n' >&2; exit 2; }; release_dir=$2; shift 2 ;;
    --release-id) (($# >= 2)) || { printf 'verify-live: FAIL missing_release_id\n' >&2; exit 2; }; release_id=$2; shift 2 ;;
    --manager-url) (($# >= 2)) || { printf 'verify-live: FAIL missing_manager_url\n' >&2; exit 2; }; manager_url=$2; shift 2 ;;
    --dsh-only) dsh_only=1; shift ;;
    --system-only) system_only=1; shift ;;
    --fixture-root) (($# >= 2)) || { printf 'verify-live: FAIL missing_fixture_root\n' >&2; exit 2; }; fixture_root=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'verify-live: FAIL unknown_argument\n' >&2; exit 2 ;;
  esac
done

if [[ "$role" != ubuntu && "$role" != mac ]]; then
  printf 'verify-live: FAIL role_must_be_ubuntu_or_mac\n' >&2
  exit 2
fi
if [[ "$role" == mac && -z "$manager_url" ]]; then
  printf 'verify-live: FAIL missing_manager_url\n' >&2
  exit 2
fi
if ((dsh_only && system_only)); then
  printf 'verify-live: FAIL verification_scopes_are_mutually_exclusive\n' >&2
  exit 2
fi
if [[ "$role" == mac && $system_only -eq 1 ]]; then
  printf 'verify-live: FAIL system_only_is_ubuntu_only\n' >&2
  exit 2
fi
if [[ -n "$fixture_root" && ( "$role" != ubuntu || $system_only -ne 1 ) ]]; then
  printf 'verify-live: FAIL fixture_root_requires_ubuntu_system_only\n' >&2
  exit 2
fi
if [[ "$role" == ubuntu && $dsh_only -eq 0 && $system_only -eq 0 ]]; then
  printf 'verify-live: FAIL ubuntu_requires_dsh_only_or_system_only\n' >&2
  exit 2
fi

fixture_mode=0
system_root=''
system_scope='system-only'
manager_status_origin='http://127.0.0.1:8080'
if ((system_only)); then
  PATH='/usr/sbin:/usr/bin:/sbin:/bin'
  export PATH
  IFS=$' \t\n'
  unset CDPATH ENV BASH_ENV NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH \
    DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH PYTHONPATH PERL5LIB RUBYLIB
  if [[ -n "$fixture_root" ]]; then
    fixture_gid=$(/usr/bin/env -i PATH="$PATH" LC_ALL=C /usr/bin/id -g)
    if [[ "$fixture_root" != /* || ! -d "$fixture_root" || -L "$fixture_root" || ! -O "$fixture_root" ]] \
      || [[ $(cd "$fixture_root" 2>/dev/null && pwd -P) != "$fixture_root" ]] \
      || [[ $(/usr/bin/env -i PATH="$PATH" LC_ALL=C /usr/bin/stat -c '%a:%u:%g' -- "$fixture_root" 2>/dev/null || true) != "700:$EUID:$fixture_gid" ]]; then
      printf 'verify-live: FAIL unsafe_fixture_root\n' >&2
      exit 2
    fi
    fixture_sentinel="$fixture_root/.verify-live-fixture-v1"
    fixture_origin_file="$fixture_root/.verify-live-manager-origin-v1"
    if [[ ! -f "$fixture_sentinel" || -L "$fixture_sentinel" || ! -O "$fixture_sentinel" ]] \
      || [[ $(/usr/bin/env -i PATH="$PATH" LC_ALL=C /usr/bin/stat -c '%a:%h:%s' -- "$fixture_sentinel" 2>/dev/null || true) != '400:1:44' ]] \
      || ! IFS= read -r fixture_sentinel_value < "$fixture_sentinel" \
      || [[ "$fixture_sentinel_value" != 'gpu-workload-manager verify-live fixture v1' ]]; then
      printf 'verify-live: FAIL unsafe_fixture_sentinel\n' >&2
      exit 2
    fi
    if [[ ! -f "$fixture_origin_file" || -L "$fixture_origin_file" || ! -O "$fixture_origin_file" ]] \
      || [[ $(/usr/bin/env -i PATH="$PATH" LC_ALL=C /usr/bin/stat -c '%a:%h' -- "$fixture_origin_file" 2>/dev/null || true) != '400:1' ]] \
      || ! IFS= read -r manager_status_origin < "$fixture_origin_file" \
      || [[ $(/usr/bin/env -i PATH="$PATH" LC_ALL=C /usr/bin/stat -c '%s' -- "$fixture_origin_file" 2>/dev/null || true) != $((${#manager_status_origin} + 1)) ]] \
      || [[ ! "$manager_status_origin" =~ ^http://127\.0\.0\.1:([1-9][0-9]{0,4})$ ]] \
      || ((10#${BASH_REMATCH[1]} > 65535)); then
      printf 'verify-live: FAIL unsafe_fixture_manager_origin\n' >&2
      exit 2
    fi
    fixture_mode=1
    system_root=$fixture_root
    system_scope='fixture/system-only'
  elif ((EUID != 0)); then
    printf 'verify-live: FAIL system_only_requires_root\n' >&2
    exit 2
  fi
fi

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd "$script_dir/../.." && pwd -P)
node_bin=''
pnpm_bin=''
dsh_bin=''

if (( ! system_only )); then
  invoking_home=${HOME:-}
  if [[ ! -d "$invoking_home" ]] || ! invoking_home=$(cd "$invoking_home" && pwd -P) || [[ ! -O "$invoking_home" ]]; then
    printf 'verify-live: FAIL dsh_only_requires_canonical_invoking_home\n' >&2
    exit 2
  fi
  if [[ -z "$dsh_home" ]]; then
    if [[ -n ${DSH_HOME:-} ]]; then dsh_home=$DSH_HOME; else dsh_home=${HOME:-}/.dsh; fi
  fi
  if [[ ! -d "$dsh_home" ]] || ! dsh_home=$(cd "$dsh_home" && pwd -P) || [[ ! -O "$dsh_home" ]]; then
    printf 'verify-live: FAIL dsh_only_must_run_as_canonical_home_owner\n' >&2
    exit 2
  fi
  node_bin=$(command -v node || true)
  pnpm_bin=$(command -v pnpm || true)
  dsh_bin=$(command -v dsh || true)
  if [[ -n "$node_bin" && $($node_bin --version 2>/dev/null) == v22.* ]]; then pass node_22; else fail node_22; fi
  if [[ -n "$pnpm_bin" && $($pnpm_bin --version 2>/dev/null) == 11.* ]]; then pass pnpm_11; else fail pnpm_11; fi
  if [[ -n "$dsh_bin" && $($dsh_bin --version 2>/dev/null) == 0.1.1-rc.2 ]]; then pass dsh_rc2; else fail dsh_rc2; fi

  expected_url=$manager_url
  [[ "$role" == mac ]] || expected_url='http://127.0.0.1:8080'
  expected_dsh_role=client
  [[ "$role" == mac ]] || expected_dsh_role=server
  package_checksums="$repo_root/dist/packages/SHA256SUMS"
  if [[ -n "$node_bin" && -n "$dsh_bin" && -f "$package_checksums" ]] \
    && "$node_bin" - "$dsh_home" "$expected_dsh_role" "$expected_url" "$dsh_bin" "$package_checksums" "$node_bin" "$invoking_home" 2>/dev/null <<'NODE'
const crypto = require('node:crypto');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const [homeArg, role, expectedUrlArg, dshBin, checksumFile, nodeBin, invokingHomeArg] = process.argv.slice(2);
const home = fs.realpathSync(homeArg);
const invokingHome = fs.realpathSync(invokingHomeArg);
const homeStat = fs.lstatSync(home);
if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) process.exit(1);
const expectedUid = homeStat.uid;
const expectedGid = homeStat.gid;
const invokingHomeStat = fs.lstatSync(invokingHome);
if (!invokingHomeStat.isDirectory() || invokingHomeStat.isSymbolicLink()
  || invokingHomeStat.uid !== expectedUid || invokingHomeStat.gid !== expectedGid) process.exit(1);
let expectedUrl;
try { expectedUrl = new URL(expectedUrlArg).origin; } catch { process.exit(1); }
const envPath = path.join(home, '.env');
const envStat = fs.lstatSync(envPath);
if (!envStat.isFile() || envStat.isSymbolicLink()
  || envStat.uid !== expectedUid || envStat.gid !== expectedGid) process.exit(1);
let env = fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n');
if (env.includes('\r')) process.exit(1);
const begin = '# >>> GPU Workload Manager (managed by install-dsh-bundle.sh) >>>';
const end = '# <<< GPU Workload Manager (managed by install-dsh-bundle.sh) <<<' ;
const lines = env.split('\n');
const begins = lines.reduce((result, line, index) => line === begin ? [...result, index] : result, []);
const ends = lines.reduce((result, line, index) => line === end ? [...result, index] : result, []);
if (begins.length !== 1 || ends.length !== 1 || ends[0] !== begins[0] + 3) process.exit(1);
const block = lines.slice(begins[0], ends[0] + 1);
if (block[1] !== `GPU_WORKLOAD_ROLE=${role}` || block[2] !== `GPU_WORKLOAD_MANAGER_URL=${expectedUrl}`) process.exit(1);
const managedAssignment = /^\s*(?:export\s+)?(GPU_WORKLOAD_ROLE|GPU_WORKLOAD_MANAGER_URL)\s*=/;
for (let index = 0; index < lines.length; index += 1) {
  if (index >= begins[0] && index <= ends[0]) continue;
  if (managedAssignment.test(lines[index])) process.exit(1);
}

const checksumLines = fs.readFileSync(checksumFile, 'utf8').trimEnd().split(/\r?\n/);
const checksums = new Map();
for (const line of checksumLines) {
  const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+\.tgz)$/.exec(line);
  if (!match || checksums.has(match[2])) process.exit(1);
  checksums.set(match[2], match[1]);
}
if (checksums.size !== 3) process.exit(1);
const packageNames = [
  '@local/dsh-gpu-workload-manager',
  '@local/dsh-gpu-model-selection',
  '@local/dsh-gpu-workload-bundle',
];
const controlRoot = path.join(home, '.gpu-workload-manager');
const store = path.join(controlRoot, 'packages');
const storeStat = fs.lstatSync(store);
if (fs.realpathSync(store) !== store || !storeStat.isDirectory() || storeStat.isSymbolicLink()
  || storeStat.uid !== expectedUid || storeStat.gid !== expectedGid) process.exit(1);
const selectedArchives = new Set();
const archivePayloads = new Map();
const tarString = (header, start, length) => {
  const value = header.subarray(start, start + length).toString('utf8');
  const nul = value.indexOf('\0');
  return (nul === -1 ? value : value.slice(0, nul)).trim();
};
const tarOctal = (header, start, length) => {
  const value = tarString(header, start, length);
  if (!/^[0-7]+$/.test(value)) process.exit(1);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) process.exit(1);
  return parsed;
};
const payloadForArchive = archive => {
  const cached = archivePayloads.get(archive);
  if (cached) return cached;
  let tar;
  try { tar = zlib.gunzipSync(fs.readFileSync(archive)); } catch { process.exit(1); }
  const files = new Map();
  const directories = new Set();
  const explicitDirectories = new Set();
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) process.exit(1);
      terminated = true;
      break;
    }
    const storedChecksum = tarOctal(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (checksum !== storedChecksum) process.exit(1);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const entry = prefix ? `${prefix}/${name}` : name;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = tarOctal(header, 124, 12);
    const mode = tarOctal(header, 100, 8) & 0o777;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const normalizedEntry = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (dataEnd > tar.length || (normalizedEntry !== 'package' && !normalizedEntry.startsWith('package/'))) process.exit(1);
    const relative = normalizedEntry === 'package' ? '' : normalizedEntry.slice('package/'.length);
    const parts = relative.split('/');
    if (entry.startsWith('/') || entry.includes('\\') || (relative && parts.some(part => !part || part === '.' || part === '..'))) process.exit(1);
    if (type === '5') {
      if (size !== 0 || (!relative && explicitDirectories.has('')) || (relative && (files.has(relative) || explicitDirectories.has(relative)))) process.exit(1);
      explicitDirectories.add(relative);
      if (relative) directories.add(relative);
    } else if (type === '0') {
      if (!relative || entry.endsWith('/') || files.has(relative) || directories.has(relative)) process.exit(1);
      files.set(relative, Object.freeze({
        hash: crypto.createHash('sha256').update(tar.subarray(dataStart, dataEnd)).digest('hex'),
        mode,
      }));
    } else {
      process.exit(1);
    }
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!terminated || files.size === 0 || !files.has('package.json')) process.exit(1);
  const payload = Object.freeze({ files, directories });
  archivePayloads.set(archive, payload);
  return payload;
};
const verifyInstalledPayload = (profileRoot, linked, archive, expectedName) => {
  const modulesInput = path.join(profileRoot, 'node_modules');
  const modulesInputStat = fs.lstatSync(modulesInput);
  if (!modulesInputStat.isDirectory() || modulesInputStat.isSymbolicLink()
    || modulesInputStat.uid !== expectedUid || modulesInputStat.gid !== expectedGid) process.exit(1);
  const modulesRoot = fs.realpathSync(modulesInput);
  if (modulesRoot !== modulesInput) process.exit(1);
  const installedRoot = fs.realpathSync(linked);
  if (installedRoot !== modulesRoot && !installedRoot.startsWith(`${modulesRoot}${path.sep}`)) process.exit(1);
  const rootStat = fs.lstatSync(installedRoot);
  const rootMode = rootStat.mode & 0o7777;
  if (
    !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || rootStat.uid !== expectedUid
    || rootStat.gid !== expectedGid
    || (rootMode & 0o7000) !== 0
    || (rootMode & 0o002) !== 0
    || (rootMode & 0o700) !== 0o700
  ) process.exit(1);
  const expected = payloadForArchive(archive);
  const foundFiles = new Set();
  const foundDirectories = new Set();
  const visit = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const child = path.join(directory, name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink() || stat.uid !== expectedUid || stat.gid !== expectedGid) process.exit(1);
      if (stat.isDirectory()) {
        const actualMode = stat.mode & 0o7777;
        if (
          !expected.directories.has(childRelative)
          || (actualMode & 0o7000) !== 0
          || (actualMode & 0o002) !== 0
          || (actualMode & 0o700) !== 0o700
        ) process.exit(1);
        foundDirectories.add(childRelative);
        visit(child, childRelative);
      } else if (stat.isFile()) {
        const expectedFile = expected.files.get(childRelative);
        const actualMode = stat.mode & 0o7777;
        if (
          !expectedFile
          || (actualMode & 0o7000) !== 0
          || (actualMode & 0o002) !== 0
          || (actualMode & 0o400) === 0
          || Boolean(actualMode & 0o100) !== Boolean(expectedFile.mode & 0o100)
        ) process.exit(1);
        const actualHash = crypto.createHash('sha256').update(fs.readFileSync(child)).digest('hex');
        if (actualHash !== expectedFile.hash) process.exit(1);
        foundFiles.add(childRelative);
      } else {
        process.exit(1);
      }
    }
  };
  visit(installedRoot);
  if (foundFiles.size !== expected.files.size || foundDirectories.size !== expected.directories.size) process.exit(1);
  const installed = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  if (installed.name !== expectedName || installed.version !== '0.1.0') process.exit(1);
};
for (const profile of ['web', 'headless']) {
  const profileRoot = path.join(home, 'profiles', profile);
  const profileStat = fs.lstatSync(profileRoot);
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()
    || profileStat.uid !== expectedUid || profileStat.gid !== expectedGid) process.exit(1);
  const manifestPath = path.join(profileRoot, 'package.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()
    || manifestStat.uid !== expectedUid || manifestStat.gid !== expectedGid) process.exit(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dependencies = manifest.dependencies ?? {};
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.filter(value => value === '@local/dsh-gpu-workload-bundle').length !== 1) process.exit(1);
  for (const name of packageNames) {
    const spec = dependencies[name];
    if (typeof spec !== 'string' || !spec.startsWith('file:')) process.exit(1);
    const archiveInput = spec.slice('file:'.length);
    if (!path.isAbsolute(archiveInput) || path.normalize(archiveInput) !== archiveInput || path.dirname(archiveInput) !== store) process.exit(1);
    const archiveInputStat = fs.lstatSync(archiveInput);
    if (!archiveInputStat.isFile() || archiveInputStat.isSymbolicLink()
      || archiveInputStat.uid !== expectedUid || archiveInputStat.gid !== expectedGid) process.exit(1);
    const archive = fs.realpathSync(archiveInput);
    const archiveStat = fs.lstatSync(archive);
    if (archive !== archiveInput || path.dirname(archive) !== store || archiveStat.isSymbolicLink() || !archiveStat.isFile()
      || archiveStat.uid !== expectedUid || archiveStat.gid !== expectedGid) process.exit(1);
    const filename = path.basename(archive);
    const expectedPrefix = `${name.slice(1).replace('/', '-')}-0.1.0-`;
    const expectedHash = checksums.get(filename);
    if (!filename.startsWith(expectedPrefix) || !expectedHash || !filename.endsWith(`-${expectedHash}.tgz`)) process.exit(1);
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (actualHash !== expectedHash) process.exit(1);
    selectedArchives.add(filename);
    const linked = path.join(profileRoot, 'node_modules', ...name.split('/'));
    verifyInstalledPayload(profileRoot, linked, archive, name);
  }

  const childEnv = {
    HOME: invokingHome,
    DSH_HOME: home,
    PATH: `${path.dirname(fs.realpathSync(nodeBin))}:/usr/bin:/bin`,
    LC_ALL: 'C',
    LANG: 'C',
  };
  for (const name of ['FAKE_DSH_LOG', 'FAKE_DSH_DISABLE_MANAGER_PROFILE', 'TEST_REAL_NODE']) {
    if (process.env[name]) childEnv[name] = process.env[name];
  }
  const dump = cp.execFileSync(dshBin, ['--profile', profile, '--dump-config'], {
    cwd: home, env: childEnv, uid: expectedUid, gid: expectedGid,
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  const rows = [];
  let current;
  for (const line of dump.split(/\r?\n/)) {
    const match = /^- id: (.+)$/.exec(line);
    if (match) {
      current = { id: match[1].replace(/^['"]|['"]$/g, ''), disabled: false };
      rows.push(current);
    } else if (current && /^  disabled: true$/.test(line)) {
      current.disabled = true;
    }
  }
  const matching = id => rows.filter(row => row.id === id);
  if (matching('gpu-workload-manager').length !== 1 || matching('gpu-workload-manager')[0].disabled) process.exit(1);
  if (profile === 'web') {
    if (matching('ui-model-selection').length !== 1 || !matching('ui-model-selection')[0].disabled) process.exit(1);
    if (matching('gpu-workload-model-selection').length !== 1 || matching('gpu-workload-model-selection')[0].disabled) process.exit(1);
  }
}
if (selectedArchives.size !== 3) process.exit(1);
NODE
then
  pass dsh_same_bundle_role
else
  fail dsh_same_bundle_role
fi

  if ((dsh_only)); then
    if ((failures == 0)); then
      printf 'LIVE VERIFICATION: PASS role=%s scope=dsh-only\n' "$role"
      exit 0
    fi
    printf 'LIVE VERIFICATION: FAIL role=%s scope=dsh-only failed_gates=%d\n' "$role" "$failures"
    exit 1
  fi
fi

if [[ "$role" == mac ]]; then
  if [[ -n "$node_bin" ]] && "$node_bin" - "$manager_url" 2>/dev/null <<'NODE'
const origin = process.argv[2];
let parsed;
try { parsed = new URL(origin); } catch { process.exit(1); }
const octets = parsed.hostname.split('.').map(Number);
const privateIpv4 = octets.length === 4 && octets.every(Number.isInteger)
  && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
if (parsed.protocol !== 'http:' || !parsed.port || !privateIpv4 || parsed.pathname !== '/') process.exit(1);
const response = await fetch(`${parsed.origin}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
if (response?.status !== 200) process.exit(1);
NODE
  then pass mac_lan_health; else fail mac_lan_health; fi
else
  safe_path='/usr/sbin:/usr/bin:/sbin:/bin'
  system_etc="$system_root/etc"
  system_opt="$system_root/opt"
  systemctl_bin="$system_root/usr/bin/systemctl"
  ss_bin="$system_root/usr/bin/ss"
  ufw_bin="$system_root/usr/sbin/ufw"
  id_bin="$system_root/usr/bin/id"
  expected_system_uid=0
  expected_system_gid=0
  if ((fixture_mode)); then
    expected_system_uid=$EUID
    expected_system_gid=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/id -g)
  fi

  trusted_system_tool() {
    local candidate=$1 stat_value mode owner links
    [[ -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]] || return 1
    stat_value=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/stat -c '%u:%a:%h' -- "$candidate" 2>/dev/null) || return 1
    IFS=: read -r owner mode links <<< "$stat_value"
    [[ "$owner" == "$expected_system_uid" && "$links" == 1 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#$mode & 07022) == 0 ))
  }

  trusted_exact_system_file() {
    local candidate=$1 exact_mode=$2 exact_owner=$3 exact_group=$4 stat_value mode owner group links
    [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
    stat_value=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/stat -c '%u:%g:%a:%h' -- "$candidate" 2>/dev/null) || return 1
    IFS=: read -r owner group mode links <<< "$stat_value"
    [[ "$owner" == "$exact_owner" && "$group" == "$exact_group" && "$links" == 1 && "$mode" == "$exact_mode" ]]
  }

  expected_manager_uid=''
  expected_manager_gid=''
  expected_manager_user=agentops
  expected_manager_group=agentops
  manager_identity_ok=0
  if trusted_system_tool "$id_bin"; then
    resolved_manager_uid=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C "$id_bin" -u agentops 2>/dev/null || true)
    resolved_manager_gid=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C "$id_bin" -g agentops 2>/dev/null || true)
    if [[ "$resolved_manager_uid" =~ ^[0-9]+$ && "$resolved_manager_gid" =~ ^[0-9]+$ ]]; then
      if ((fixture_mode)); then
        if [[ "$resolved_manager_uid" == "$EUID" && "$resolved_manager_gid" == "$expected_system_gid" ]]; then
          expected_manager_uid=$resolved_manager_uid
          expected_manager_gid=$resolved_manager_gid
          expected_manager_user=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/id -un)
          expected_manager_group=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/id -gn)
          manager_identity_ok=1
        fi
      elif [[ "$resolved_manager_uid" == 1001 ]]; then
        expected_manager_uid=$resolved_manager_uid
        expected_manager_gid=$resolved_manager_gid
        manager_identity_ok=1
      fi
    fi
  fi
  if ((manager_identity_ok)); then pass ubuntu_manager_account_identity; else fail ubuntu_manager_account_identity; fi

  expected_release_uid=0
  ((fixture_mode)) && expected_release_uid=$EUID

  service_can_traverse() {
    local owner=$1 group=$2 mode=$3 numeric_mode
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
    numeric_mode=$((8#$mode))
    if [[ "$owner" == "$expected_manager_uid" ]]; then
      (( (numeric_mode & 0100) != 0 ))
    elif [[ "$group" == "$expected_manager_gid" ]]; then
      (( (numeric_mode & 0010) != 0 ))
    else
      (( (numeric_mode & 0001) != 0 ))
    fi
  }

  trusted_system_directory_chain() {
    local current=$1 stop=$2 service_required=$3 canonical stat_value owner group mode
    while :; do
      [[ "$current" == "$stop" || "$current" == "$stop/"* ]] || return 1
      [[ -d "$current" && ! -L "$current" ]] || return 1
      canonical=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/readlink -f -- "$current" 2>/dev/null) || return 1
      [[ "$canonical" == "$current" ]] || return 1
      stat_value=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/stat -c '%u:%g:%a' -- "$current" 2>/dev/null) || return 1
      IFS=: read -r owner group mode <<< "$stat_value"
      [[ "$owner" == "$expected_system_uid" && "$group" == "$expected_system_gid" && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
      (( (8#$mode & 07022) == 0 )) || return 1
      if ((service_required)); then
        service_can_traverse "$owner" "$group" "$mode" || return 1
      else
        (( (8#$mode & 0100) != 0 )) || return 1
      fi
      [[ "$current" == "$stop" ]] && return 0
      current=${current%/*}
      [[ -n "$current" ]] || current=/
    done
  }

  validate_release_ancestor_chain() {
    local current=$1 stop=$2 stat_value owner group mode
    ((manager_identity_ok)) || return 1
    while :; do
      [[ -d "$current" && ! -L "$current" ]] || return 1
      stat_value=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/stat -c '%u:%g:%a' -- "$current" 2>/dev/null) || return 1
      IFS=: read -r owner group mode <<< "$stat_value"
      [[ "$owner" == "$expected_release_uid" ]] || return 1
      [[ "$group" == "$expected_system_gid" || "$group" == "$expected_manager_gid" ]] || return 1
      [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
      (( (8#$mode & 07022) == 0 )) || return 1
      service_can_traverse "$owner" "$group" "$mode" || return 1
      [[ "$current" == "$stop" ]] && return 0
      [[ "$current" != / ]] || return 1
      current=${current%/*}
      [[ -n "$current" ]] || current=/
    done
  }

  validate_release_descendant_dir() {
    local current=$1 stat_value owner group mode
    [[ -d "$current" && ! -L "$current" ]] || return 1
    stat_value=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/stat -c '%u:%g:%a' -- "$current" 2>/dev/null) || return 1
    IFS=: read -r owner group mode <<< "$stat_value"
    [[ "$owner" == "$expected_release_uid" && "$group" == "$expected_manager_gid" && "$mode" == 550 ]]
  }

  release_real=''
  release_node=''
  release_integrity_ok=0
  release_policy_root=/opt
  [[ -n "$release_dir" ]] || release_dir="$system_opt/qwen38-workload-manager/current"
  if ((fixture_mode)); then release_policy_root="$fixture_root/opt"; fi

  release_parent=${release_dir%/*}
  [[ -n "$release_parent" ]] || release_parent=/
  release_parent_real=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/readlink -f -- "$release_parent" 2>/dev/null || true)
  candidate_release_real=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/readlink -f -- "$release_dir" 2>/dev/null || true)
  if [[ -n "$candidate_release_real" && "$candidate_release_real" == "$release_policy_root/qwen38-workload-manager/"* \
      && -n "$release_parent_real" && ( "$release_parent_real" == "$release_policy_root" || "$release_parent_real" == "$release_policy_root/"* ) ]] \
    && validate_release_ancestor_chain "$candidate_release_real" "$release_policy_root" \
    && validate_release_ancestor_chain "$release_parent_real" "$release_policy_root"; then
    release_real=$candidate_release_real
  fi
  if [[ -z "$release_id" && -n "$release_real" ]]; then release_id=${release_real##*/}; fi

  bootstrap_ok=$manager_identity_ok
  [[ -n "$release_real" && "$release_id" =~ ^[0-9a-f]{64}$ && ${release_real##*/} == "$release_id" ]] || bootstrap_ok=0
  release_manifest="$release_real/release.manifest"
  release_node="$release_real/node-v22/bin/node"
  if ((bootstrap_ok)); then
    validate_release_descendant_dir "$release_real/node-v22" \
      && validate_release_descendant_dir "$release_real/node-v22/bin" || bootstrap_ok=0
  fi
  if ((bootstrap_ok)); then
    for bootstrap_file in "$release_manifest" "$release_node"; do
      [[ -f "$bootstrap_file" && ! -L "$bootstrap_file" ]] || { bootstrap_ok=0; break; }
      bootstrap_stat=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/stat -c '%u:%g:%a:%h' -- "$bootstrap_file" 2>/dev/null || true)
      IFS=: read -r bootstrap_owner bootstrap_group bootstrap_mode bootstrap_links <<< "$bootstrap_stat"
      expected_bootstrap_mode=440
      [[ "$bootstrap_file" != "$release_node" ]] || expected_bootstrap_mode=550
      if [[ "$bootstrap_owner" != "$expected_release_uid" || "$bootstrap_group" != "$expected_manager_gid" \
        || "$bootstrap_mode" != "$expected_bootstrap_mode" || "$bootstrap_links" != 1 ]]; then
        bootstrap_ok=0
        break
      fi
    done
  fi
  [[ $bootstrap_ok -eq 0 || -x "$release_node" ]] || bootstrap_ok=0
  if ((bootstrap_ok)); then
    manifest_digest=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/sha256sum -- "$release_manifest" 2>/dev/null || true)
    manifest_digest=${manifest_digest%% *}
    [[ "$manifest_digest" == "$release_id" ]] || bootstrap_ok=0
  fi
  node_manifest_hash=''
  manifest_previous=''
  if ((bootstrap_ok)); then
    while IFS= read -r manifest_line || [[ -n "$manifest_line" ]]; do
      if [[ ! "$manifest_line" =~ ^([0-9a-f]{64})\ \ ([A-Za-z0-9][A-Za-z0-9._/-]*)$ ]]; then
        bootstrap_ok=0
        break
      fi
      manifest_relative=${BASH_REMATCH[2]}
      if [[ "$manifest_relative" == release.manifest || "$manifest_relative" == *//* \
          || "$manifest_relative" == .. || "$manifest_relative" == ../* \
          || "$manifest_relative" == */.. || "$manifest_relative" == */../* \
          || ( -n "$manifest_previous" && ( "$manifest_relative" < "$manifest_previous" || "$manifest_relative" == "$manifest_previous" ) ) ]]; then
        bootstrap_ok=0
        break
      fi
      manifest_previous=$manifest_relative
      if [[ "$manifest_relative" == node-v22/bin/node ]]; then
        [[ -z "$node_manifest_hash" ]] || { bootstrap_ok=0; break; }
        node_manifest_hash=${BASH_REMATCH[1]}
      fi
    done < "$release_manifest"
    [[ -n "$node_manifest_hash" ]] || bootstrap_ok=0
  fi
  if ((bootstrap_ok)); then
    node_digest=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/sha256sum -- "$release_node" 2>/dev/null || true)
    node_digest=${node_digest%% *}
    [[ "$node_digest" == "$node_manifest_hash" ]] || bootstrap_ok=0
  fi
  if ((bootstrap_ok)); then
    release_node_version=$(/usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C "$release_node" --version 2>/dev/null || true)
    [[ "$release_node_version" == v22.* ]] || bootstrap_ok=0
  fi

  validate_current_release_link() {
    local workload_root current_link link_stat link_owner link_group link_count link_target link_real
    workload_root="$system_opt/qwen38-workload-manager"
    current_link="$workload_root/current"
    trusted_system_directory_chain "$workload_root" "$system_opt" 1 || return 1
    [[ -L "$current_link" ]] || return 1
    link_stat=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/stat -c '%u:%g:%h' -- "$current_link" 2>/dev/null) || return 1
    IFS=: read -r link_owner link_group link_count <<< "$link_stat"
    [[ "$link_owner" == "$expected_system_uid" && "$link_group" == "$expected_system_gid" && "$link_count" == 1 ]] || return 1
    link_target=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/readlink -- "$current_link" 2>/dev/null) || return 1
    [[ "$link_target" == "$release_real" ]] || return 1
    link_real=$(/usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/readlink -f -- "$current_link" 2>/dev/null) || return 1
    [[ "$link_real" == "$release_real" ]]
  }

  if ((bootstrap_ok)) && validate_current_release_link \
    && /usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C \
    "$release_node" - "$release_real" "$release_id" "$expected_release_uid" "$expected_manager_gid" 2>/dev/null <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [release, expectedId, expectedOwnerArg, expectedGroupArg] = process.argv.slice(2);
const expectedOwner = Number(expectedOwnerArg);
const expectedGroup = Number(expectedGroupArg);
if (!Number.isSafeInteger(expectedOwner) || expectedOwner < 0
  || !Number.isSafeInteger(expectedGroup) || expectedGroup < 0) process.exit(1);
const real = fs.realpathSync(release);
if (real !== release || path.basename(real) !== expectedId) process.exit(1);
const rootStat = fs.lstatSync(real);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== expectedOwner
  || rootStat.gid !== expectedGroup || (rootStat.mode & 0o7777) !== 0o550) process.exit(1);
const manifestPath = path.join(real, 'release.manifest');
const manifestStat = fs.lstatSync(manifestPath);
if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1
  || manifestStat.uid !== expectedOwner || manifestStat.gid !== expectedGroup
  || (manifestStat.mode & 0o7777) !== 0o440) process.exit(1);
const manifest = fs.readFileSync(manifestPath);
if (crypto.createHash('sha256').update(manifest).digest('hex') !== expectedId) process.exit(1);
const listed = new Map();
let previous = '';
for (const line of manifest.toString('utf8').trimEnd().split('\n')) {
  const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(line);
  const components = match?.[2].split('/');
  if (!match || match[2] <= previous || match[2] === 'release.manifest' || match[2].includes('//')
    || components.some(component => component === '.' || component === '..') || listed.has(match[2])) process.exit(1);
  listed.set(match[2], match[1]); previous = match[2];
}
for (const required of [
  'node-v22/bin/node', 'dist/canary.js', 'dist/managerd.js', 'dist/package.json',
  'canary/fake-canary', 'canary/real-canary',
  'config/manager.production.json', 'config/models.production.json',
  'systemd/qwen38-workload-manager.service', 'verify/preflight-ubuntu.sh', 'verify/verify-live.sh',
]) if (!listed.has(required)) process.exit(1);
const executables = new Set(['node-v22/bin/node', 'canary/fake-canary', 'canary/real-canary', 'verify/preflight-ubuntu.sh']);
const found = [];
const visit = (directory, relative = '') => {
  for (const name of fs.readdirSync(directory).sort()) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const child = path.join(directory, name);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink() || stat.uid !== expectedOwner || stat.gid !== expectedGroup) process.exit(1);
    if (stat.isDirectory() && (stat.mode & 0o7777) === 0o550) visit(child, childRelative);
    else if (stat.isFile() && stat.nlink === 1
      && (stat.mode & 0o7777) === (executables.has(childRelative) ? 0o550 : 0o440)) found.push(childRelative);
    else process.exit(1);
  }
};
visit(real);
const payloads = found.filter(value => value !== 'release.manifest');
if (payloads.length !== listed.size || payloads.some(value => !listed.has(value))) process.exit(1);
for (const [relative, expected] of listed) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(real, relative))).digest('hex');
  if (actual !== expected) process.exit(1);
}
const runtime = JSON.parse(fs.readFileSync(path.join(real, 'dist/package.json'), 'utf8'));
if (runtime.type !== 'module') process.exit(1);
NODE
  then
    node_bin=$release_node
    release_integrity_ok=1
    pass ubuntu_release_integrity
  else
    node_bin=''
    fail ubuntu_release_integrity
  fi

  manager_config="$system_etc/qwen38-workload-manager/manager.production.json"
  models_config="$system_etc/qwen38-workload-manager/models.production.json"
  systemd_unit="$system_etc/systemd/system/qwen38-workload-manager.service"
  if ((release_integrity_ok)) \
    && trusted_system_directory_chain "$system_etc/qwen38-workload-manager" "$system_etc" 1 \
    && trusted_system_directory_chain "$system_etc/systemd/system" "$system_etc" 0 \
    && trusted_exact_system_file "$manager_config" 644 "$expected_system_uid" "$expected_system_gid" \
    && trusted_exact_system_file "$models_config" 644 "$expected_system_uid" "$expected_system_gid" \
    && trusted_exact_system_file "$systemd_unit" 644 "$expected_system_uid" "$expected_system_gid" \
    && /usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/cmp -s -- "$release_real/config/manager.production.json" "$manager_config" \
    && /usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/cmp -s -- "$release_real/config/models.production.json" "$models_config" \
    && /usr/bin/env -i PATH="$safe_path" LC_ALL=C /usr/bin/cmp -s -- "$release_real/systemd/qwen38-workload-manager.service" "$systemd_unit"; then
    pass ubuntu_exact_runtime_config
  else
    fail ubuntu_exact_runtime_config
  fi

  systemctl_ok=0
  if trusted_system_tool "$systemctl_bin" \
    && /usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C "$systemctl_bin" is-active --quiet qwen38-workload-manager.service 2>/dev/null; then
    systemctl_ok=1
    pass ubuntu_manager_active
  else
    fail ubuntu_manager_active
  fi
  expected_control_group=/system.slice/qwen38-workload-manager.service
  ((fixture_mode)) && expected_control_group=''

  read_loaded_unit_identity() {
    local systemctl_show show_ok=1 show_key show_value
    local show_load='' show_load_count=0 show_unit_file='' show_unit_file_count=0
    local show_active='' show_active_count=0 show_sub='' show_sub_count=0
    local show_reload='' show_reload_count=0 show_fragment='' show_fragment_count=0
    local show_dropins='' show_dropins_count=0 show_user='' show_user_count=0
    local show_runtime_group='' show_runtime_group_count=0 show_main_count=0 show_group_count=0
    attested_main_pid=''
    attested_control_group=''
    trusted_system_tool "$systemctl_bin" \
      && /usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C "$systemctl_bin" is-active --quiet qwen38-workload-manager.service 2>/dev/null \
      && systemctl_show=$(/usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C \
        "$systemctl_bin" show qwen38-workload-manager.service \
          --property=LoadState --property=UnitFileState --property=ActiveState --property=SubState \
          --property=NeedDaemonReload --property=FragmentPath --property=DropInPaths \
          --property=User --property=Group --property=MainPID --property=ControlGroup 2>/dev/null) || return 1
    while IFS='=' read -r show_key show_value; do
      case "$show_key" in
        LoadState) show_load=$show_value; show_load_count=$((show_load_count + 1)) ;;
        UnitFileState) show_unit_file=$show_value; show_unit_file_count=$((show_unit_file_count + 1)) ;;
        ActiveState) show_active=$show_value; show_active_count=$((show_active_count + 1)) ;;
        SubState) show_sub=$show_value; show_sub_count=$((show_sub_count + 1)) ;;
        NeedDaemonReload) show_reload=$show_value; show_reload_count=$((show_reload_count + 1)) ;;
        FragmentPath) show_fragment=$show_value; show_fragment_count=$((show_fragment_count + 1)) ;;
        DropInPaths) show_dropins=$show_value; show_dropins_count=$((show_dropins_count + 1)) ;;
        User) show_user=$show_value; show_user_count=$((show_user_count + 1)) ;;
        Group) show_runtime_group=$show_value; show_runtime_group_count=$((show_runtime_group_count + 1)) ;;
        MainPID) attested_main_pid=$show_value; show_main_count=$((show_main_count + 1)) ;;
        ControlGroup) attested_control_group=$show_value; show_group_count=$((show_group_count + 1)) ;;
        *) show_ok=0 ;;
      esac
    done <<< "$systemctl_show"
    [[ $show_ok -eq 1 && $show_load_count -eq 1 && $show_unit_file_count -eq 1 && $show_active_count -eq 1 \
      && $show_sub_count -eq 1 && $show_reload_count -eq 1 && $show_fragment_count -eq 1 \
      && $show_dropins_count -eq 1 && $show_user_count -eq 1 && $show_runtime_group_count -eq 1 \
      && $show_main_count -eq 1 && $show_group_count -eq 1 ]] || return 1
    [[ "$show_load" == loaded && "$show_unit_file" == enabled \
      && "$show_active" == active && "$show_sub" == running && "$show_reload" == no \
      && "$show_fragment" == "$systemd_unit" && -z "$show_dropins" \
      && "$show_user" == "$expected_manager_user" && "$show_runtime_group" == "$expected_manager_group" ]] || return 1
    ((fixture_mode)) || [[ "$attested_control_group" == "$expected_control_group" ]] || return 1
    [[ "$attested_main_pid" =~ ^[1-9][0-9]*$ && "$attested_control_group" == /* && "$attested_control_group" != *..* ]]
  }

  main_pid=''
  control_group=''
  loaded_unit_ok=0
  if ((systemctl_ok && manager_identity_ok)) && read_loaded_unit_identity; then
    main_pid=$attested_main_pid
    control_group=$attested_control_group
    loaded_unit_ok=1
  fi
  if ((loaded_unit_ok)); then pass ubuntu_loaded_unit_identity; else fail ubuntu_loaded_unit_identity; fi

  require_exclusive_cgroup=0
  ((EUID == 0 && fixture_mode == 0)) && require_exclusive_cgroup=1

  verify_manager_process_identity() {
    local candidate_pid=$1 candidate_control_group=$2
    ((release_integrity_ok && manager_identity_ok)) && /usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C \
    "$node_bin" - "$candidate_pid" "$candidate_control_group" "$release_real" "$manager_config" "$models_config" \
    "$require_exclusive_cgroup" "$expected_manager_uid" "$expected_manager_gid" 2>/dev/null <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [pidText, controlGroup, release, managerConfig, modelsConfig, exclusiveArg, expectedUid, expectedGid] = process.argv.slice(2);
if (!/^[1-9][0-9]*$/.test(pidText) || !controlGroup.startsWith('/') || controlGroup.includes('..')) process.exit(1);
const pid = Number(pidText);
if (!Number.isSafeInteger(pid) || pid <= 1) process.exit(1);
const procRoot = `/proc/${pid}`;
const runtime = path.join(release, 'node-v22/bin/node');
const manager = path.join(release, 'dist/managerd.js');
if (fs.realpathSync(path.join(procRoot, 'exe')) !== runtime || fs.realpathSync(path.join(procRoot, 'cwd')) !== release) process.exit(1);
const status = fs.readFileSync(path.join(procRoot, 'status'), 'utf8');
const uid = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m.exec(status);
const gid = /^Gid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m.exec(status);
if (!uid || !gid || uid.slice(1).some(value => value !== expectedUid) || gid.slice(1).some(value => value !== expectedGid)) process.exit(1);
const argv = fs.readFileSync(path.join(procRoot, 'cmdline')).toString('utf8').split('\0');
if (argv.at(-1) === '') argv.pop();
if (argv.length !== 6 || fs.realpathSync(argv[0]) !== runtime || fs.realpathSync(argv[1]) !== manager
  || argv[2] !== '--manager-config' || argv[3] !== managerConfig
  || argv[4] !== '--models-config' || argv[5] !== modelsConfig) process.exit(1);
const cgroupPaths = fs.readFileSync(path.join(procRoot, 'cgroup'), 'utf8').trim().split('\n').map(line => line.split(':').slice(2).join(':'));
if (!cgroupPaths.includes(controlGroup)) process.exit(1);
if (exclusiveArg === '1') {
  const members = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    try {
      const paths = fs.readFileSync(`/proc/${entry}/cgroup`, 'utf8').trim().split('\n').map(line => line.split(':').slice(2).join(':'));
      if (paths.includes(controlGroup)) members.push(Number(entry));
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') process.exit(1);
    }
  }
  if (members.length !== 1 || members[0] !== pid) process.exit(1);
}
NODE
  }

  read_manager_process_groups() {
    local candidate_pid=$1 status_line groups_line='' groups_count=0 candidate_gid normalized_groups=''
    [[ "$candidate_pid" =~ ^[1-9][0-9]*$ ]] || return 1
    while IFS= read -r status_line; do
      if [[ "$status_line" == Groups:$'\t'* ]]; then
        groups_line=${status_line#Groups:$'\t'}
        groups_count=$((groups_count + 1))
      fi
    done < "/proc/$candidate_pid/status" || return 1
    [[ $groups_count -eq 1 && -n "$groups_line" ]] || return 1
    for candidate_gid in $groups_line; do
      [[ "$candidate_gid" =~ ^[0-9]+$ ]] || return 1
      [[ " $normalized_groups " != *" $candidate_gid "* ]] || return 1
      normalized_groups="${normalized_groups:+$normalized_groups }$candidate_gid"
    done
    [[ " $normalized_groups " == *" $expected_manager_gid "* ]] || return 1
    attested_manager_groups=$normalized_groups
  }

  manager_process_ok=0
  manager_process_groups=''
  if ((loaded_unit_ok)) && verify_manager_process_identity "$main_pid" "$control_group" \
    && read_manager_process_groups "$main_pid"; then
    manager_process_groups=$attested_manager_groups
    manager_process_ok=1
    pass ubuntu_manager_process_identity
  else
    fail ubuntu_manager_process_identity
  fi

  verify_manager_listener_identity() {
    local candidate_pid=$1 listener_output listener_line listener_state listener_recv listener_send listener_local listener_peer listener_process listener_extra
    trusted_system_tool "$ss_bin" \
      && listener_output=$(/usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C "$ss_bin" -H -ltnp 'sport = :8080' 2>/dev/null) || return 1
    [[ -n "$listener_output" && "$listener_output" != *$'\n'* ]] || return 1
    listener_line=$listener_output
    read -r listener_state listener_recv listener_send listener_local listener_peer listener_process listener_extra <<< "$listener_line"
    [[ "$listener_state" == LISTEN && "$listener_recv" =~ ^[0-9]+$ && "$listener_send" =~ ^[0-9]+$ \
      && "$listener_local" == 0.0.0.0:8080 && "$listener_peer" == 0.0.0.0:\* && -z "$listener_extra" \
      && "$listener_process" =~ ^users:\(\(\"node\",pid=([1-9][0-9]*),fd=[0-9]+\)\)$ \
      && "${BASH_REMATCH[1]}" == "$candidate_pid" ]]
  }

  manager_listener_ok=0
  if ((loaded_unit_ok && manager_process_ok)) && verify_manager_listener_identity "$main_pid"; then
    manager_listener_ok=1
    pass ubuntu_manager_listener_identity
  else
    fail ubuntu_manager_listener_identity
  fi

  credential_root="$system_etc/qwen38-workload-manager/credentials"
  verify_authenticated_restart_empty() {
    /usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C \
    "$node_bin" - "$credential_root/management.key" "$credential_root/inference.key" \
    "$expected_system_uid" "$expected_system_gid" "$manager_status_origin" 2>/dev/null <<'NODE'
const { readFileSync, lstatSync, realpathSync } = require('node:fs');
const path = require('node:path');
(async () => {
const [credentialPath, inferencePath, expectedUidArg, expectedGidArg, managerOrigin] = process.argv.slice(2);
const expectedUid = Number(expectedUidArg);
const expectedGid = Number(expectedGidArg);
const credentialRoot = path.dirname(credentialPath);
if (path.dirname(inferencePath) !== credentialRoot || realpathSync(credentialRoot) !== credentialRoot) process.exit(1);
const credentialRootStat = lstatSync(credentialRoot);
if (!credentialRootStat.isDirectory() || credentialRootStat.isSymbolicLink()
  || credentialRootStat.uid !== expectedUid || credentialRootStat.gid !== expectedGid
  || (credentialRootStat.mode & 0o7777) !== 0o700) process.exit(1);
const managerStat = lstatSync(credentialPath);
const inferenceStat = lstatSync(inferencePath);
for (const stat of [managerStat, inferenceStat]) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
    || stat.uid !== expectedUid || stat.gid !== expectedGid) process.exit(1);
}
if (managerStat.dev === inferenceStat.dev && managerStat.ino === inferenceStat.ino) process.exit(1);
const parseKey = file => {
  const raw = readFileSync(file, 'utf8');
  const value = raw.length === 65 && raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (value.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(value)) process.exit(1);
  return value;
};
const managementKey = parseKey(credentialPath);
const inferenceKey = parseKey(inferencePath);
if (managementKey.toLowerCase() === inferenceKey.toLowerCase()) process.exit(1);
const request = async (pathname, key) => fetch(`${managerOrigin}${pathname}`, {
  headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000),
}).catch(() => undefined);
const managementResponse = await request('/gpu/v1/status', managementKey);
if (managementResponse?.status !== 200) process.exit(1);
const status = await managementResponse.json();
if (status.phase !== 'UNLOADED' || status.activeModel !== undefined || status.activeRequestCount !== 0 || status.activeOperation !== undefined) process.exit(1);
const inferenceResponse = await request('/v1/models', inferenceKey);
if (inferenceResponse?.status !== 200) process.exit(1);
const models = await inferenceResponse.json();
if (models?.object !== 'list' || !Array.isArray(models.data)) process.exit(1);
const managementCrossRealm = await request('/v1/models', managementKey);
if (managementCrossRealm?.status !== 401) process.exit(1);
await managementCrossRealm.arrayBuffer();
const inferenceCrossRealm = await request('/gpu/v1/status', inferenceKey);
if (inferenceCrossRealm?.status !== 401) process.exit(1);
await inferenceCrossRealm.arrayBuffer();
})().catch(() => process.exit(1));
NODE
  }

  credential_probe_ok=0
  if ((release_integrity_ok && loaded_unit_ok && manager_process_ok && manager_listener_ok)) \
    && verify_authenticated_restart_empty; then
    credential_probe_ok=1
    pass ubuntu_restart_empty_authenticated
  else
    fail ubuntu_restart_empty_authenticated
  fi

  verify_no_resident_child() {
    local child_listener_output
    trusted_system_tool "$ss_bin" \
      && child_listener_output=$(/usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C "$ss_bin" -H -ltnp 'sport = :18080' 2>/dev/null) \
      && [[ -z "$child_listener_output" ]]
  }

  if verify_no_resident_child; then
    pass ubuntu_no_resident_child
  else
    fail ubuntu_no_resident_child
  fi

  verify_pinned_firewall_preflight() {
    local preflight_script="$release_dir/verify/preflight-ubuntu.sh" command_path output
    trusted_system_tool "$preflight_script" || return 1
    command_path="$safe_path"
    if ((fixture_mode)); then
      command_path="$system_root/usr/sbin:$system_root/usr/bin:$safe_path"
    fi
    if ((fixture_mode)); then
      output=$(/usr/bin/env -i PATH="$command_path" HOME=/root LC_ALL=C /usr/bin/bash \
        "$preflight_script" --release-dir "$release_dir" --release-id "$release_id" \
        --fixture-root "$system_root" --firewall-only 2>&1) || return 1
    else
      output=$(/usr/bin/env -i PATH="$command_path" HOME=/root LC_ALL=C /usr/bin/bash \
        "$preflight_script" --release-dir "$release_dir" --release-id "$release_id" \
        --firewall-only 2>&1) || return 1
    fi
    [[ "$output" == *'preflight-ubuntu: PASS scope=firewall-only'* ]]
  }

  if verify_pinned_firewall_preflight; then
    pass ubuntu_trusted_lan_firewall
  else
    fail ubuntu_trusted_lan_firewall
  fi

  catalog=$models_config
  artifact_stop=/
  ((fixture_mode)) && artifact_stop=$fixture_root
  if ((release_integrity_ok && manager_identity_ok)) && /usr/bin/env -i PATH="$safe_path" HOME=/root LC_ALL=C \
    "$node_bin" - "$catalog" "$artifact_stop" "$expected_manager_uid" "$expected_manager_gid" \
      "$expected_system_uid" "$manager_process_groups" 2>/dev/null <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
const [catalogPath, stop, managerUidArg, managerGidArg, systemUidArg, serviceGroupsArg] = process.argv.slice(2);
const managerUid = Number(managerUidArg);
const managerGid = Number(managerGidArg);
const systemUid = Number(systemUidArg);
if ([managerUid, managerGid, systemUid].some(value => !Number.isSafeInteger(value) || value < 0)
  || !/^[0-9]+(?: [0-9]+)*$/.test(serviceGroupsArg)) process.exit(1);
const serviceGroups = new Set(serviceGroupsArg.split(' ').map(Number));
if (!serviceGroups.has(managerGid) || serviceGroups.size !== serviceGroupsArg.split(' ').length) process.exit(1);
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const trustedOwner = stat => stat.uid === systemUid || stat.uid === managerUid;
const serviceHas = (stat, ownerBit, groupBit, otherBit) => stat.uid === managerUid
  ? (stat.mode & ownerBit) !== 0
  : serviceGroups.has(stat.gid) ? (stat.mode & groupBit) !== 0 : (stat.mode & otherBit) !== 0;
const validateAncestors = file => {
  let current = path.dirname(file);
  while (true) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner(stat)
      || (stat.mode & 0o7022) !== 0 || !serviceHas(stat, 0o100, 0o010, 0o001)) process.exit(1);
    if (current === stop) break;
    if (current === '/') process.exit(1);
    current = path.dirname(current);
  }
};
const artifacts = [{ artifact: catalog.binary, executable: true }, ...catalog.models.map(artifact => ({ artifact, executable: false }))];
for (const { artifact, executable } of artifacts) {
  if (!path.isAbsolute(artifact.path) || (stop !== '/' && artifact.path !== stop && !artifact.path.startsWith(`${stop}${path.sep}`))) process.exit(1);
  const real = fs.realpathSync(artifact.path);
  if (real !== artifact.path) process.exit(1);
  const stat = fs.lstatSync(real);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !trustedOwner(stat)
    || (stat.mode & 0o7022) !== 0 || stat.size !== artifact.bytes
    || (executable ? !serviceHas(stat, 0o100, 0o010, 0o001) : !serviceHas(stat, 0o400, 0o040, 0o004))) process.exit(1);
  validateAncestors(real);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(real).on('data', chunk => hash.update(chunk)).on('end', resolve).on('error', reject));
  if (hash.digest('hex') !== artifact.sha256) process.exit(1);
}
})().catch(() => process.exit(1));
NODE
  then pass ubuntu_strict_artifact_integrity; else fail ubuntu_strict_artifact_integrity; fi

  final_runtime_binding_ok=0
  if ((credential_probe_ok)) && read_loaded_unit_identity; then
    final_pre_pid=$attested_main_pid
    final_pre_control_group=$attested_control_group
    if [[ "$final_pre_pid" == "$main_pid" && "$final_pre_control_group" == "$control_group" ]] \
      && verify_manager_process_identity "$final_pre_pid" "$final_pre_control_group" \
      && read_manager_process_groups "$final_pre_pid" \
      && [[ "$attested_manager_groups" == "$manager_process_groups" ]] \
      && verify_manager_listener_identity "$final_pre_pid" \
      && verify_no_resident_child \
      && verify_authenticated_restart_empty \
      && read_loaded_unit_identity; then
      final_post_pid=$attested_main_pid
      final_post_control_group=$attested_control_group
      if [[ "$final_post_pid" == "$main_pid" && "$final_post_control_group" == "$control_group" ]] \
        && verify_manager_process_identity "$final_post_pid" "$final_post_control_group" \
        && read_manager_process_groups "$final_post_pid" \
        && [[ "$attested_manager_groups" == "$manager_process_groups" ]] \
        && verify_manager_listener_identity "$final_post_pid" \
        && verify_no_resident_child; then
        final_runtime_binding_ok=1
      fi
    fi
  fi
  if ((final_runtime_binding_ok)); then pass ubuntu_final_runtime_binding; else fail ubuntu_final_runtime_binding; fi
fi

if ((failures == 0)); then
  if ((system_only)); then
    printf 'LIVE VERIFICATION: PASS role=%s scope=%s\n' "$role" "$system_scope"
  else
    printf 'LIVE VERIFICATION: PASS role=%s\n' "$role"
  fi
  exit 0
fi
if ((system_only)); then
  printf 'LIVE VERIFICATION: FAIL role=%s scope=%s failed_gates=%d\n' "$role" "$system_scope" "$failures"
else
  printf 'LIVE VERIFICATION: FAIL role=%s failed_gates=%d\n' "$role" "$failures"
fi
exit 1
