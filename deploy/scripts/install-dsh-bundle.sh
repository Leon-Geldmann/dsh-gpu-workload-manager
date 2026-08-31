#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly EXPECTED_DSH_VERSION='0.1.1-rc.2'
readonly EXPECTED_NODE_MAJOR=22
readonly EXPECTED_PNPM_MAJOR=11
readonly RELEASE_VERSION='0.1.0'
readonly MANAGER_PACKAGE='@local/dsh-gpu-workload-manager'
readonly SELECTOR_PACKAGE='@local/dsh-gpu-model-selection'
readonly BUNDLE_PACKAGE='@local/dsh-gpu-workload-bundle'

if [[ "${GWM_INSTALL_PROCESS_GROUP:-}" == 1 ]]; then
  installer_pgid=$(/bin/ps -p "$$" -o pgid= 2>/dev/null)
  installer_pgid=${installer_pgid//[[:space:]]/}
  if [[ -z "$installer_pgid" || "$installer_pgid" != "$$" ]]; then
    printf 'install-dsh-bundle: supervised installer is not its process-group leader\n' >&2
    exit 1
  fi
  unset GWM_INSTALL_PROCESS_GROUP
else
  supervisor_node=$(command -v node || true)
  if [[ -z "$supervisor_node" ]]; then
    printf 'install-dsh-bundle: node is not available on PATH\n' >&2
    exit 1
  fi
  exec "$supervisor_node" - installer-supervisor "$0" "$@" <<'NODE'
const cp = require('node:child_process');
const os = require('node:os');
const [_action, script, ...args] = process.argv.slice(2);
const child = cp.spawn(script, args, {
  detached: true,
  env: { ...process.env, GWM_INSTALL_PROCESS_GROUP: '1' },
  stdio: 'inherit',
});
if (!Number.isSafeInteger(child.pid) || child.pid <= 1) process.exit(1);
const forward = signal => {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
};
const handlers = new Map();
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  const handler = () => forward(signal);
  handlers.set(signal, handler);
  process.on(signal, handler);
}
child.once('error', () => { process.exitCode = 1; });
child.once('exit', (code, signal) => {
  for (const [name, handler] of handlers) process.removeListener(name, handler);
  process.exitCode = code ?? (128 + (os.constants.signals[signal] || 1));
});
NODE
fi

usage() {
  cat <<'EOF'
Usage: install-dsh-bundle.sh --role server|client [options]

Options:
  --role server|client   Required machine role.
  --manager-url URL      Manager origin. Defaults to loopback for server and
                         is required for client.
  --dsh-home PATH        Existing DSH home (defaults to $DSH_HOME or ~/.dsh).
  -h, --help             Show this help.

This command installs the same three release tarballs into both the web and
headless profiles. It never restarts DSH or any service.
EOF
}

die() {
  printf 'install-dsh-bundle: %s\n' "$*" >&2
  exit 1
}

role=''
manager_url=''
dsh_home_arg=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      [[ $# -ge 2 ]] || die '--role requires a value'
      role=$2
      shift 2
      ;;
    --manager-url)
      [[ $# -ge 2 ]] || die '--manager-url requires a value'
      manager_url=$2
      shift 2
      ;;
    --dsh-home)
      [[ $# -ge 2 ]] || die '--dsh-home requires a value'
      dsh_home_arg=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ "$role" == server || "$role" == client ]] || die '--role must be server or client'
if [[ -z "$manager_url" ]]; then
  if [[ "$role" == server ]]; then
    manager_url='http://127.0.0.1:8080'
  else
    die '--manager-url is required for role client'
  fi
fi

if [[ -z "$dsh_home_arg" ]]; then
  if [[ -n "${DSH_HOME:-}" ]]; then
    dsh_home_arg=$DSH_HOME
  else
    [[ -n "${HOME:-}" ]] || die 'neither --dsh-home, DSH_HOME, nor HOME is available'
    dsh_home_arg="$HOME/.dsh"
  fi
fi
[[ -d "$dsh_home_arg" ]] || die "DSH home does not exist: $dsh_home_arg"
dsh_home=$(cd "$dsh_home_arg" && pwd -P)

node_bin=$(command -v node || true)
pnpm_bin=$(command -v pnpm || true)
dsh_bin=$(command -v dsh || true)
[[ -n "$node_bin" ]] || die 'node is not available on PATH'
[[ -n "$pnpm_bin" ]] || die 'pnpm is not available on PATH'
[[ -n "$dsh_bin" ]] || die 'dsh is not available on PATH'

node_version=$("$node_bin" --version)
[[ "$node_version" == v${EXPECTED_NODE_MAJOR}.* ]] || die "Node 22.x is required (found $node_version)"
pnpm_version=$("$pnpm_bin" --version)
[[ "$pnpm_version" == ${EXPECTED_PNPM_MAJOR}.* ]] || die "pnpm 11.x is required (found $pnpm_version)"
dsh_version=$("$dsh_bin" --version)
[[ "$dsh_version" == "$EXPECTED_DSH_VERSION" ]] || die "DSH $EXPECTED_DSH_VERSION is required (found $dsh_version)"

manager_url=$(
  "$node_bin" - "$manager_url" "$role" <<'NODE'
const [candidate, role] = process.argv.slice(2);
let url;
try {
  url = new URL(candidate);
} catch {
  process.exit(1);
}
if (url.protocol !== 'http:' || !url.port) process.exit(1);
if (url.username || url.password || url.search || url.hash || url.pathname !== '/') process.exit(1);
const parts = url.hostname.split('.');
const privateIpv4 = parts.length === 4
  && parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  && (Number(parts[0]) === 10
    || (Number(parts[0]) === 172 && Number(parts[1]) >= 16 && Number(parts[1]) <= 31)
    || (Number(parts[0]) === 192 && Number(parts[1]) === 168));
if (role === 'server' ? url.hostname !== '127.0.0.1' : !privateIpv4) process.exit(1);
process.stdout.write(url.origin);
NODE
) || die '--manager-url is incompatible with the selected role'

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd "$script_dir/../.." && pwd -P)
packages_dir="$repo_root/dist/packages"
checksum_manifest="$packages_dir/SHA256SUMS"
[[ -d "$packages_dir" && -f "$checksum_manifest" ]] || die "release packages are missing; run deploy/scripts/build-bundle.sh first"

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

checksum_count=0
checksum_seen='|'
while read -r expected_hash filename extra; do
  [[ -n "${expected_hash:-}" ]] || continue
  [[ -z "${extra:-}" ]] || die 'invalid checksum manifest line'
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || die "invalid checksum value for ${filename:-unknown}"
  [[ "${filename:-}" =~ ^[A-Za-z0-9._-]+\.tgz$ ]] || die "unsafe checksum filename: ${filename:-missing}"
  [[ "$checksum_seen" != *"|$filename|"* ]] || die "duplicate checksum entry: $filename"
  [[ "$filename" == *-"$expected_hash".tgz ]] || die "archive filename is not addressed by its checksum: $filename"
  checksum_seen="${checksum_seen}${filename}|"
  archive="$packages_dir/$filename"
  [[ -f "$archive" && ! -L "$archive" ]] || die "checksum archive is missing or not a regular file: $filename"
  actual_hash=$(sha256_file "$archive")
  [[ "$actual_hash" == "$expected_hash" ]] || die "checksum mismatch for $filename"
  checksum_count=$((checksum_count + 1))
done < "$checksum_manifest"
[[ $checksum_count -eq 3 ]] || die 'checksum manifest must contain exactly three archives'
set -- "$packages_dir"/*.tgz
[[ $# -eq 3 && -f "$1" && ! -L "$1" && -f "$2" && ! -L "$2" && -f "$3" && ! -L "$3" ]] || die 'release directory must contain exactly three regular tarballs'
for archive in "$@"; do
  archive_name=$(basename "$archive")
  [[ "$checksum_seen" == *"|$archive_name|"* ]] || die "release archive is not covered by SHA256SUMS: $archive_name"
done

find_release_archive() {
  local expected_name=$1
  "$node_bin" - "$packages_dir" "$expected_name" "$RELEASE_VERSION" <<'NODE'
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [directory, expectedName, expectedVersion] = process.argv.slice(2);
const matches = [];
for (const filename of fs.readdirSync(directory).filter(value => value.endsWith('.tgz')).sort()) {
  const archive = path.join(directory, filename);
  const entries = cp.execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const parts = entry.replace(/\/$/, '').split('/');
    if (entry.startsWith('/') || entry.includes('\\') || parts.includes('..') || parts[0] !== 'package') process.exit(2);
  }
  const pkg = JSON.parse(cp.execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  if (pkg.name === expectedName) {
    if (pkg.version !== expectedVersion || pkg.private === true) process.exit(3);
    matches.push(archive);
  }
}
if (matches.length !== 1) process.exit(4);
process.stdout.write(path.resolve(matches[0]));
NODE
}

source_manager_archive=$(find_release_archive "$MANAGER_PACKAGE") || die "cannot resolve the $MANAGER_PACKAGE release archive"
source_selector_archive=$(find_release_archive "$SELECTOR_PACKAGE") || die "cannot resolve the $SELECTOR_PACKAGE release archive"
source_bundle_archive=$(find_release_archive "$BUNDLE_PACKAGE") || die "cannot resolve the $BUNDLE_PACKAGE release archive"

lock_dir="$dsh_home/.gpu-workload-manager-install.lock"
lock_token=$("$node_bin" -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))")
lock_start=$("$node_bin" - "$$" <<'NODE'
const cp = require('node:child_process');
const pid = process.argv[2];
try {
  const start = cp.execFileSync('/bin/ps', ['-p', pid, '-o', 'lstart='], {
    encoding: 'utf8',
    env: { LC_ALL: 'C' },
  }).trim();
  if (!start) process.exit(1);
  process.stdout.write(start);
} catch {
  process.exit(1);
}
NODE
) || die 'cannot determine installer process identity for the installation lock'
lock_start_digest=$("$node_bin" - "$lock_start" <<'NODE'
const crypto = require('node:crypto');
process.stdout.write(crypto.createHash('sha256').update(process.argv[2]).digest('hex'));
NODE
) || die 'cannot digest installer process identity for temporary-path fencing'
lock_identity="$$-$lock_start_digest-$lock_token"

control_root="$dsh_home/.gpu-workload-manager"
"$node_bin" - installer-orphan-gc "$dsh_home" "$control_root" <<'NODE' || die 'could not safely collect stale installer-owned temporary paths'
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [_action, home, root] = process.argv.slice(2);
if (path.dirname(root) !== home || path.basename(root) !== '.gpu-workload-manager') process.exit(1);
const psOptions = { encoding: 'utf8', env: { LC_ALL: 'C' } };
const groupHasNonZombie = pgid => {
  try {
    const output = cp.execFileSync('/bin/ps', ['-axo', 'pgid=,state='], psOptions);
    return output.split(/\r?\n/).some(line => {
      const match = line.match(/^\s*([0-9]+)\s+(\S+)/);
      return match && Number(match[1]) === pgid && !/^Z/.test(match[2]);
    });
  } catch {
    return true;
  }
};
const identityIsLive = (rawPid, expectedDigest) => {
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !/^[0-9a-f]{64}$/.test(expectedDigest)) return true;
  try {
    process.kill(pid, 0);
    const state = cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'state='], psOptions).trim();
    const start = cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], psOptions).trim();
    const pgid = Number(cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], psOptions).trim());
    if (!start || crypto.createHash('sha256').update(start).digest('hex') !== expectedDigest) return false;
    if (pgid !== pid) return true;
    return !/^Z/.test(state) || groupHasNonZombie(pid);
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (retryError) {
      return retryError?.code !== 'ESRCH' || groupHasNonZombie(pid);
    }
  }
};
const fsyncDirectory = directory => {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
};
const crossedOwnerTemporaryIsRecoverable = (temporary, temporaryStat, match) => {
  if (temporaryStat.nlink !== 3 || temporaryStat.size < 1 || temporaryStat.size > 4096) return false;
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(temporary, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  const pid = Number(match[1]);
  if (owner?.version !== 2 || owner.pid !== pid || owner.pgid !== pid
    || owner.token !== match[3] || typeof owner.start !== 'string'
    || owner.start.length === 0 || owner.start.length > 128
    || crypto.createHash('sha256').update(owner.start).digest('hex') !== match[2]) return false;
  const canonical = path.join(home, '.gpu-workload-manager-install.lock');
  const tombstone = path.join(home, `.gpu-workload-manager-install.lock.stale-${owner.token}-tombstone`);
  for (const linked of [canonical, tombstone]) {
    let linkedStat;
    try {
      linkedStat = fs.lstatSync(linked);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (!linkedStat.isFile() || linkedStat.isSymbolicLink() || linkedStat.uid !== process.getuid()
      || linkedStat.nlink !== 3
      || linkedStat.dev !== temporaryStat.dev || linkedStat.ino !== temporaryStat.ino) return false;
  }
  return true;
};
let rootChanged = false;
let homeChanged = false;
try {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid()) process.exit(2);
  for (const name of fs.readdirSync(root)) {
    const helperMatch = name.match(/^\.gwm-volume-sync-v1(?:\.sha256)?-([0-9]+)-([0-9a-f]{64})-([0-9a-f]{32})\.tmp$/);
    const compilerMatch = name.match(/^\.gwm-compiler-tmp-([0-9]+)-([0-9a-f]{64})-([0-9a-f]{32})$/);
    const match = helperMatch || compilerMatch;
    if (!match || identityIsLive(match[1], match[2])) continue;
    const orphan = path.join(root, name);
    const stat = fs.lstatSync(orphan);
    if (helperMatch) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1) continue;
      fs.unlinkSync(orphan);
    } else {
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) continue;
      fs.rmSync(orphan, { recursive: true });
    }
    rootChanged = true;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const name of fs.readdirSync(home)) {
  const ownerMatch = name.match(/^\.gpu-workload-manager-install\.owner-([0-9]+)-([0-9a-f]{64})-([0-9a-f]{32})\.tmp$/);
  if (ownerMatch && !identityIsLive(ownerMatch[1], ownerMatch[2])) {
    const orphan = path.join(home, name);
    try {
      const stat = fs.lstatSync(orphan);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
        && (stat.nlink === 1 || stat.nlink === 2
          || crossedOwnerTemporaryIsRecoverable(orphan, stat, ownerMatch))) {
        fs.unlinkSync(orphan);
        homeChanged = true;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    continue;
  }
  const match = name.match(/^\.gpu-workload-manager-install\.lock\.release-([0-9]+)-([0-9a-f]{64})-([0-9a-f]{32})$/);
  if (!match || identityIsLive(match[1], match[2])) continue;
  const orphan = path.join(home, name);
  try {
    const stat = fs.lstatSync(orphan);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid()) continue;
    let owner;
    if (stat.isFile()) {
      if (stat.nlink < 1 || stat.nlink > 2) continue;
      owner = JSON.parse(fs.readFileSync(orphan, 'utf8'));
    } else if (stat.isDirectory()) {
      const entries = fs.readdirSync(orphan);
      if (entries.length === 0) {
        fs.rmdirSync(orphan);
        homeChanged = true;
        continue;
      }
      if (entries.length !== 1 || entries[0] !== 'owner.json') continue;
      const ownerFile = path.join(orphan, 'owner.json');
      const ownerStat = fs.lstatSync(ownerFile);
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.uid !== process.getuid()
        || ownerStat.nlink !== 1) continue;
      owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    } else {
      continue;
    }
    if (![1, 2].includes(owner?.version) || owner.pid !== Number(match[1]) || owner.token !== match[3]
      || typeof owner.start !== 'string'
      || crypto.createHash('sha256').update(owner.start).digest('hex') !== match[2]) continue;
    if (owner.version === 2 && owner.pgid !== owner.pid) continue;
    if (stat.isFile()) fs.unlinkSync(orphan);
    else fs.rmSync(orphan, { recursive: true });
    homeChanged = true;
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}
if (rootChanged) fsyncDirectory(root);
if (homeChanged) fsyncDirectory(home);
NODE
platform_name=$("$node_bin" -p 'process.platform')
durable_sync_helper=''
if [[ "$platform_name" == darwin ]]; then
  helper_state=$("$node_bin" - "$dsh_home" "$control_root" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [home, root] = process.argv.slice(2);
if (path.dirname(root) !== home || path.basename(root) !== '.gpu-workload-manager') process.exit(1);
try {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(2);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  fs.mkdirSync(root, { mode: 0o700 });
}
fs.chmodSync(root, 0o700);
const helper = path.join(root, 'gwm-volume-sync-v1');
const metadata = path.join(root, 'gwm-volume-sync-v1.sha256');
const readStat = target => {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const helperStat = readStat(helper);
const metadataStat = readStat(metadata);
if (!helperStat && !metadataStat) {
  process.stdout.write('missing');
  process.exit(0);
}
for (const stat of [helperStat, metadataStat]) {
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid())) process.exit(3);
}
if (!helperStat || !metadataStat
  || (helperStat.mode & 0o777) !== 0o500 || helperStat.nlink !== 1
  || (metadataStat.mode & 0o777) !== 0o400 || metadataStat.nlink !== 1) {
  process.stdout.write('rebuild');
  process.exit(0);
}
try {
  const match = fs.readFileSync(metadata, 'utf8').match(/^gwm-volume-sync-v1 ([0-9a-f]{64})\n$/);
  if (!match) {
    process.stdout.write('rebuild');
    process.exit(0);
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex');
  process.stdout.write(digest === match[1] ? 'ready' : 'rebuild');
} catch {
  process.stdout.write('rebuild');
}
NODE
) || die 'macOS durability-helper path is unsafe'
  durable_sync_helper="$control_root/gwm-volume-sync-v1"
  durable_sync_metadata="$control_root/gwm-volume-sync-v1.sha256"
  helper_barrier_stage='helper-ready'
  if [[ "$helper_state" == missing || "$helper_state" == rebuild || "$helper_state" == ready ]]; then
    durable_compile_tmpdir="$control_root/.gwm-compiler-tmp-$lock_identity"
    "$node_bin" - compiler-temp-create "$control_root" "$durable_compile_tmpdir" "$$" "$lock_start_digest" "$lock_token" <<'NODE' || die 'could not create the private macOS compiler temporary directory'
const fs = require('node:fs');
const path = require('node:path');
const [_action, root, temporary, rawPid, startDigest, token] = process.argv.slice(2);
if (path.dirname(temporary) !== root
  || path.basename(temporary) !== `.gwm-compiler-tmp-${rawPid}-${startDigest}-${token}`
  || !/^[0-9]+$/.test(rawPid) || !/^[0-9a-f]{64}$/.test(startDigest)
  || !/^[0-9a-f]{32}$/.test(token)) process.exit(1);
const rootStat = fs.lstatSync(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid()) process.exit(2);
fs.mkdirSync(temporary, { mode: 0o700 });
const descriptor = fs.openSync(root, 'r');
try {
  fs.fsyncSync(descriptor);
} catch (error) {
  if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
} finally {
  fs.closeSync(descriptor);
}
NODE
    remove_durable_compile_tmpdir() {
      "$node_bin" - compiler-temp-cleanup "$control_root" "$durable_compile_tmpdir" "$$" "$lock_start_digest" "$lock_token" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [_action, root, temporary, rawPid, startDigest, token] = process.argv.slice(2);
if (path.dirname(temporary) !== root
  || path.basename(temporary) !== `.gwm-compiler-tmp-${rawPid}-${startDigest}-${token}`) process.exit(1);
const stat = fs.lstatSync(temporary);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(2);
fs.rmSync(temporary, { recursive: true });
const descriptor = fs.openSync(root, 'r');
try {
  fs.fsyncSync(descriptor);
} catch (error) {
  if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
} finally {
  fs.closeSync(descriptor);
}
NODE
    }
    if [[ "$(/usr/bin/uname -s 2>/dev/null || uname -s)" == Darwin ]]; then
      xcrun_bin=/usr/bin/xcrun
      [[ -x "$xcrun_bin" ]] || die 'Xcode Command Line Tools are required for every durable macOS installation'
    else
      xcrun_bin=$(command -v xcrun || true)
      [[ -n "$xcrun_bin" ]] || die 'xcrun is required by the controlled non-macOS durability test shim'
    fi
    durable_cc=$(/usr/bin/env -i \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      TMPDIR="$durable_compile_tmpdir" \
      LC_ALL=C \
      "$xcrun_bin" --sdk macosx --find clang 2>/dev/null || true)
    durable_sdk=$(/usr/bin/env -i \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      TMPDIR="$durable_compile_tmpdir" \
      LC_ALL=C \
      "$xcrun_bin" --sdk macosx --show-sdk-path 2>/dev/null || true)
    [[ -n "$durable_cc" && "$durable_cc" == /* && -x "$durable_cc" ]] || die 'trusted clang from the Xcode Command Line Tools is required for every durable macOS installation'
    [[ -n "$durable_sdk" && "$durable_sdk" == /* && -d "$durable_sdk" ]] || die 'a trusted macOS SDK from the Xcode Command Line Tools is required for every durable macOS installation'
    durable_sdk=$(cd "$durable_sdk" && pwd -P) || die 'the selected macOS SDK path cannot be canonicalized'
    durable_sync_temporary="$control_root/.gwm-volume-sync-v1-$lock_identity.tmp"
    durable_metadata_temporary="$control_root/.gwm-volume-sync-v1.sha256-$lock_identity.tmp"
    if ! /usr/bin/env -i \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      TMPDIR="$durable_compile_tmpdir" \
      LC_ALL=C \
      "$durable_cc" -isysroot "$durable_sdk" -std=c11 -O2 -Wall -Wextra -Werror -x c -o "$durable_sync_temporary" - <<'C'; then
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--protocol") == 0) {
    puts("gwm-volume-sync-v1");
    return 0;
  }
  if (argc != 3) return 64;
  const char *stage = argv[1];
  const char *path = argv[2];
  if (stage[0] == '\0' || strchr(stage, '/') != NULL) return 64;
  struct stat stat_value;
  if (lstat(path, &stat_value) < 0) {
    perror("lstat");
    return 1;
  }
  if (S_ISLNK(stat_value.st_mode) || (!S_ISREG(stat_value.st_mode) && !S_ISDIR(stat_value.st_mode))) {
    fprintf(stderr, "unsafe volume-sync target for %s\n", stage);
    return 1;
  }
  int status = sync_volume_np(path, SYNC_VOLUME_FULLSYNC | SYNC_VOLUME_WAIT);
  if (status != 0) {
    int error_number = status > 0 ? status : errno;
    fprintf(stderr, "sync_volume_np(%s): %s\n", stage, strerror(error_number));
    return 1;
  }
  return 0;
}
C
      find "$durable_sync_temporary" -delete 2>/dev/null || true
      remove_durable_compile_tmpdir 2>/dev/null || true
      die 'could not compile the macOS full-volume durability helper'
    fi
    remove_durable_compile_tmpdir || die 'could not remove the private macOS compiler temporary directory'
    "$node_bin" - durability-helper-publish "$control_root" "$durable_sync_temporary" "$durable_sync_helper" "$durable_metadata_temporary" "$durable_sync_metadata" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [_action, root, temporary, target, metadataTemporary, metadataTarget] = process.argv.slice(2);
const temporaryMatch = path.basename(temporary).match(/^\.gwm-volume-sync-v1-([0-9]+)-([0-9a-f]{64})-([0-9a-f]{32})\.tmp$/);
const metadataTemporaryMatch = path.basename(metadataTemporary).match(/^\.gwm-volume-sync-v1\.sha256-([0-9]+)-([0-9a-f]{64})-([0-9a-f]{32})\.tmp$/);
if (path.dirname(temporary) !== root || path.dirname(target) !== root
  || path.dirname(metadataTemporary) !== root || path.dirname(metadataTarget) !== root
  || path.basename(target) !== 'gwm-volume-sync-v1'
  || path.basename(metadataTarget) !== 'gwm-volume-sync-v1.sha256'
  || !temporaryMatch || !metadataTemporaryMatch
  || temporaryMatch.slice(1).join(':') !== metadataTemporaryMatch.slice(1).join(':')) process.exit(1);
const temporaryStat = fs.lstatSync(temporary);
if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || temporaryStat.uid !== process.getuid()
  || temporaryStat.nlink !== 1) process.exit(2);
for (const existing of [target, metadataTarget]) {
  try {
    const stat = fs.lstatSync(existing);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(3);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
try {
  fs.chmodSync(temporary, 0o500);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(temporary)).digest('hex');
  const metadataDescriptor = fs.openSync(metadataTemporary, 'wx', 0o400);
  try {
    fs.writeFileSync(metadataDescriptor, `gwm-volume-sync-v1 ${digest}\n`);
    fs.fsyncSync(metadataDescriptor);
  } finally {
    fs.closeSync(metadataDescriptor);
  }
  fs.chmodSync(metadataTemporary, 0o400);
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, target);
  fs.renameSync(metadataTemporary, metadataTarget);
} catch (error) {
  for (const transient of [temporary, metadataTemporary]) {
    try { fs.unlinkSync(transient); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    }
  }
  throw error;
}
NODE
    helper_barrier_stage='helper-installed'
  else
    die 'macOS durability-helper integrity state is invalid'
  fi
  helper_protocol=$("$durable_sync_helper" --protocol 2>/dev/null || true)
  [[ "$helper_protocol" == gwm-volume-sync-v1 ]] || die 'macOS durability helper failed its protocol handshake'
  "$durable_sync_helper" "$helper_barrier_stage" "$control_root" || die 'macOS durability helper failed its volume-sync preflight'
fi

durable_volume_barrier() {
  [[ "$platform_name" == darwin ]] || return 0
  "$durable_sync_helper" "$1" "$2"
}

remove_quarantined_lock() {
  "$node_bin" - lock-release-cleanup "$dsh_home" "$1" "$$" "$lock_start" "$lock_start_digest" "$lock_token" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [_action, home, target, rawPid, start, startDigest, token] = process.argv.slice(2);
const pid = Number(rawPid);
if (path.dirname(target) !== home
  || path.basename(target) !== `.gpu-workload-manager-install.lock.release-${pid}-${startDigest}-${token}`
  || !Number.isSafeInteger(pid) || pid <= 1 || !/^[0-9a-f]{64}$/.test(startDigest)
  || crypto.createHash('sha256').update(start).digest('hex') !== startDigest
  || !/^[0-9a-f]{32}$/.test(token)) process.exit(1);
const stat = fs.lstatSync(target);
if (stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(2);
let owner;
if (stat.isFile()) {
  if (stat.nlink < 1 || stat.nlink > 2) process.exit(2);
  owner = JSON.parse(fs.readFileSync(target, 'utf8'));
} else if (stat.isDirectory()) {
  const ownerFile = path.join(target, 'owner.json');
  const ownerStat = fs.lstatSync(ownerFile);
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.uid !== process.getuid()
    || ownerStat.nlink !== 1) process.exit(2);
  owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
} else {
  process.exit(2);
}
if (![1, 2].includes(owner?.version) || owner.pid !== pid
  || owner.start !== start || owner.token !== token) process.exit(2);
if (owner.version === 2 && owner.pgid !== pid) process.exit(2);
if (stat.isFile()) fs.unlinkSync(target);
else fs.rmSync(target, { recursive: true });
const descriptor = fs.openSync(home, 'r');
try {
  fs.fsyncSync(descriptor);
} catch (error) {
  if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
} finally {
  fs.closeSync(descriptor);
}
NODE
}

lock_owner_state() {
  "$node_bin" - "$lock_dir" <<'NODE'
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const canonical = process.argv[2];
let canonicalStat;
try {
  canonicalStat = fs.lstatSync(canonical);
  if (canonicalStat.isSymbolicLink() || canonicalStat.uid !== process.getuid()) process.exit(12);
} catch {
  process.exit(12);
}
let owner;
let entry;
const legacyDirectory = canonicalStat.isDirectory();
if (canonicalStat.isFile()) {
  if (canonicalStat.nlink < 1 || canonicalStat.nlink > 2) process.exit(12);
  entry = 'canonical-file';
  try {
    owner = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  } catch {
    process.exit(12);
  }
  if (owner?.version !== 2 || owner.pgid !== owner.pid
    || !/^[0-9a-f]{32}$/.test(owner?.token || '')) process.exit(12);
} else if (canonicalStat.isDirectory()) {
  const entries = fs.readdirSync(canonical);
  if (entries.length === 0 || entries.length !== 1) process.exit(12);
  entry = entries[0];
  const ownerFile = path.join(canonical, entry);
  const ownerStat = fs.lstatSync(ownerFile);
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.uid !== process.getuid()) process.exit(12);
  if (entry === 'owner.json') {
    try {
      owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    } catch {
      process.exit(12);
    }
  } else {
    const match = entry.match(/^\.owner-([0-9]+)-([0-9a-f]{64})-([0-9a-f]{32})\.tmp$/);
    if (!match) process.exit(12);
    owner = { version: 1, pid: Number(match[1]), startDigest: match[2], token: match[3] };
  }
} else {
  process.exit(12);
}
if (![1, 2].includes(owner?.version)
  || !Number.isSafeInteger(owner.pid) || owner.pid <= 1
  || typeof owner.token !== 'string' || !/^[0-9a-z-]{8,128}$/.test(owner.token)) process.exit(12);
if (owner.version === 2 && owner.pgid !== owner.pid) process.exit(12);
let actual = '';
let actualPgid = '';
try {
  process.kill(owner.pid, 0);
  const state = cp.execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'state='], {
    encoding: 'utf8',
    env: { LC_ALL: 'C' },
  }).trim();
  if (/^Z/.test(state)) process.exit(10);
  actual = cp.execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { LC_ALL: 'C' },
  }).trim();
  actualPgid = cp.execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'pgid='], {
    encoding: 'utf8',
    env: { LC_ALL: 'C' },
  }).trim();
} catch (error) {
  if (error?.code === 'ESRCH') process.exit(legacyDirectory ? 12 : 10);
  process.exit(12);
}
if (entry === 'owner.json' || entry === 'canonical-file') {
  if (typeof owner.start !== 'string' || owner.start.length === 0 || owner.start.length > 128) process.exit(12);
  if (owner.version === 2 && actual === owner.start && Number(actualPgid) !== owner.pgid) process.exit(12);
  if (entry === 'owner.json' && owner.version === 1 && actual !== owner.start) process.exit(12);
  process.exit(actual && actual === owner.start ? 0 : 10);
}
const digest = crypto.createHash('sha256').update(actual).digest('hex');
process.exit(actual && digest === owner.startDigest ? 0 : 12);
NODE
}

reclaim_stale_lock() {
  local reclaim_plan
reclaim_plan=$("$node_bin" - stale-lock-final-check "$lock_dir" "$dsh_home" <<'NODE'
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [_action, canonical, home] = process.argv.slice(2);
if (path.dirname(canonical) !== home || path.basename(canonical) !== '.gpu-workload-manager-install.lock') process.exit(1);
try {
  const canonicalStat = fs.lstatSync(canonical);
  if (canonicalStat.isSymbolicLink() || canonicalStat.uid !== process.getuid()) process.exit(2);
  if (!canonicalStat.isFile()) process.exit(2);
  if (canonicalStat.nlink < 1 || canonicalStat.nlink > 2) process.exit(2);
  const owner = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  if (owner?.version !== 2 || !Number.isSafeInteger(owner.pid) || owner.pid <= 1
    || typeof owner.start !== 'string' || owner.start.length === 0
    || owner.pgid !== owner.pid
    || typeof owner.token !== 'string' || !/^[0-9a-f]{32}$/.test(owner.token)) process.exit(2);
  const staleKey = owner.token;
  const psOptions = { encoding: 'utf8', env: { LC_ALL: 'C' } };
  const groupHasNonZombie = pgid => {
    const output = cp.execFileSync('/bin/ps', ['-axo', 'pgid=,state='], psOptions);
    return output.split(/\r?\n/).some(line => {
      const match = line.match(/^\s*([0-9]+)\s+(\S+)/);
      return match && Number(match[1]) === pgid && !/^Z/.test(match[2]);
    });
  };
  const wait = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  const quiesceGroup = pgid => {
    if (pgid === process.pid || pgid === process.ppid) return false;
    for (const [signal, timeout] of [['SIGTERM', 1000], ['SIGKILL', 1000]]) {
      if (!groupHasNonZombie(pgid)) return true;
      try {
        process.kill(-pgid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') return false;
      }
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (!groupHasNonZombie(pgid)) return true;
        wait(25);
      }
    }
    return !groupHasNonZombie(pgid);
  };
  let running = false;
  let leaderReused = false;
  let leaderGone = false;
  try {
    process.kill(owner.pid, 0);
    const state = cp.execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'state='], psOptions).trim();
    const actual = cp.execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart='], psOptions).trim();
    const actualPgid = Number(cp.execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'pgid='], psOptions).trim());
    if (actual !== owner.start) leaderReused = true;
    else if (actualPgid !== owner.pgid) process.exit(2);
    else running = !/^Z/.test(state);
  } catch (error) {
    try {
      process.kill(owner.pid, 0);
      process.exit(2);
    } catch (retryError) {
      if (retryError?.code !== 'ESRCH') process.exit(2);
      leaderGone = true;
    }
  }
  if (running) process.exit(3);
  if (!leaderReused && (leaderGone || !running) && !quiesceGroup(owner.pgid)) process.exit(2);
  const tombstone = path.join(home, `.gpu-workload-manager-install.lock.stale-${staleKey}-tombstone`);
  const currentCanonicalStat = fs.lstatSync(canonical);
  if (currentCanonicalStat.dev !== canonicalStat.dev || currentCanonicalStat.ino !== canonicalStat.ino) process.exit(6);
  let fencePresent = false;
  try {
    const tombstoneStat = fs.lstatSync(tombstone);
    if (!tombstoneStat.isFile() || tombstoneStat.isSymbolicLink()
      || tombstoneStat.dev !== canonicalStat.dev || tombstoneStat.ino !== canonicalStat.ino) process.exit(6);
    fencePresent = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const plan = {
    version: 2,
    kind: 'file',
    staleKey,
    canonicalDev: String(canonicalStat.dev),
    canonicalIno: String(canonicalStat.ino),
    fencePresent,
  };
  process.stdout.write(JSON.stringify(plan));
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(6);
  throw error;
}
NODE
  ) || return $?
  local finalize_kind
  finalize_kind=$("$node_bin" - stale-lock-finalize "$lock_dir" "$dsh_home" "$reclaim_plan" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [_action, canonical, home, rawPlan] = process.argv.slice(2);
if (path.dirname(canonical) !== home || path.basename(canonical) !== '.gpu-workload-manager-install.lock') process.exit(1);
let plan;
try {
  plan = JSON.parse(rawPlan);
} catch {
  process.exit(2);
}
if (plan?.version !== 2 || plan.kind !== 'file'
  || typeof plan.staleKey !== 'string' || !/^[0-9a-f]{32}$/.test(plan.staleKey)
  || typeof plan.fencePresent !== 'boolean'
  || !['canonicalDev', 'canonicalIno'].every(key => /^[0-9]+$/.test(plan[key]))) process.exit(2);
const tombstone = path.join(home, `.gpu-workload-manager-install.lock.stale-${plan.staleKey}-tombstone`);
const fsyncDirectory = target => {
  const descriptor = fs.openSync(target, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
};
try {
  if (!plan.fencePresent) fs.linkSync(canonical, tombstone);
  const fencedStat = fs.lstatSync(tombstone);
  if (String(fencedStat.dev) !== plan.canonicalDev || String(fencedStat.ino) !== plan.canonicalIno) {
    if (!plan.fencePresent) fs.unlinkSync(tombstone);
    process.exit(6);
  }
  const currentStat = fs.lstatSync(canonical);
  if (currentStat.dev !== fencedStat.dev || currentStat.ino !== fencedStat.ino) {
    if (!plan.fencePresent) fs.unlinkSync(tombstone);
    process.exit(6);
  }
  fsyncDirectory(home);
  process.stdout.write('file');
} catch (error) {
  if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EISDIR', 'EPERM'].includes(error?.code)) process.exit(6);
  throw error;
}
NODE
) || return $?
  [[ "$finalize_kind" == file ]] || return 1
  durable_volume_barrier lock-reclaim-fenced "$dsh_home" || return $?
  "$node_bin" - stale-lock-canonical-unlink "$lock_dir" "$dsh_home" "$reclaim_plan" <<'NODE' || return $?
const fs = require('node:fs');
const path = require('node:path');
const [_action, canonical, home, rawPlan] = process.argv.slice(2);
if (path.dirname(canonical) !== home || path.basename(canonical) !== '.gpu-workload-manager-install.lock') process.exit(1);
const plan = JSON.parse(rawPlan);
if (plan?.version !== 2 || plan.kind !== 'file'
  || typeof plan.staleKey !== 'string' || !/^[0-9a-f]{32}$/.test(plan.staleKey)
  || !['canonicalDev', 'canonicalIno'].every(key => /^[0-9]+$/.test(plan[key]))) process.exit(2);
const tombstone = path.join(home, `.gpu-workload-manager-install.lock.stale-${plan.staleKey}-tombstone`);
try {
  const canonicalStat = fs.lstatSync(canonical);
  const tombstoneStat = fs.lstatSync(tombstone);
  if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()
    || !tombstoneStat.isFile() || tombstoneStat.isSymbolicLink()
    || String(canonicalStat.dev) !== plan.canonicalDev || String(canonicalStat.ino) !== plan.canonicalIno
    || canonicalStat.dev !== tombstoneStat.dev || canonicalStat.ino !== tombstoneStat.ino) process.exit(6);
  fs.unlinkSync(canonical);
  const descriptor = fs.openSync(home, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(6);
  throw error;
}
NODE
  durable_volume_barrier lock-reclaimed "$dsh_home"
}

lock_owner_temporary="$dsh_home/.gpu-workload-manager-install.owner-$lock_identity.tmp"
"$node_bin" - lock-owner-prepare "$dsh_home" "$lock_owner_temporary" "$$" "$lock_start" "$lock_start_digest" "$lock_token" <<'NODE' || die 'could not prepare the durable installation-lock owner record'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [_action, home, temporary, rawPid, start, startDigest, token] = process.argv.slice(2);
const pid = Number(rawPid);
if (path.dirname(temporary) !== home
  || path.basename(temporary) !== `.gpu-workload-manager-install.owner-${pid}-${startDigest}-${token}.tmp`
  || !Number.isSafeInteger(pid) || pid <= 1
  || typeof start !== 'string' || start.length === 0 || start.length > 128
  || !/^[0-9a-f]{64}$/.test(startDigest)
  || crypto.createHash('sha256').update(start).digest('hex') !== startDigest
  || !/^[0-9a-f]{32}$/.test(token)) process.exit(12);
const fsyncDirectory = target => {
  const descriptor = fs.openSync(target, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
};
const descriptor = fs.openSync(temporary, 'wx', 0o600);
try {
  fs.writeFileSync(descriptor, `${JSON.stringify({ version: 2, pid, start, pgid: pid, token })}\n`);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
fsyncDirectory(home);
NODE

remove_lock_owner_temporary() {
  [[ -e "$lock_owner_temporary" || -L "$lock_owner_temporary" ]] || return 0
  "$node_bin" - lock-owner-temp-cleanup "$dsh_home" "$lock_owner_temporary" "$$" "$lock_start" "$lock_start_digest" "$lock_token" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [_action, home, temporary, rawPid, start, startDigest, token] = process.argv.slice(2);
if (path.dirname(temporary) !== home
  || path.basename(temporary) !== `.gpu-workload-manager-install.owner-${rawPid}-${startDigest}-${token}.tmp`) process.exit(1);
const stat = fs.lstatSync(temporary);
const owner = JSON.parse(fs.readFileSync(temporary, 'utf8'));
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
  || (stat.nlink !== 1 && stat.nlink !== 2) || owner?.version !== 2
  || owner.pid !== Number(rawPid) || owner.start !== start || owner.pgid !== Number(rawPid)
  || owner.token !== token) process.exit(2);
fs.unlinkSync(temporary);
const descriptor = fs.openSync(home, 'r');
try {
  fs.fsyncSync(descriptor);
} catch (error) {
  if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
} finally {
  fs.closeSync(descriptor);
}
NODE
}

owner_temp_cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  remove_lock_owner_temporary 2>/dev/null || true
  exit "$status"
}
trap owner_temp_cleanup EXIT
trap 'exit 130' HUP INT TERM
durable_volume_barrier lock-owner-prepared "$dsh_home" || die 'could not durably prepare the installation-lock owner record'

try_acquire_lock() {
  "$node_bin" - lock-acquire-claim "$dsh_home" "$lock_owner_temporary" "$lock_dir" "$$" "$lock_start_digest" "$lock_token" <<'NODE' || return $?
const fs = require('node:fs');
const path = require('node:path');
const [_action, home, temporary, lock, rawPid, startDigest, token] = process.argv.slice(2);
if (path.dirname(temporary) !== home || path.dirname(lock) !== home
  || path.basename(temporary) !== `.gpu-workload-manager-install.owner-${rawPid}-${startDigest}-${token}.tmp`
  || path.basename(lock) !== '.gpu-workload-manager-install.lock') process.exit(12);
const temporaryStat = fs.lstatSync(temporary);
const owner = JSON.parse(fs.readFileSync(temporary, 'utf8'));
if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || temporaryStat.uid !== process.getuid()
  || temporaryStat.nlink !== 1 || owner?.version !== 2 || owner.pid !== Number(rawPid)
  || owner.pgid !== Number(rawPid) || owner.token !== token) process.exit(12);
try {
  fs.linkSync(temporary, lock);
} catch (error) {
  if (error.code === 'EEXIST') process.exit(10);
  process.exit(12);
}
const descriptor = fs.openSync(home, 'r');
try {
  fs.fsyncSync(descriptor);
} catch (error) {
  if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
} finally {
  fs.closeSync(descriptor);
}
NODE
  "$node_bin" - lock-acquire-finalize "$dsh_home" "$lock_owner_temporary" "$lock_dir" <<'NODE' || return 12
const fs = require('node:fs');
const path = require('node:path');
const [_action, home, temporary, lock] = process.argv.slice(2);
if (path.dirname(temporary) !== home || path.dirname(lock) !== home
  || path.basename(lock) !== '.gpu-workload-manager-install.lock') process.exit(1);
const temporaryStat = fs.lstatSync(temporary);
const lockStat = fs.lstatSync(lock);
if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || temporaryStat.uid !== process.getuid()
  || !lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.uid !== process.getuid()
  || temporaryStat.dev !== lockStat.dev || temporaryStat.ino !== lockStat.ino) process.exit(2);
fs.unlinkSync(temporary);
const descriptor = fs.openSync(home, 'r');
try {
  fs.fsyncSync(descriptor);
} catch (error) {
  if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
} finally {
  fs.closeSync(descriptor);
}
NODE
  durable_volume_barrier lock-acquired "$dsh_home"
}

lock_acquired=0
lock_attempt=0
while [[ $lock_attempt -lt 6 ]]; do
  lock_attempt=$((lock_attempt + 1))
  set +e
  try_acquire_lock
  acquire_state=$?
  set -e
  if [[ $acquire_state -eq 0 ]]; then
    lock_acquired=1
    break
  fi
  [[ $acquire_state -eq 10 ]] || die "could not atomically acquire GPU Workload Manager installation lock: $lock_dir"
  set +e
  lock_owner_state
  lock_state=$?
  set -e
  if [[ $lock_state -eq 0 ]]; then
    die "another GPU Workload Manager installation is active: $lock_dir"
  fi
  [[ $lock_state -eq 10 ]] || die "unsafe or unverifiable GPU Workload Manager installation lock: $lock_dir"
  reclaim_stale_lock 2>/dev/null || true
done
[[ $lock_acquired -eq 1 ]] || die "could not acquire GPU Workload Manager installation lock: $lock_dir"
trap - EXIT HUP INT TERM

release_install_lock() {
  local released_lock="$dsh_home/.gpu-workload-manager-install.lock.release-$lock_identity"
  if ! "$node_bin" - lock-release-fence "$dsh_home" "$lock_dir" "$released_lock" "$$" "$lock_start" "$lock_token" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [_action, home, canonical, quarantine, rawPid, start, token] = process.argv.slice(2);
if (path.dirname(canonical) !== home || path.basename(canonical) !== '.gpu-workload-manager-install.lock'
  || path.dirname(quarantine) !== home
  || path.basename(quarantine) !== `.gpu-workload-manager-install.lock.release-${rawPid}-${require('node:crypto').createHash('sha256').update(start).digest('hex')}-${token}`) process.exit(1);
try {
  const stat = fs.lstatSync(canonical);
  const owner = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || stat.nlink !== 1 || owner?.version !== 2 || owner.pid !== Number(rawPid)
    || owner.pgid !== Number(rawPid) || owner.start !== start || owner.token !== token) process.exit(1);
  fs.linkSync(canonical, quarantine);
  const quarantineStat = fs.lstatSync(quarantine);
  if (quarantineStat.dev !== stat.dev || quarantineStat.ino !== stat.ino) process.exit(1);
  fs.unlinkSync(canonical);
  const descriptor = fs.openSync(home, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
} catch {
  process.exit(1);
}
NODE
  then
    return 1
  fi
  remove_quarantined_lock "$released_lock" || return 1
  durable_volume_barrier lock-released "$dsh_home"
}

early_unlock() {
  local status=$?
  trap - EXIT HUP INT TERM
  release_install_lock 2>/dev/null || true
  exit "$status"
}
trap early_unlock EXIT
trap 'exit 130' HUP INT TERM

control_root="$dsh_home/.gpu-workload-manager"
packages_store="$control_root/packages"
"$node_bin" - "$dsh_home" "$control_root" "$packages_store" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [home, root, store] = process.argv.slice(2);
if (path.dirname(root) !== home || path.dirname(store) !== root) process.exit(1);
const fsyncDirectory = directory => {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
};
for (const directory of [root, store]) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(2);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
}
for (const name of fs.readdirSync(root)) {
  if (!/^transaction\.retired-[0-9a-f]{32}$/.test(name)) continue;
  const retired = path.join(root, name);
  const stat = fs.lstatSync(retired);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(3);
  fs.rmSync(retired, { recursive: true });
}
for (const name of fs.readdirSync(store)) {
  if (!/^\..+\.tgz\.incoming-[0-9a-f]{32}$/.test(name)) continue;
  const incoming = path.join(store, name);
  const stat = fs.lstatSync(incoming);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(4);
  fs.unlinkSync(incoming);
}
fsyncDirectory(store);
fsyncDirectory(root);
fsyncDirectory(home);
NODE
durable_volume_barrier store-ready "$dsh_home" || die 'could not persist the package-store directory state'

persist_release_archive() {
  local source=$1
  local filename expected_hash persisted
  filename=$(basename "$source")
  expected_hash=${filename%.tgz}
  expected_hash=${expected_hash##*-}
  persisted=$("$node_bin" - "$source" "$packages_store" "$filename" "$expected_hash" "$lock_token" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [source, store, filename, expectedHash, token] = process.argv.slice(2);
if (!/^[A-Za-z0-9._-]+\.tgz$/.test(filename) || !/^[0-9a-f]{64}$/.test(expectedHash)) process.exit(1);
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const target = path.join(store, filename);
let targetStat;
try {
  targetStat = fs.lstatSync(target);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (targetStat) {
  if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.uid !== process.getuid() || hashFile(target) !== expectedHash) process.exit(2);
  process.stdout.write(target);
  process.exit(0);
}
const temporary = path.join(store, `.${filename}.incoming-${token}`);
try {
  try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(temporary, 0o600);
  if (hashFile(temporary) !== expectedHash) process.exitCode = 3;
  else {
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
    const directory = fs.openSync(store, 'r');
    try {
      fs.fsyncSync(directory);
    } catch (error) {
      if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
    } finally {
      fs.closeSync(directory);
    }
  }
} finally {
  try { fs.unlinkSync(temporary); } catch {}
}
if (process.exitCode) process.exit(process.exitCode);
process.stdout.write(target);
NODE
  ) || return $?
  durable_volume_barrier archive-persisted "$dsh_home" || return 1
  printf '%s' "$persisted"
}

manager_archive=$(persist_release_archive "$source_manager_archive") || die "could not persist the verified $MANAGER_PACKAGE archive"
selector_archive=$(persist_release_archive "$source_selector_archive") || die "could not persist the verified $SELECTOR_PACKAGE archive"
bundle_archive=$(persist_release_archive "$source_bundle_archive") || die "could not persist the verified $BUNDLE_PACKAGE archive"

web_manifest="$dsh_home/profiles/web/package.json"
headless_manifest="$dsh_home/profiles/headless/package.json"
env_file="$dsh_home/.env"

render_managed_env() {
  local action=$1
  "$node_bin" - "$action" "$env_file" "$role" "$manager_url" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [action, envFile, role, managerUrl] = process.argv.slice(2);
const beginMarker = '# >>> GPU Workload Manager (managed by install-dsh-bundle.sh) >>>';
const endMarker = '# <<< GPU Workload Manager (managed by install-dsh-bundle.sh) <<<' ;
const exists = fs.existsSync(envFile);
const original = exists ? fs.readFileSync(envFile) : Buffer.alloc(0);
const text = original.toString('latin1');
const lines = [];
for (let start = 0; start < text.length;) {
  const newlineAt = text.indexOf('\n', start);
  const end = newlineAt === -1 ? text.length : newlineAt + 1;
  let body = text.slice(start, newlineAt === -1 ? text.length : newlineAt);
  if (body.endsWith('\r')) body = body.slice(0, -1);
  lines.push({ start, end, body });
  start = end;
}

const begins = [];
const ends = [];
for (let index = 0; index < lines.length; index += 1) {
  if (lines[index].body === beginMarker) begins.push(index);
  if (lines[index].body === endMarker) ends.push(index);
}
const malformed = begins.length !== ends.length
  || begins.length > 1
  || (begins.length === 1 && begins[0] >= ends[0]);
if (malformed) {
  process.stderr.write('install-dsh-bundle: duplicate or malformed managed block in .env\n');
  process.exit(2);
}

const beginIndex = begins[0];
const endIndex = ends[0];
const assignment = /^\s*(?:export\s+)?(GPU_WORKLOAD_ROLE|GPU_WORKLOAD_MANAGER_URL)\s*=/;
for (let index = 0; index < lines.length; index += 1) {
  const inside = beginIndex !== undefined && index >= beginIndex && index <= endIndex;
  if (inside) continue;
  const match = lines[index].body.match(assignment);
  if (match) {
    process.stderr.write(`install-dsh-bundle: unmanaged ${match[1]} definition in .env\n`);
    process.exit(3);
  }
}

if (beginIndex !== undefined) {
  const counts = { GPU_WORKLOAD_ROLE: 0, GPU_WORKLOAD_MANAGER_URL: 0 };
  for (let index = beginIndex + 1; index < endIndex; index += 1) {
    const match = lines[index].body.match(assignment);
    if (!match || !Object.hasOwn(counts, match[1])) {
      process.stderr.write('install-dsh-bundle: managed block contains unrelated or malformed content\n');
      process.exit(4);
    }
    counts[match[1]] += 1;
  }
  if (counts.GPU_WORKLOAD_ROLE !== 1 || counts.GPU_WORKLOAD_MANAGER_URL !== 1) {
    process.stderr.write('install-dsh-bundle: duplicate or malformed managed block in .env\n');
    process.exit(5);
  }
}

const newline = text.includes('\r\n') ? '\r\n' : '\n';
const block = Buffer.from([
  beginMarker,
  `GPU_WORKLOAD_ROLE=${role}`,
  `GPU_WORKLOAD_MANAGER_URL=${managerUrl}`,
  endMarker,
  '',
].join(newline));
let desired;
if (beginIndex === undefined) {
  const separator = original.length === 0 || text.endsWith('\n') ? Buffer.alloc(0) : Buffer.from(newline);
  desired = Buffer.concat([original, separator, block]);
} else {
  desired = Buffer.concat([
    original.subarray(0, lines[beginIndex].start),
    block,
    original.subarray(lines[endIndex].end),
  ]);
}
if (action === 'check' || desired.equals(original)) process.exit(0);
if (action !== 'write') process.exit(6);

const previous = exists ? fs.statSync(envFile) : undefined;
const temporary = path.join(path.dirname(envFile), `.env.gwm-${process.pid}-${Date.now()}`);
try {
  fs.writeFileSync(temporary, desired, { flag: 'wx', mode: previous ? previous.mode & 0o777 : 0o600 });
  if (previous) {
    fs.chmodSync(temporary, previous.mode & 0o777);
    try {
      fs.chownSync(temporary, previous.uid, previous.gid);
    } catch {
      const current = fs.statSync(temporary);
      if (current.uid !== previous.uid || current.gid !== previous.gid) throw new Error('cannot preserve .env owner');
    }
  } else {
    fs.chmodSync(temporary, 0o600);
  }
  fs.renameSync(temporary, envFile);
} catch (error) {
  try { fs.unlinkSync(temporary); } catch {}
  process.stderr.write('install-dsh-bundle: failed to update managed .env block without changing unrelated content\n');
  process.exit(7);
}
NODE
}

dependency_state() {
  local manifest=$1
  local package_name=$2
  local archive=$3
  "$node_bin" - "$manifest" "$package_name" "$archive" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const [manifestFile, packageName, archive] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) process.exit(2);
const spec = manifest.dependencies[packageName];
if (spec === undefined) {
  process.stdout.write('missing');
  process.exit(0);
}
if (typeof spec !== 'string' || !spec.startsWith('file:')) {
  process.stdout.write(String(spec));
  process.exit(3);
}
const requested = spec.slice('file:'.length);
const resolved = path.resolve(path.dirname(manifestFile), requested);
let current;
let expected;
try {
  current = fs.realpathSync(resolved);
  expected = fs.realpathSync(archive);
} catch {
  expected = fs.realpathSync(archive);
  if (path.basename(requested) === path.basename(expected)) {
    process.stdout.write('relocate');
    process.exit(0);
  }
  process.stdout.write(spec);
  process.exit(3);
}
if (resolved !== expected || current !== expected) {
  if (current === expected) {
    process.stdout.write('relocate');
    process.exit(0);
  }
  const stat = fs.lstatSync(current);
  const digest = stat.isFile() && !stat.isSymbolicLink()
    ? crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex')
    : '';
  const addressedHash = path.basename(expected).match(/-([0-9a-f]{64})\.tgz$/)?.[1];
  if (path.basename(current) === path.basename(expected) && digest === addressedHash) {
    process.stdout.write('relocate');
    process.exit(0);
  }
  process.stdout.write(spec);
  process.exit(3);
}
process.stdout.write('match');
NODE
}

profile_has_valid_bundle_list() {
  "$node_bin" - "$1" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(manifest.dsh?.profile?.bundles) || manifest.dsh.profile.bundles.some(value => typeof value !== 'string')) process.exit(1);
NODE
}

classify_dependency() {
  local manifest=$1
  local package_name=$2
  local archive=$3
  local profile=$4
  local state status
  set +e
  state=$(dependency_state "$manifest" "$package_name" "$archive")
  status=$?
  set -e
  if [[ $status -eq 0 && ( "$state" == missing || "$state" == match || "$state" == relocate ) ]]; then
    printf '%s' "$state"
    return 0
  fi
  die "conflicting dependency in $profile for $package_name: ${state:-invalid manifest}"
}

transaction_dir="$control_root/transaction"
backup_root="$transaction_dir"
transaction_active=0
transaction_durable=0
commit_barrier_failed=0
web_added_names=''
headless_added_names=''
web_lock_existed=0
headless_lock_existed=0
env_existed=0
rollback_restore_failed=0

remove_generated_tree() {
  local target=${1:-}
  [[ -n "$target" && -d "$target" ]] || return 0
  case "$target" in
    "$transaction_dir"|"$control_root"/transaction.retired-*) ;;
    *)
    printf 'install-dsh-bundle: refusing to clean unexpected path: %s\n' "$target" >&2
    return 1
      ;;
  esac
  "$node_bin" - "$control_root" "$target" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, target] = process.argv.slice(2);
const name = path.basename(target);
if (path.dirname(target) !== root || (name !== 'transaction' && !/^transaction\.retired-[0-9a-f]{32}$/.test(name))) process.exit(1);
const stat = fs.lstatSync(target);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(2);
fs.rmSync(target, { recursive: true });
NODE
}

retire_transaction() {
  [[ -e "$transaction_dir" || -L "$transaction_dir" ]] || return 0
  local retired="$control_root/transaction.retired-$lock_token"
  [[ ! -e "$retired" && ! -L "$retired" ]] || return 1
  "$node_bin" - transaction-retire "$control_root" "$transaction_dir" "$retired" <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const [_action, root, transaction, retired] = process.argv.slice(2);
if (path.dirname(transaction) !== root || path.basename(transaction) !== 'transaction'
  || path.dirname(retired) !== root || !/^transaction\.retired-[0-9a-f]{32}$/.test(path.basename(retired))) process.exit(1);
const stat = fs.lstatSync(transaction);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(2);
fs.renameSync(transaction, retired);
const descriptor = fs.openSync(root, 'r');
try {
  fs.fsyncSync(descriptor);
} catch (error) {
  if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
} finally {
  fs.closeSync(descriptor);
}
NODE
  durable_volume_barrier transaction-retired "$dsh_home" || return 1
  remove_generated_tree "$retired"
}

restore_or_remove_lockfile() {
  local profile=$1
  local existed=$2
  local target="$dsh_home/profiles/$profile/pnpm-lock.yaml"
  local saved="$backup_root/$profile.pnpm-lock.yaml"
  if [[ $existed -eq 1 ]]; then
    cp -p "$saved" "$target"
  elif [[ -f "$target" ]]; then
    find "$target" -delete
  fi
}

snapshot_node_modules_state() {
  "$node_bin" - "$dsh_home/profiles" "$backup_root/node-modules" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [profilesDirectory, snapshotDirectory] = process.argv.slice(2);
const roots = [
  { name: 'shared', relative: 'node_modules' },
  { name: 'web', relative: 'web/node_modules' },
  { name: 'headless', relative: 'headless/node_modules' },
];
const metadataRelatives = [
  '.modules.yaml',
  '.package-map.json',
  '.pnpm-workspace-state-v1.json',
  '.pnpm/lock.yaml',
];
fs.mkdirSync(snapshotDirectory, { recursive: true });
const state = { version: 1, roots, entries: [], metadata: [] };
const kindOf = stat => stat.isDirectory() ? 'directory'
  : stat.isFile() ? 'file'
  : stat.isSymbolicLink() ? 'symlink'
  : 'other';
const visit = (absolute, relative) => {
  const stat = fs.lstatSync(absolute);
  const entry = {
    path: relative,
    kind: kindOf(stat),
    uid: stat.uid,
    gid: stat.gid,
  };
  if (stat.isSymbolicLink()) entry.target = fs.readlinkSync(absolute);
  state.entries.push(entry);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, name), path.posix.join(relative, name));
    }
  }
};
for (const root of roots) {
  const source = path.join(profilesDirectory, ...root.relative.split('/'));
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const existed = stat !== undefined;
  if (existed && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`unsafe node_modules root: ${source}`);
  }
  if (!existed) continue;
  visit(source, root.relative);
  for (const metadataRelative of metadataRelatives) {
    const relative = path.posix.join(root.relative, metadataRelative);
    const metadataFile = path.join(profilesDirectory, ...relative.split('/'));
    let metadataStat;
    try {
      metadataStat = fs.lstatSync(metadataFile);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
      throw new Error(`unsafe pnpm metadata path: ${metadataFile}`);
    }
    const backup = `metadata-${state.metadata.length}`;
    fs.copyFileSync(metadataFile, path.join(snapshotDirectory, backup), fs.constants.COPYFILE_FICLONE);
    state.metadata.push({
      path: relative,
      backup,
      mode: metadataStat.mode & 0o7777,
      uid: metadataStat.uid,
      gid: metadataStat.gid,
      atimeMs: metadataStat.atimeMs,
      mtimeMs: metadataStat.mtimeMs,
    });
  }
}
fs.writeFileSync(path.join(snapshotDirectory, 'state.json'), `${JSON.stringify(state)}\n`, { flag: 'wx' });
NODE
}

restore_node_modules_state() {
  "$node_bin" - "$dsh_home/profiles" "$backup_root/node-modules" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [profilesDirectory, snapshotDirectory] = process.argv.slice(2);
const expected = [
  { name: 'shared', relative: 'node_modules' },
  { name: 'web', relative: 'web/node_modules' },
  { name: 'headless', relative: 'headless/node_modules' },
];
const state = JSON.parse(fs.readFileSync(path.join(snapshotDirectory, 'state.json'), 'utf8'));
if (state?.version !== 1 || !Array.isArray(state.roots) || !Array.isArray(state.entries) || !Array.isArray(state.metadata)) {
  throw new Error('invalid node_modules transaction state');
}
for (let index = 0; index < expected.length; index += 1) {
  const actual = state.roots[index];
  const wanted = expected[index];
  if (actual?.name !== wanted.name || actual?.relative !== wanted.relative) {
    throw new Error('invalid node_modules root entry');
  }
}
const kindOf = stat => stat.isDirectory() ? 'directory'
  : stat.isFile() ? 'file'
  : stat.isSymbolicLink() ? 'symlink'
  : 'other';
const baseline = new Map();
for (const entry of state.entries) {
  if (typeof entry?.path !== 'string' || !['directory', 'file', 'symlink', 'other'].includes(entry.kind)) {
    throw new Error('invalid node_modules path entry');
  }
  if (baseline.has(entry.path)) throw new Error('duplicate node_modules path entry');
  baseline.set(entry.path, entry);
}
const current = [];
const visit = (absolute, relative) => {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  current.push({ path: relative, kind: kindOf(stat) });
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, name), path.posix.join(relative, name));
    }
  }
};
for (const root of expected) {
  visit(path.join(profilesDirectory, ...root.relative.split('/')), root.relative);
}
current.sort((left, right) => right.path.split('/').length - left.path.split('/').length || right.path.localeCompare(left.path));
for (const entry of current) {
  if (baseline.has(entry.path)) continue;
  const target = path.join(profilesDirectory, ...entry.path.split('/'));
  if (entry.kind === 'directory') fs.rmdirSync(target);
  else fs.unlinkSync(target);
}
const metadataPaths = new Set(state.metadata.map(item => item.path));
const lstatIfPresent = target => {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};
for (const entry of baseline.values()) {
  const target = path.join(profilesDirectory, ...entry.path.split('/'));
  let stat = lstatIfPresent(target);
  if (entry.kind === 'symlink') {
    if (!stat?.isSymbolicLink() || fs.readlinkSync(target) !== entry.target) {
      if (stat?.isDirectory()) fs.rmdirSync(target);
      else if (stat) fs.unlinkSync(target);
      fs.symlinkSync(entry.target, target);
      stat = fs.lstatSync(target);
    }
    if (typeof fs.lchownSync === 'function' && (stat.uid !== entry.uid || stat.gid !== entry.gid)) {
      fs.lchownSync(target, entry.uid, entry.gid);
    }
  } else if (!metadataPaths.has(entry.path) && (!stat || kindOf(stat) !== entry.kind)) {
    throw new Error(`preexisting node_modules path changed during rollback: ${entry.path}`);
  }
}
const removeNonFile = target => {
  const stat = lstatIfPresent(target);
  if (!stat || stat.isFile()) return;
  if (stat.isDirectory()) fs.rmdirSync(target);
  else fs.unlinkSync(target);
};
for (const metadata of state.metadata) {
  if (typeof metadata?.path !== 'string' || typeof metadata?.backup !== 'string') {
    throw new Error('invalid pnpm metadata backup entry');
  }
  const source = path.join(snapshotDirectory, metadata.backup);
  if (!fs.lstatSync(source).isFile()) throw new Error(`missing pnpm metadata backup: ${metadata.path}`);
  const target = path.join(profilesDirectory, ...metadata.path.split('/'));
  removeNonFile(target);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.gwm-restore-${process.pid}`);
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(temporary, metadata.mode);
    const temporaryStat = fs.lstatSync(temporary);
    if (temporaryStat.uid !== metadata.uid || temporaryStat.gid !== metadata.gid) {
      fs.chownSync(temporary, metadata.uid, metadata.gid);
    }
    fs.utimesSync(temporary, metadata.atimeMs / 1000, metadata.mtimeMs / 1000);
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}
const finalPaths = [];
for (const root of expected) {
  const collect = (absolute, relative) => {
    const stat = lstatIfPresent(absolute);
    if (!stat) return;
    finalPaths.push(relative);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        collect(path.join(absolute, name), path.posix.join(relative, name));
      }
    }
  };
  collect(path.join(profilesDirectory, ...root.relative.split('/')), root.relative);
}
if (finalPaths.length !== baseline.size || finalPaths.some(value => !baseline.has(value))) {
  throw new Error('node_modules rollback left paths outside the transaction baseline');
}
NODE
}

fsync_target_state() {
  "$node_bin" - target-state-durability-barrier "$dsh_home" <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const [_action, home] = process.argv.slice(2);
const profiles = path.join(home, 'profiles');

const fsyncDirectory = directory => {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
};
const lstatIfPresent = target => {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};
const fsyncFileIfPresent = file => {
  const stat = lstatIfPresent(file);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe durable target file: ${file}`);
  const descriptor = fs.openSync(file, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
};
const fsyncTreeIfPresent = root => {
  const visit = target => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      const descriptor = fs.openSync(target, 'r');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      return;
    }
    if (!stat.isDirectory()) throw new Error(`unsafe durable target entry: ${target}`);
    for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
    fsyncDirectory(target);
  };
  const stat = lstatIfPresent(root);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe durable target root: ${root}`);
  visit(root);
};

for (const file of [
  path.join(profiles, 'web/package.json'),
  path.join(profiles, 'web/pnpm-lock.yaml'),
  path.join(profiles, 'headless/package.json'),
  path.join(profiles, 'headless/pnpm-lock.yaml'),
  path.join(home, '.env'),
]) fsyncFileIfPresent(file);
for (const root of [
  path.join(profiles, 'node_modules'),
  path.join(profiles, 'web/node_modules'),
  path.join(profiles, 'headless/node_modules'),
]) fsyncTreeIfPresent(root);
for (const directory of [path.join(profiles, 'web'), path.join(profiles, 'headless'), profiles, home]) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe durable target directory: ${directory}`);
  fsyncDirectory(directory);
}
NODE
  durable_volume_barrier target-state "$dsh_home"
}

transaction_journal_phase() {
  "$node_bin" - "$transaction_dir/journal.json" "$dsh_home" <<'NODE'
const fs = require('node:fs');
const [file, home] = process.argv.slice(2);
try {
  const stat = fs.lstatSync(file);
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || journal?.version !== 1 || journal.dshHome !== home
    || !['prepared', 'committed'].includes(journal.phase)) process.exit(1);
  process.stdout.write(journal.phase);
} catch {
  process.exit(1);
}
NODE
}

mark_transaction_committed() {
  if ! "$node_bin" - transaction-journal-commit "$transaction_dir/journal.json" "$dsh_home" "$lock_token" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [_action, file, home, token] = process.argv.slice(2);
const transaction = path.dirname(file);
const temporary = path.join(transaction, `.journal-committed-${token}.tmp`);
const fsyncDirectory = directory => {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
};
try {
  const stat = fs.lstatSync(file);
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || journal?.version !== 1 || journal.phase !== 'prepared' || journal.dshHome !== home) process.exit(1);
  journal.phase = 'committed';
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(journal)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fsyncDirectory(transaction);
} catch {
  try { fs.unlinkSync(temporary); } catch {}
  process.exit(1);
}
NODE
  then
    local visible_phase=''
    visible_phase=$(transaction_journal_phase 2>/dev/null || true)
    if [[ "$visible_phase" == committed ]]; then
      commit_barrier_failed=1
    fi
    return 1
  fi
  if ! durable_volume_barrier transaction-committed "$dsh_home"; then
    commit_barrier_failed=1
    return 1
  fi
}

recover_interrupted_transaction() {
  [[ -e "$transaction_dir" || -L "$transaction_dir" ]] || return 0
  "$node_bin" - "$control_root" "$transaction_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, transaction] = process.argv.slice(2);
if (path.dirname(transaction) !== root || path.basename(transaction) !== 'transaction') process.exit(1);
const stat = fs.lstatSync(transaction);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(2);
NODE
  local journal="$transaction_dir/journal.json"
  if [[ ! -e "$journal" && ! -L "$journal" ]]; then
    printf 'install-dsh-bundle: discarding an incomplete pre-mutation transaction snapshot\n' >&2
    retire_transaction
    return 0
  fi

  local journal_values
  journal_values=$("$node_bin" - "$journal" "$dsh_home" "$transaction_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [journalFile, home, transaction] = process.argv.slice(2);
const requireRegular = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(2);
};
requireRegular(journalFile);
let journal;
try {
  journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
} catch {
  process.exit(3);
}
if (journal?.version !== 1 || !['prepared', 'committed'].includes(journal.phase) || journal.dshHome !== home) process.exit(4);
for (const key of ['webLockExisted', 'headlessLockExisted', 'envExisted']) {
  if (typeof journal[key] !== 'boolean') process.exit(5);
}
for (const file of ['web.package.json', 'headless.package.json', 'node-modules/state.json']) {
  requireRegular(path.join(transaction, ...file.split('/')));
}
if (journal.webLockExisted) requireRegular(path.join(transaction, 'web.pnpm-lock.yaml'));
if (journal.headlessLockExisted) requireRegular(path.join(transaction, 'headless.pnpm-lock.yaml'));
if (journal.envExisted) requireRegular(path.join(transaction, 'dsh.env'));
process.stdout.write([
  journal.phase,
  journal.webLockExisted ? '1' : '0',
  journal.headlessLockExisted ? '1' : '0',
  journal.envExisted ? '1' : '0',
].join('|'));
NODE
  ) || die 'interrupted DSH installation transaction is invalid; refusing automatic recovery'
  local journal_phase
  IFS='|' read -r journal_phase web_lock_existed headless_lock_existed env_existed <<EOF
$journal_values
EOF

  if [[ "$journal_phase" == committed ]]; then
    printf 'install-dsh-bundle: finishing a committed DSH installation transaction\n' >&2
    fsync_target_state || die 'could not persist committed DSH target state; committed journal retained'
    retire_transaction || die 'could not retire the committed transaction journal'
    web_lock_existed=0
    headless_lock_existed=0
    env_existed=0
    return 0
  fi

  for recovery_target in \
    "$web_manifest" \
    "$headless_manifest" \
    "$dsh_home/profiles/web/pnpm-lock.yaml" \
    "$dsh_home/profiles/headless/pnpm-lock.yaml" \
    "$env_file"; do
    [[ ! -L "$recovery_target" ]] || die "interrupted transaction target must not be a symlink: $recovery_target"
  done
  printf 'install-dsh-bundle: recovering interrupted DSH installation transaction\n' >&2
  cp -p "$backup_root/web.package.json" "$web_manifest" || die 'could not recover the web profile manifest'
  cp -p "$backup_root/headless.package.json" "$headless_manifest" || die 'could not recover the headless profile manifest'
  restore_or_remove_lockfile web "$web_lock_existed" || die 'could not recover the web profile lockfile'
  restore_or_remove_lockfile headless "$headless_lock_existed" || die 'could not recover the headless profile lockfile'
  if [[ $env_existed -eq 1 ]]; then
    cp -p "$backup_root/dsh.env" "$env_file" || die 'could not recover the layered environment'
  elif [[ -e "$env_file" ]]; then
    find "$env_file" -delete || die 'could not remove the transaction-created layered environment'
  fi
  restore_node_modules_state || die 'could not recover node_modules from the interrupted transaction'
  fsync_target_state || die 'could not persist recovered DSH target state; recovery journal retained'
  retire_transaction || die 'could not retire the recovered transaction journal'
  web_lock_existed=0
  headless_lock_existed=0
  env_existed=0
}

rollback_transaction() {
  local rollback_status=0
  set +e
  if [[ -n "$headless_added_names" ]]; then
    # shellcheck disable=SC2086
    if ! DSH_HOME="$dsh_home" "$dsh_bin" plugin --profile headless remove --config.ignore-scripts=true $headless_added_names >/dev/null 2>&1; then
      printf 'install-dsh-bundle: headless dependency cleanup failed during rollback\n' >&2
      rollback_status=1
    fi
  fi
  if [[ -n "$web_added_names" ]]; then
    # shellcheck disable=SC2086
    if ! DSH_HOME="$dsh_home" "$dsh_bin" plugin --profile web remove --config.ignore-scripts=true $web_added_names >/dev/null 2>&1; then
      printf 'install-dsh-bundle: web dependency cleanup failed during rollback\n' >&2
      rollback_status=1
    fi
  fi
  if ! cp -p "$backup_root/web.package.json" "$web_manifest"; then
    rollback_status=1
    rollback_restore_failed=1
  fi
  if ! cp -p "$backup_root/headless.package.json" "$headless_manifest"; then
    rollback_status=1
    rollback_restore_failed=1
  fi
  if ! restore_or_remove_lockfile web "$web_lock_existed"; then
    rollback_status=1
    rollback_restore_failed=1
  fi
  if ! restore_or_remove_lockfile headless "$headless_lock_existed"; then
    rollback_status=1
    rollback_restore_failed=1
  fi
  if [[ $env_existed -eq 1 ]]; then
    if ! cp -p "$backup_root/dsh.env" "$env_file"; then
      rollback_status=1
      rollback_restore_failed=1
    fi
  elif [[ -f "$env_file" ]]; then
    if ! find "$env_file" -delete; then
      rollback_status=1
      rollback_restore_failed=1
    fi
  fi
  if ! restore_node_modules_state; then
    printf 'install-dsh-bundle: node_modules transaction cleanup failed during rollback\n' >&2
    rollback_status=1
    rollback_restore_failed=1
  fi
  set -e
  return "$rollback_status"
}

cleanup() {
  local status=$?
  local journal_phase=''
  trap - EXIT HUP INT TERM
  if [[ -f "$transaction_dir/journal.json" && ! -L "$transaction_dir/journal.json" ]]; then
    journal_phase=$(transaction_journal_phase 2>/dev/null || true)
  fi
  if [[ "$journal_phase" == committed && $commit_barrier_failed -eq 0 ]]; then
    transaction_durable=1
  fi
  if [[ $status -ne 0 && $transaction_active -eq 1 && "$journal_phase" != committed
    && ( -e "$transaction_dir" || -L "$transaction_dir" ) ]]; then
    printf 'install-dsh-bundle: installation failed; rolling back profile changes\n' >&2
    transaction_durable=0
    if ! rollback_transaction; then
      printf 'install-dsh-bundle: rollback encountered an error\n' >&2
    fi
    if [[ $rollback_restore_failed -eq 0 ]]; then
      if fsync_target_state; then
        transaction_durable=1
      else
        rollback_restore_failed=1
        printf 'install-dsh-bundle: target-state durability barrier failed during rollback\n' >&2
      fi
    fi
  fi
  if [[ -e "$transaction_dir" || -L "$transaction_dir" ]]; then
    if [[ $commit_barrier_failed -eq 0
      && ( ( ! -e "$transaction_dir/journal.json" && ! -L "$transaction_dir/journal.json" ) || $transaction_durable -eq 1 ) ]]; then
      if ! retire_transaction; then
        printf 'install-dsh-bundle: recovery backup retained at %s\n' "$backup_root" >&2
      fi
    else
      printf 'install-dsh-bundle: recovery backup retained at %s\n' "$backup_root" >&2
    fi
  fi
  release_install_lock 2>/dev/null || true
  exit "$status"
}

recover_interrupted_transaction

[[ -f "$web_manifest" && ! -L "$web_manifest" ]] || die 'web profile package.json is missing or not a regular file'
[[ -f "$headless_manifest" && ! -L "$headless_manifest" ]] || die 'headless profile package.json is missing or not a regular file'
[[ ! -L "$env_file" ]] || die "$env_file must not be a symlink"
[[ ! -e "$env_file" || -f "$env_file" ]] || die "$env_file must be a regular file"
for profile in web headless; do
  profile_lockfile="$dsh_home/profiles/$profile/pnpm-lock.yaml"
  [[ ! -L "$profile_lockfile" ]] || die "$profile pnpm-lock.yaml must not be a symlink"
  [[ ! -e "$profile_lockfile" || -f "$profile_lockfile" ]] || die "$profile pnpm-lock.yaml must be a regular file"
done
for modules_root in \
  "$dsh_home/profiles/node_modules" \
  "$dsh_home/profiles/web/node_modules" \
  "$dsh_home/profiles/headless/node_modules"; do
  [[ ! -L "$modules_root" ]] || die "$modules_root must not be a symlink"
  [[ ! -e "$modules_root" || -d "$modules_root" ]] || die "$modules_root must be a directory"
done

render_managed_env check || die 'layered .env validation failed'
profile_has_valid_bundle_list "$web_manifest" || die 'web profile has an invalid dsh.profile.bundles list'
profile_has_valid_bundle_list "$headless_manifest" || die 'headless profile has an invalid dsh.profile.bundles list'

web_manager_state=$(classify_dependency "$web_manifest" "$MANAGER_PACKAGE" "$manager_archive" web)
web_selector_state=$(classify_dependency "$web_manifest" "$SELECTOR_PACKAGE" "$selector_archive" web)
web_bundle_state=$(classify_dependency "$web_manifest" "$BUNDLE_PACKAGE" "$bundle_archive" web)
headless_manager_state=$(classify_dependency "$headless_manifest" "$MANAGER_PACKAGE" "$manager_archive" headless)
headless_selector_state=$(classify_dependency "$headless_manifest" "$SELECTOR_PACKAGE" "$selector_archive" headless)
headless_bundle_state=$(classify_dependency "$headless_manifest" "$BUNDLE_PACKAGE" "$bundle_archive" headless)

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

mkdir "$backup_root"
cp -p "$web_manifest" "$backup_root/web.package.json"
cp -p "$headless_manifest" "$backup_root/headless.package.json"
if [[ -f "$dsh_home/profiles/web/pnpm-lock.yaml" ]]; then
  web_lock_existed=1
  cp -p "$dsh_home/profiles/web/pnpm-lock.yaml" "$backup_root/web.pnpm-lock.yaml"
fi
if [[ -f "$dsh_home/profiles/headless/pnpm-lock.yaml" ]]; then
  headless_lock_existed=1
  cp -p "$dsh_home/profiles/headless/pnpm-lock.yaml" "$backup_root/headless.pnpm-lock.yaml"
fi
if [[ -f "$env_file" ]]; then
  env_existed=1
  cp -p "$env_file" "$backup_root/dsh.env"
fi
snapshot_node_modules_state
"$node_bin" - "$backup_root/journal.json" "$dsh_home" "$web_lock_existed" "$headless_lock_existed" "$env_existed" "$lock_token" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, dshHome, webLock, headlessLock, env, token] = process.argv.slice(2);
const temporary = path.join(path.dirname(file), `.journal-${token}.tmp`);
const transaction = path.dirname(file);
const fsyncDirectory = directory => {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
};
const fsyncTree = directory => {
  for (const name of fs.readdirSync(directory)) {
    const entry = path.join(directory, name);
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('unsafe transaction backup entry');
    if (stat.isDirectory()) fsyncTree(entry);
    else {
      const descriptor = fs.openSync(entry, 'r');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
  }
  fsyncDirectory(directory);
};
const journal = {
  version: 1,
  phase: 'prepared',
  dshHome,
  webLockExisted: webLock === '1',
  headlessLockExisted: headlessLock === '1',
  envExisted: env === '1',
};
try {
  fsyncTree(transaction);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(journal)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fsyncDirectory(transaction);
  fsyncDirectory(path.dirname(transaction));
} catch {
  try { fs.unlinkSync(temporary); } catch {}
  process.exit(1);
}
NODE
durable_volume_barrier transaction-prepared "$dsh_home" || die 'could not persist the prepared DSH installation journal'
transaction_active=1

install_profile_dependencies() {
  local profile=$1
  local manager_state=$2
  local selector_state=$3
  local bundle_state=$4
  local added_names=''
  if [[ "$manager_state" == missing ]]; then
    added_names="$MANAGER_PACKAGE"
  fi
  if [[ "$selector_state" == missing ]]; then
    added_names="${added_names:+$added_names }$SELECTOR_PACKAGE"
  fi
  if [[ "$bundle_state" == missing ]]; then
    added_names="${added_names:+$added_names }$BUNDLE_PACKAGE"
  fi
  if [[ "$profile" == web ]]; then
    web_added_names=$added_names
  else
    headless_added_names=$added_names
  fi
  DSH_HOME="$dsh_home" "$dsh_bin" plugin --profile "$profile" add --save-exact --ignore-scripts \
    "$manager_archive" "$selector_archive" "$bundle_archive"
}

install_profile_dependencies web "$web_manager_state" "$web_selector_state" "$web_bundle_state"
install_profile_dependencies headless "$headless_manager_state" "$headless_selector_state" "$headless_bundle_state"

for profile in web headless; do
  if [[ "$profile" == web ]]; then
    manifest=$web_manifest
  else
    manifest=$headless_manifest
  fi
  [[ $(dependency_state "$manifest" "$MANAGER_PACKAGE" "$manager_archive") == match ]] || die "$profile did not install $MANAGER_PACKAGE from the release archive"
  [[ $(dependency_state "$manifest" "$SELECTOR_PACKAGE" "$selector_archive") == match ]] || die "$profile did not install $SELECTOR_PACKAGE from the release archive"
  [[ $(dependency_state "$manifest" "$BUNDLE_PACKAGE" "$bundle_archive") == match ]] || die "$profile did not install $BUNDLE_PACKAGE from the release archive"
done

append_bundle_once() {
  local manifest=$1
  "$node_bin" - "$manifest" "$BUNDLE_PACKAGE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [manifestFile, bundleName] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const bundles = manifest.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) process.exit(1);
const count = bundles.filter(value => value === bundleName).length;
if (count > 1) process.exit(2);
if (count === 1) process.exit(0);
bundles.push(bundleName);
const mode = fs.statSync(manifestFile).mode & 0o777;
const temporary = path.join(path.dirname(manifestFile), `.package.json.gwm-${process.pid}`);
fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode });
fs.chmodSync(temporary, mode);
fs.renameSync(temporary, manifestFile);
NODE
}

append_bundle_once "$web_manifest" || die 'could not add the bundle to the web profile'
append_bundle_once "$headless_manifest" || die 'could not add the bundle to the headless profile'

render_managed_env write || die 'layered .env update failed'

validate_dump() {
  local profile=$1
  local dump_file=$2
  "$node_bin" - "$profile" "$dump_file" <<'NODE'
const fs = require('node:fs');
const [profile, file] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const rows = [];
let current;
for (const line of lines) {
  const match = line.match(/^- id: (.+)$/);
  if (match) {
    current = { id: match[1].replace(/^['"]|['"]$/g, ''), disabled: false };
    rows.push(current);
  } else if (current && /^  disabled: true$/.test(line)) {
    current.disabled = true;
  }
}
const count = id => rows.filter(row => row.id === id).length;
if (count('gpu-workload-manager') !== 1) process.exit(1);
if (rows.find(row => row.id === 'gpu-workload-manager')?.disabled) process.exit(5);
if (profile === 'web') {
  if (count('ui-model-selection') !== 1 || count('gpu-workload-model-selection') !== 1) process.exit(2);
  if (!rows.find(row => row.id === 'ui-model-selection')?.disabled) process.exit(3);
  if (rows.find(row => row.id === 'gpu-workload-model-selection')?.disabled) process.exit(4);
}
NODE
}

mkdir -p "$backup_root/dumps" "$backup_root/validation-cwd"
for profile in web headless; do
  dump_file="$backup_root/dumps/$profile.yml"
  if ! (
    unset GPU_WORKLOAD_ROLE GPU_WORKLOAD_MANAGER_URL
    export DSH_HOME="$dsh_home"
    cd "$backup_root/validation-cwd"
    "$dsh_bin" --profile "$profile" --dump-config
  ) > "$dump_file"; then
    die "$profile profile composition validation failed"
  fi
  validate_dump "$profile" "$dump_file" || die "$profile profile composition validation failed"
done

fsync_target_state || die 'could not persist installed DSH target state; recovery journal retained'
transaction_durable=1
mark_transaction_committed || die 'could not commit the durable DSH installation journal'
retire_transaction || die 'DSH target state is committed but the transaction journal could not be retired'
transaction_active=0
printf 'Installed GPU Workload Manager DSH bundle for role %s.\n' "$role"
printf 'Machine-local runtime settings: %s\n' "$env_file"
printf 'No DSH process or service was restarted.\n'
