#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
umask 077

SNAPSHOT=
FIXTURE_ROOT=
APPLY=0
LOCK_HELD=0
SYSTEMCTL_COMMAND_TIMEOUT_SECONDS=30
NEW_SERVICE_CLEANUP_TIMEOUT_SECONDS=120
POST_RESTORE_CLEANUP_TIMEOUT_SECONDS=60
RECOVERY_IDENTITY_TIMEOUT_SECONDS=60
ARTIFACT_VALIDATION_TIMEOUT_SECONDS=7200
ARTIFACT_VALIDATION_COMMAND_TIMEOUT_SECONDS=7200
OLD_RESTORE_TIMEOUT_SECONDS=1800

usage() {
  printf '%s\n' 'usage: rollback-ubuntu.sh --snapshot ABS_FILE [--fixture-root ABS_DIR] [--apply]'
}

fail() {
  printf 'rollback-ubuntu: FAIL %s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --snapshot)
      (($# >= 2)) || fail missing_snapshot
      SNAPSHOT=$2
      shift 2
      ;;
    --fixture-root)
      (($# >= 2)) || fail missing_fixture_root
      FIXTURE_ROOT=$2
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --lock-held)
      LOCK_HELD=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail unknown_argument ;;
  esac
done

[[ "$SNAPSHOT" = /* ]] || fail snapshot_must_be_absolute

# Automatic rollback begins after the legacy GPU owner may already be stopped.
# Bound and retry bootstrap reads before trusting any migration filesystem state.
BOOTSTRAP_TIMEOUT=/usr/bin/timeout
[[ -x "$BOOTSTRAP_TIMEOUT" ]] || fail missing_required_command
if [[ -n "$FIXTURE_ROOT" ]]; then
  BOOTSTRAP_TIMEOUT_SECONDS=4
  BOOTSTRAP_COMMAND_TIMEOUT_SECONDS=1
else
  BOOTSTRAP_TIMEOUT_SECONDS=60
  BOOTSTRAP_COMMAND_TIMEOUT_SECONDS=10
fi
BOOTSTRAP_DEADLINE=$((SECONDS + BOOTSTRAP_TIMEOUT_SECONDS))

run_bootstrap_command_before_deadline() {
  local deadline=$1 remaining command_timeout
  shift
  remaining=$((deadline - SECONDS))
  ((remaining > 0)) || return 124
  command_timeout=$remaining
  ((command_timeout <= BOOTSTRAP_COMMAND_TIMEOUT_SECONDS)) || command_timeout=$BOOTSTRAP_COMMAND_TIMEOUT_SECONDS
  "$BOOTSTRAP_TIMEOUT" --signal=KILL "$command_timeout"s "$@"
}

read_bootstrap_command_before_deadline() {
  local deadline=$1 output status
  shift
  while ((SECONDS < deadline)); do
    if output=$(run_bootstrap_command_before_deadline "$deadline" "$@"); then
      printf '%s\n' "$output"
      return 0
    else
      status=$?
    fi
    [[ "$status" = 124 || "$status" = 137 ]] || return "$status"
  done
  return 124
}

FIXTURE=0
ROOT_PREFIX=
if [[ -n "$FIXTURE_ROOT" ]]; then
  FIXTURE=1
  [[ "$FIXTURE_ROOT" = /* && "$FIXTURE_ROOT" != / && -d "$FIXTURE_ROOT" && ! -L "$FIXTURE_ROOT" ]] || fail invalid_fixture_root
  FIXTURE_CANONICAL=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" readlink -f -- "$FIXTURE_ROOT") || \
    fail fixture_root_must_be_canonical
  [[ "$FIXTURE_CANONICAL" = "$FIXTURE_ROOT" ]] || fail fixture_root_must_be_canonical
  ROOT_PREFIX=$FIXTURE_ROOT
  FIXTURE_SENTINEL="$ROOT_PREFIX/.qwen38-workload-manager-fixture-v1"
  [[ -f "$FIXTURE_SENTINEL" && ! -L "$FIXTURE_SENTINEL" ]] || fail invalid_fixture_sentinel
  FIXTURE_UID=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" id -u) || fail invalid_fixture_sentinel
  FIXTURE_SENTINEL_META=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" stat -c '%a:%u:%h:%s' -- "$FIXTURE_SENTINEL") || \
    fail invalid_fixture_sentinel
  [[ "$FIXTURE_SENTINEL_META" = "600:$FIXTURE_UID:1:35" ]] || fail invalid_fixture_sentinel
  SENTINEL_LINE=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" cat -- "$FIXTURE_SENTINEL") || \
    fail invalid_fixture_sentinel
  [[ "$SENTINEL_LINE" = qwen38-workload-manager-fixture-v1 ]] || fail invalid_fixture_sentinel
  TARGET_USER=$(id -un)
  TARGET_UID=$(id -u)
  ADMIN_UID=$TARGET_UID
  SYSTEMCTL=$(command -v systemctl) || fail missing_systemctl
  SS=$(command -v ss) || fail missing_ss
  CURL=$(command -v curl) || fail missing_curl
  FLOCK=$(command -v flock) || fail missing_flock
  TIMEOUT=$(command -v timeout) || fail missing_timeout
  SYNC=$(command -v sync) || fail missing_sync
  SYSTEMCTL_COMMAND_TIMEOUT_SECONDS=1
  RECOVERY_IDENTITY_TIMEOUT_SECONDS=1
  ARTIFACT_VALIDATION_TIMEOUT_SECONDS=5
  ARTIFACT_VALIDATION_COMMAND_TIMEOUT_SECONDS=3
  NEW_SERVICE_CLEANUP_TIMEOUT_SECONDS=4
  POST_RESTORE_CLEANUP_TIMEOUT_SECONDS=4
  OLD_RESTORE_TIMEOUT_SECONDS=4
else
  ((EUID == 0)) || fail production_rollback_requires_root
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
  TARGET_USER=agentops
  TARGET_UID=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" id -u "$TARGET_USER" 2>/dev/null) || fail missing_agentops_user
  [[ "$TARGET_UID" = 1001 ]] || fail unexpected_agentops_uid
  ADMIN_UID=0
  SYSTEMCTL=/usr/bin/systemctl
  SS=/usr/bin/ss
  CURL=/usr/bin/curl
  FLOCK=/usr/bin/flock
  TIMEOUT=/usr/bin/timeout
  SYNC=/usr/bin/sync
  for COMMAND in "$SYSTEMCTL" "$SS" "$CURL" "$FLOCK" "$TIMEOUT" "$SYNC"; do
    [[ -x "$COMMAND" ]] || fail missing_required_command
  done
fi

target_path() {
  printf '%s%s\n' "$ROOT_PREFIX" "$1"
}

old_systemctl() {
  "$SYSTEMCTL" --user --machine="${TARGET_USER}@.host" "$@"
}

run_command_before_deadline() {
  local deadline=$1 remaining command_timeout
  shift
  remaining=$((deadline - SECONDS))
  ((remaining > 0)) || return 124
  command_timeout=$remaining
  ((command_timeout <= SYSTEMCTL_COMMAND_TIMEOUT_SECONDS)) || command_timeout=$SYSTEMCTL_COMMAND_TIMEOUT_SECONDS
  "$TIMEOUT" --signal=KILL "$command_timeout"s "$@"
}

run_artifact_command_before_deadline() {
  local deadline=$1 remaining command_timeout
  shift
  remaining=$((deadline - SECONDS))
  ((remaining > 0)) || return 124
  command_timeout=$remaining
  ((command_timeout <= ARTIFACT_VALIDATION_COMMAND_TIMEOUT_SECONDS)) || \
    command_timeout=$ARTIFACT_VALIDATION_COMMAND_TIMEOUT_SECONDS
  "$TIMEOUT" --signal=KILL "$command_timeout"s "$@"
}

sync_path_before_deadline() {
  local deadline=$1 path=$2
  run_artifact_command_before_deadline "$deadline" "$SYNC" -f -- "$path"
}

run_systemctl_before_deadline() {
  local deadline=$1
  shift
  run_command_before_deadline "$deadline" "$SYSTEMCTL" "$@"
}

run_old_systemctl_before_deadline() {
  local deadline=$1
  shift
  run_command_before_deadline "$deadline" "$SYSTEMCTL" \
    --user --machine="${TARGET_USER}@.host" "$@"
}

unit_file_state_is_before_deadline() {
  local deadline=$1 scope=$2 expected=$3 output
  if [[ "$scope" = old ]]; then
    output=$(run_old_systemctl_before_deadline "$deadline" show qwen38.service \
      --property=UnitFileState --value 2>/dev/null) || return 1
  else
    output=$(run_systemctl_before_deadline "$deadline" show qwen38-workload-manager.service \
      --property=UnitFileState --value 2>/dev/null) || return 1
  fi
  [[ "$output" = "$expected" ]]
}

cgroup_procs_empty() {
  local deadline=$1 path=$2 cgroup_pid output
  local -a cgroup_pids=()
  [[ ! -e "$path" ]] && return 0
  [[ -r "$path" && ! -L "$path" ]] || return 1
  output=$(run_command_before_deadline "$deadline" cat -- "$path") || return 1
  mapfile -t cgroup_pids <<< "$output"
  for cgroup_pid in "${cgroup_pids[@]}"; do
    [[ -z "$cgroup_pid" ]] && continue
    [[ "$cgroup_pid" =~ ^[1-9][0-9]*$ ]] || return 1
    return 1
  done
  return 0
}

single_ipv4_listener_for_pid() {
  local output=$1 expected_pid=$2 line state recvq sendq local_address peer_address process extra residual count=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    ((count += 1))
    read -r state recvq sendq local_address peer_address process extra <<< "$line"
    [[ "$state" = LISTEN && "$local_address" = '0.0.0.0:8080' && -z "$extra" \
      && "$process" = *"pid=$expected_pid,"* ]] || return 1
    residual=${process/"pid=$expected_pid,"/}
    [[ "$residual" != *'pid='* ]] || return 1
  done <<< "$output"
  ((count == 1))
}

new_runtime_absent() {
  local deadline=$1 cgroup_file gateway_listener child_listener
  local cgroup_ok gateway_ok child_ok listener_ok attempt=0 max_attempts=0
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]] || return 1
  if ((FIXTURE)); then
    cgroup_file="$GWM_FAKE_STATE/new-cgroup-pids"
    max_attempts=8
  else
    cgroup_file=/sys/fs/cgroup/system.slice/qwen38-workload-manager.service/cgroup.procs
  fi
  while ((SECONDS < deadline)); do
    ((attempt += 1))
    ((max_attempts == 0 || attempt <= max_attempts)) || break
    cgroup_ok=0
    gateway_ok=0
    child_ok=0
    listener_ok=0
    gateway_listener=
    child_listener=
    cgroup_procs_empty "$deadline" "$cgroup_file" && cgroup_ok=1
    if gateway_listener=$(run_command_before_deadline "$deadline" "$SS" -H -ltnp 'sport = :8080' 2>/dev/null); then
      gateway_ok=1
    fi
    if child_listener=$(run_command_before_deadline "$deadline" "$SS" -H -ltnp 'sport = :18080' 2>/dev/null); then
      child_ok=1
    fi
    if ((gateway_ok == 1)); then
      if [[ -z "$gateway_listener" ]] \
        || single_ipv4_listener_for_pid "$gateway_listener" "${RECORD[old_main_pid]}"; then
        listener_ok=1
      fi
    fi
    if ((cgroup_ok == 1 && gateway_ok == 1 && child_ok == 1 && listener_ok == 1)) \
      && [[ -z "$child_listener" ]]; then
      return 0
    fi
    ((FIXTURE)) || sleep 1
  done
  return 1
}

prove_new_service_quiesced() {
  local deadline=$1 output key value load active sub pid control_group job
  local load_seen active_seen sub_seen pid_seen control_group_seen job_seen attempt=0 max_attempts=0
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]] || return 1
  ((FIXTURE == 0)) || max_attempts=8
  while ((SECONDS < deadline)); do
    ((attempt += 1))
    ((max_attempts == 0 || attempt <= max_attempts)) || break
    load= active= sub= pid= control_group= job=
    load_seen=0 active_seen=0 sub_seen=0 pid_seen=0 control_group_seen=0 job_seen=0
    output=$(run_systemctl_before_deadline "$deadline" show qwen38-workload-manager.service \
      --property=LoadState --property=ActiveState --property=SubState \
      --property=MainPID --property=ControlGroup --property=Job 2>/dev/null) || output=
    while IFS='=' read -r key value; do
      case "$key" in
        LoadState) ((load_seen += 1)); load=$value ;;
        ActiveState) ((active_seen += 1)); active=$value ;;
        SubState) ((sub_seen += 1)); sub=$value ;;
        MainPID) ((pid_seen += 1)); pid=$value ;;
        ControlGroup) ((control_group_seen += 1)); control_group=$value ;;
        Job) ((job_seen += 1)); job=$value ;;
        Result|NRestarts|'') ;;
        *) load_seen=2 ;;
      esac
    done <<< "$output"
    if ((load_seen == 1 && active_seen == 1 && sub_seen == 1 && pid_seen == 1 && control_group_seen == 1 && job_seen == 1)) \
      && [[ ( "$load" = loaded || "$load" = not-found ) \
        && ( "$active" = inactive || "$active" = failed ) && ( "$sub" = dead || "$sub" = failed ) \
        && "$pid" = 0 && -z "$job" \
        && ( -z "$control_group" || "$control_group" = /system.slice/qwen38-workload-manager.service ) ]]; then
      new_runtime_absent "$deadline" && return 0
    fi
    ((FIXTURE)) || sleep 1
  done
  return 1
}

validate_migration_directory() {
  local deadline=$1 current=$2 metadata type mode owner stop=/
  ((FIXTURE == 0)) || stop=$FIXTURE_ROOT
  while :; do
    metadata=$(read_bootstrap_command_before_deadline "$deadline" stat -c '%F:%a:%u' -- "$current") || \
      fail unsafe_migration_directory
    IFS=: read -r type mode owner <<< "$metadata"
    [[ "$type" = directory ]] || fail unsafe_migration_directory
    if [[ "$current" = "$MIGRATIONS" ]]; then
      [[ "$mode" = 700 ]] || fail unsafe_migration_directory
    elif ((FIXTURE)); then
      (( (8#$mode & 002) == 0 && (8#$mode & 07000) == 0 )) || fail unsafe_migration_directory
    else
      (( (8#$mode & 022) == 0 && (8#$mode & 07000) == 0 )) || fail unsafe_migration_directory
    fi
    [[ "$owner" = "$ADMIN_UID" ]] || fail unsafe_migration_directory
    [[ "$current" = "$stop" || "$current" = / ]] && break
    current=$(dirname -- "$current")
  done
}

verify_old_identity() {
  local deadline=$1 label=$2 path=$3 tuple expected digest_output digest
  [[ -f "$path" && ! -L "$path" ]] || fail "${label}_identity_changed"
  tuple=$(run_command_before_deadline "$deadline" stat -c '%d:%i:%u:%g:%a:%Y:%Z:%s' -- "$path") || \
    fail "${label}_identity_changed"
  expected="${RECORD[${label}_dev]}:${RECORD[${label}_inode]}:${RECORD[${label}_uid]}:${RECORD[${label}_gid]}:${RECORD[${label}_mode]}:${RECORD[${label}_mtime]}:${RECORD[${label}_ctime]}:${RECORD[${label}_size]}"
  [[ "$tuple" = "$expected" ]] || fail "${label}_identity_changed"
  digest_output=$(run_command_before_deadline "$deadline" sha256sum -- "$path") || fail "${label}_identity_changed"
  digest=${digest_output%% *}
  [[ "$digest" = "${RECORD[${label}_sha256]}" ]] || fail "${label}_identity_changed"
}

artifact_sha256() {
  local deadline=$1 path=$2 output digest
  output=$(run_artifact_command_before_deadline "$deadline" sha256sum -- "$path") || return 1
  digest=${output%% *}
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$digest"
}

verify_new_file() {
  local deadline=$1 path=$2 expected=$3 metadata digest
  if [[ -e "$path" || -L "$path" ]]; then
    metadata=$(run_artifact_command_before_deadline "$deadline" stat -c '%h:%u:%a' -- "$path") || \
      fail new_artifact_identity_changed
    [[ -f "$path" && ! -L "$path" && "$metadata" = "1:$ADMIN_UID:"* ]] || fail new_artifact_identity_changed
    digest=$(artifact_sha256 "$deadline" "$path") || fail new_artifact_identity_changed
    [[ "$digest" = "$expected" ]] || fail new_artifact_identity_changed
  fi
}

validate_cleanup_manifest() {
  local deadline=$1 metadata digest
  metadata=$(run_artifact_command_before_deadline "$deadline" stat -c '%F:%a:%u:%h' -- "$CLEANUP_MANIFEST") || \
    fail new_artifact_identity_changed
  [[ "$metadata" = "regular file:600:$ADMIN_UID:1" || "$metadata" = "regular empty file:600:$ADMIN_UID:1" ]] || \
    fail new_artifact_identity_changed
  digest=$(artifact_sha256 "$deadline" "$CLEANUP_MANIFEST") || fail new_artifact_identity_changed
  [[ "$digest" = "${RECORD[release_id]}" ]] || fail new_artifact_identity_changed
}

verify_release_tree() {
  local deadline=$1 allow_missing=$2 manifest_path=$3
  local line digest relative mode owner directory previous= metadata actual_digest
  local tree_listing entry_type candidate manifest_contents directory_listing
  declare -g -a RELEASE_FILES=()
  declare -g -a RELEASE_DIRECTORIES=()
  declare -A listed=() directories=() emitted=()
  [[ -d "$RELEASE_TARGET" && ! -L "$RELEASE_TARGET" ]] || fail new_artifact_identity_changed
  metadata=$(run_artifact_command_before_deadline "$deadline" stat -c '%a:%u' -- "$RELEASE_TARGET") || \
    fail new_artifact_identity_changed
  IFS=: read -r mode owner <<< "$metadata"
  [[ "$owner" = "$ADMIN_UID" ]] || fail new_artifact_identity_changed
  (( (8#$mode & 022) == 0 && (8#$mode & 07000) == 0 )) || fail new_artifact_identity_changed
  if [[ "$manifest_path" = "$CLEANUP_MANIFEST" ]]; then
    validate_cleanup_manifest "$deadline"
  else
    [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || fail new_artifact_identity_changed
    actual_digest=$(artifact_sha256 "$deadline" "$manifest_path") || fail new_artifact_identity_changed
    [[ "$actual_digest" = "${RECORD[release_id]}" ]] || fail new_artifact_identity_changed
  fi
  manifest_contents=$(run_artifact_command_before_deadline "$deadline" cat -- "$manifest_path") || \
    fail new_artifact_identity_changed
  ((${#manifest_contents} <= 1048576)) || fail new_artifact_identity_changed
  while IFS= read -r line || [[ -n "$line" ]]; do
    ((SECONDS < deadline)) || fail new_artifact_identity_changed
    [[ "$line" =~ ^([0-9a-f]{64})[[:space:]][[:space:]]([A-Za-z0-9][A-Za-z0-9._/-]*)$ ]] || fail new_artifact_identity_changed
    digest=${BASH_REMATCH[1]}
    relative=${BASH_REMATCH[2]}
    [[ "$relative" != release.manifest && "$relative" != */../* && "$relative" != ../* && "$relative" != */.. && "$relative" != *//* ]] || fail new_artifact_identity_changed
    case "$relative" in
      node-v22/*|dist/*|canary/*|config/*|systemd/*|verify/*) ;;
      *) fail new_artifact_identity_changed ;;
    esac
    [[ -z ${listed["$relative"]+x} && (-z "$previous" || "$previous" < "$relative") ]] || fail new_artifact_identity_changed
    listed["$relative"]=1
    RELEASE_FILES+=("$relative")
    previous=$relative
    if [[ "$relative" = */* ]]; then directory=${relative%/*}; else directory=.; fi
    while [[ "$directory" != . ]]; do
      ((SECONDS < deadline)) || fail new_artifact_identity_changed
      directories["$directory"]=1
      if [[ "$directory" = */* ]]; then directory=${directory%/*}; else directory=.; fi
    done
    if [[ -e "$RELEASE_TARGET/$relative" || -L "$RELEASE_TARGET/$relative" ]]; then
      metadata=$(run_artifact_command_before_deadline "$deadline" stat -c '%h:%u:%a' -- "$RELEASE_TARGET/$relative") || \
        fail new_artifact_identity_changed
      IFS=: read -r _ owner mode <<< "$metadata"
      [[ -f "$RELEASE_TARGET/$relative" && ! -L "$RELEASE_TARGET/$relative" && "$metadata" = "1:$ADMIN_UID:"* ]] || \
        fail new_artifact_identity_changed
      (( (8#$mode & 022) == 0 && (8#$mode & 07000) == 0 )) || fail new_artifact_identity_changed
      actual_digest=$(artifact_sha256 "$deadline" "$RELEASE_TARGET/$relative") || fail new_artifact_identity_changed
      [[ "$actual_digest" = "$digest" ]] || fail new_artifact_identity_changed
    else
      ((allow_missing == 1)) || fail new_artifact_identity_changed
    fi
  done <<< "$manifest_contents"
  for REQUIRED in node-v22/bin/node dist/canary.js dist/managerd.js dist/package.json canary/fake-canary canary/real-canary config/manager.production.json config/models.production.json systemd/qwen38-workload-manager.service verify/preflight-ubuntu.sh verify/verify-live.sh; do
    [[ -n ${listed["$REQUIRED"]+x} ]] || fail new_artifact_identity_changed
  done
  tree_listing=$(run_artifact_command_before_deadline "$deadline" find -P "$RELEASE_TARGET" -mindepth 1 -printf '%y %P\n') || \
    fail new_artifact_identity_changed
  while IFS=' ' read -r entry_type relative || [[ -n "$entry_type$relative" ]]; do
    ((SECONDS < deadline)) || fail new_artifact_identity_changed
    [[ -n "$entry_type$relative" ]] || continue
    [[ "$entry_type" = f || "$entry_type" = d ]] || fail new_artifact_identity_changed
    metadata=$(run_artifact_command_before_deadline "$deadline" stat -c '%u:%a' -- "$RELEASE_TARGET/$relative") || \
      fail new_artifact_identity_changed
    IFS=: read -r owner mode <<< "$metadata"
    [[ "$owner" = "$ADMIN_UID" ]] || fail new_artifact_identity_changed
    (( (8#$mode & 022) == 0 && (8#$mode & 07000) == 0 )) || fail new_artifact_identity_changed
    if [[ "$entry_type" = f ]]; then
      [[ "$relative" = release.manifest || -n ${listed["$relative"]+x} ]] || fail new_artifact_identity_changed
      if [[ "$relative" = release.manifest ]]; then
        actual_digest=$(artifact_sha256 "$deadline" "$RELEASE_TARGET/release.manifest") || fail new_artifact_identity_changed
        [[ "$actual_digest" = "${RECORD[release_id]}" ]] || fail new_artifact_identity_changed
      fi
    else
      [[ -n ${directories["$relative"]+x} ]] || fail new_artifact_identity_changed
    fi
  done <<< "$tree_listing"
  directory_listing=$(run_artifact_command_before_deadline "$deadline" \
    find -P "$RELEASE_TARGET" -mindepth 1 -depth -type d -printf '%P\n') || \
    fail new_artifact_identity_changed
  while IFS= read -r candidate || [[ -n "$candidate" ]]; do
    ((SECONDS < deadline)) || fail new_artifact_identity_changed
    [[ -n "$candidate" && -n ${directories["$candidate"]+x} \
      && -z ${emitted["$candidate"]+x} ]] || fail new_artifact_identity_changed
    RELEASE_DIRECTORIES+=("$candidate")
    emitted["$candidate"]=1
  done <<< "$directory_listing"
  if ((allow_missing == 0)); then
    ((${#emitted[@]} == ${#directories[@]})) || fail new_artifact_identity_changed
  fi
}

verify_transaction_artifacts() {
  local deadline=$1 current_target wants_target
  verify_old_identity "$deadline" old_unit "$OLD_UNIT"
  verify_old_identity "$deadline" old_config "$OLD_CONFIG"
  if [[ ${RECORD[cleanup_stage]} = complete ]]; then
    for path in "$NEW_UNIT" "$NEW_MANAGER" "$NEW_MODELS" "$CURRENT_LINK" "$NEW_WANTS_LINK" "$RELEASE_TARGET"; do
      [[ ! -e "$path" && ! -L "$path" ]] || fail new_artifact_identity_changed
    done
  else
    verify_new_file "$deadline" "$NEW_UNIT" "${RECORD[new_unit_sha256]}"
    verify_new_file "$deadline" "$NEW_MANAGER" "${RECORD[new_manager_sha256]}"
    verify_new_file "$deadline" "$NEW_MODELS" "${RECORD[new_models_sha256]}"
    if [[ -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]]; then
      current_target=$(run_artifact_command_before_deadline "$deadline" readlink -- "$CURRENT_LINK") || fail new_artifact_identity_changed
      [[ -L "$CURRENT_LINK" && "$current_target" = "$RELEASE_TARGET" ]] || fail new_artifact_identity_changed
    fi
    if [[ -e "$NEW_WANTS_LINK" || -L "$NEW_WANTS_LINK" ]]; then
      wants_target=$(run_artifact_command_before_deadline "$deadline" readlink -f -- "$NEW_WANTS_LINK") || fail new_artifact_identity_changed
      [[ -L "$NEW_WANTS_LINK" && "$wants_target" = "$NEW_UNIT" ]] || fail new_artifact_identity_changed
    fi
    if [[ -e "$RELEASE_TARGET" || -L "$RELEASE_TARGET" ]]; then
      if [[ ${RECORD[cleanup_stage]} = started ]]; then
        verify_release_tree "$deadline" 1 "$CLEANUP_MANIFEST"
      else
        verify_release_tree "$deadline" 0 "$RELEASE_TARGET/release.manifest"
      fi
    fi
  fi
  if [[ -e "$CLEANUP_MANIFEST" || -L "$CLEANUP_MANIFEST" ]]; then validate_cleanup_manifest "$deadline"; fi
}

prepare_cleanup_manifest() {
  local deadline=$1 temp metadata
  [[ -d "$RELEASE_TARGET" ]] || return 0
  verify_release_tree "$deadline" 0 "$RELEASE_TARGET/release.manifest"
  if [[ -e "$CLEANUP_MANIFEST" || -L "$CLEANUP_MANIFEST" ]]; then
    validate_cleanup_manifest "$deadline"
    return 0
  fi
  temp="$CLEANUP_MANIFEST.tmp"
  if [[ -e "$temp" || -L "$temp" ]]; then
    metadata=$(run_artifact_command_before_deadline "$deadline" stat -c '%F:%u' -- "$temp") || fail new_artifact_identity_changed
    [[ ( "$metadata" = "regular file:$ADMIN_UID" || "$metadata" = "regular empty file:$ADMIN_UID" ) && ! -L "$temp" ]] || \
      fail new_artifact_identity_changed
    run_artifact_command_before_deadline "$deadline" unlink -- "$temp" || fail new_artifact_cleanup_failed
  fi
  run_artifact_command_before_deadline "$deadline" cp -- "$RELEASE_TARGET/release.manifest" "$temp" || fail new_artifact_cleanup_failed
  run_artifact_command_before_deadline "$deadline" chmod 0600 -- "$temp" || fail new_artifact_cleanup_failed
  CLEANUP_MANIFEST_TEMP_DIGEST=$(artifact_sha256 "$deadline" "$temp") || fail new_artifact_cleanup_failed
  [[ "$CLEANUP_MANIFEST_TEMP_DIGEST" = "${RECORD[release_id]}" ]] || fail new_artifact_identity_changed
  sync_path_before_deadline "$deadline" "$temp" || fail new_artifact_cleanup_failed
  run_artifact_command_before_deadline "$deadline" mv -T -- "$temp" "$CLEANUP_MANIFEST" || fail new_artifact_cleanup_failed
  sync_path_before_deadline "$deadline" "$MIGRATIONS" || fail new_artifact_cleanup_failed
  validate_cleanup_manifest "$deadline"
}

update_cleanup_stage() {
  local deadline=$1 expected=$2 next=$3 metadata snapshot_data field payload matches=0 temp updated_data= updated_line
  metadata=$(run_artifact_command_before_deadline "$deadline" stat -c '%F:%a:%u:%h' -- "$SNAPSHOT") || fail invalid_snapshot_during_stage_update
  [[ "$metadata" = "regular file:600:$ADMIN_UID:1" ]] || fail invalid_snapshot_during_stage_update
  snapshot_data=$(run_artifact_command_before_deadline "$deadline" cat -- "$SNAPSHOT") || fail invalid_snapshot_during_stage_update
  temp="$SNAPSHOT.cleanup-stage.tmp"
  if [[ -e "$temp" || -L "$temp" ]]; then
    metadata=$(run_artifact_command_before_deadline "$deadline" stat -c '%F:%u' -- "$temp") || \
      fail invalid_snapshot_during_stage_update
    [[ ( "$metadata" = "regular file:$ADMIN_UID" || "$metadata" = "regular empty file:$ADMIN_UID" ) \
      && ! -L "$temp" ]] || fail invalid_snapshot_during_stage_update
    run_artifact_command_before_deadline "$deadline" unlink -- "$temp" || fail invalid_snapshot_during_stage_update
  fi
  while IFS='=' read -r field payload || [[ -n "$field$payload" ]]; do
    if [[ "$field" = cleanup_stage ]]; then
      ((matches += 1))
      [[ "$payload" = "$expected" ]] || fail invalid_snapshot_stage_transition
      updated_line="cleanup_stage=$next"
    else
      updated_line="$field=$payload"
    fi
    if [[ -z "$updated_data" ]]; then updated_data=$updated_line; else updated_data+=$'\n'$updated_line; fi
  done <<< "$snapshot_data"
  ((matches == 1)) || fail invalid_snapshot_stage_transition
  updated_data+=$'\n'
  run_artifact_command_before_deadline "$deadline" /bin/sh -c \
    'umask 077; printf "%s" "$1" > "$2"' sh "$updated_data" "$temp" || \
    fail invalid_snapshot_during_stage_update
  run_artifact_command_before_deadline "$deadline" chmod 0600 -- "$temp" || fail invalid_snapshot_during_stage_update
  sync_path_before_deadline "$deadline" "$temp" || fail invalid_snapshot_during_stage_update
  run_artifact_command_before_deadline "$deadline" mv -T -- "$temp" "$SNAPSHOT" || fail invalid_snapshot_during_stage_update
  sync_path_before_deadline "$deadline" "$MIGRATIONS" || fail invalid_snapshot_during_stage_update
  RECORD[cleanup_stage]=$next
}

remove_new_enablement_link() {
  local deadline=$1 resolved
  if [[ -e "$NEW_WANTS_LINK" || -L "$NEW_WANTS_LINK" ]]; then
    resolved=$(run_command_before_deadline "$deadline" readlink -f -- "$NEW_WANTS_LINK") || \
      fail new_artifact_identity_changed
    [[ -L "$NEW_WANTS_LINK" && "$resolved" = "$NEW_UNIT" ]] || \
      fail new_artifact_identity_changed
    run_command_before_deadline "$deadline" unlink -- "$NEW_WANTS_LINK" || fail new_service_disable_failed
  fi
  [[ ! -e "$NEW_WANTS_LINK" && ! -L "$NEW_WANTS_LINK" ]] || fail new_service_disable_failed
}

delete_release_tree() {
  local deadline=$1 relative directory
  verify_release_tree "$deadline" 1 "$CLEANUP_MANIFEST"
  if ((FIXTURE)); then
    run_artifact_command_before_deadline "$deadline" chmod u+w -- "$RELEASE_TARGET" || fail new_artifact_cleanup_failed
    for directory in "${RELEASE_DIRECTORIES[@]}"; do
      [[ ! -d "$RELEASE_TARGET/$directory" ]] || \
        run_artifact_command_before_deadline "$deadline" chmod u+w -- "$RELEASE_TARGET/$directory" || fail new_artifact_cleanup_failed
    done
  fi
  for relative in "${RELEASE_FILES[@]}"; do
    [[ ! -e "$RELEASE_TARGET/$relative" && ! -L "$RELEASE_TARGET/$relative" ]] || \
      run_artifact_command_before_deadline "$deadline" unlink -- "$RELEASE_TARGET/$relative" || fail new_artifact_cleanup_failed
  done
  [[ ! -e "$RELEASE_TARGET/release.manifest" && ! -L "$RELEASE_TARGET/release.manifest" ]] || \
    run_artifact_command_before_deadline "$deadline" unlink -- "$RELEASE_TARGET/release.manifest" || fail new_artifact_cleanup_failed
  for directory in "${RELEASE_DIRECTORIES[@]}"; do
    [[ ! -d "$RELEASE_TARGET/$directory" ]] || \
      run_artifact_command_before_deadline "$deadline" rmdir -- "$RELEASE_TARGET/$directory" || fail new_artifact_cleanup_failed
  done
  run_artifact_command_before_deadline "$deadline" rmdir -- "$RELEASE_TARGET" || fail new_artifact_cleanup_failed
}

sync_cleanup_directories() {
  local deadline=$1 directory
  for directory in "$WORKLOAD_HOME" "$RELEASES" "$NEW_CONFIG_DIRECTORY" \
    "$NEW_UNIT_DIRECTORY" "$NEW_WANTS_DIRECTORY"; do
    [[ -e "$directory" || -L "$directory" ]] || continue
    [[ -d "$directory" && ! -L "$directory" ]] || fail new_artifact_cleanup_failed
    sync_path_before_deadline "$deadline" "$directory" || fail new_artifact_cleanup_failed
  done
}

verify_old_router() {
  local deadline=$1
  local output key value load active enabled fragment pid control_group listener props_status cgroup_output
  local attempt=0 max_attempts=0 main_in_cgroup cgroup_file cgroup_pid process_ready process_uid process_exe
  local listener_ok props_ok
  local -a cgroup_pids=()
  local remaining inspection_timeout request_timeout
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]] || fail old_router_restore_unprovable
  ((FIXTURE == 0)) || max_attempts=8
  while ((SECONDS < deadline)); do
    ((attempt += 1))
    ((max_attempts == 0 || attempt <= max_attempts)) || break
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    inspection_timeout=$remaining
    ((inspection_timeout <= 10)) || inspection_timeout=10
    load= active= enabled= fragment= pid= control_group=
    output=$("$TIMEOUT" --signal=KILL "${inspection_timeout}s" \
      "$SYSTEMCTL" --user --machine="${TARGET_USER}@.host" show qwen38.service \
      --property=LoadState --property=ActiveState --property=UnitFileState \
      --property=FragmentPath --property=MainPID --property=ControlGroup 2>/dev/null) || output=
    while IFS='=' read -r key value; do
      case "$key" in
        LoadState) load=$value ;;
        ActiveState) active=$value ;;
        UnitFileState) enabled=$value ;;
        FragmentPath) fragment=$value ;;
        MainPID) pid=$value ;;
        ControlGroup) control_group=$value ;;
        '') ;;
        *) fail old_router_restore_unprovable ;;
      esac
    done <<< "$output"
    [[ "$active" != failed ]] || fail old_router_restore_failed
    if [[ -n "$output" ]]; then
      [[ "$load" = loaded && "$fragment" = "$OLD_UNIT" && "$enabled" = "${RECORD[old_enabled]}" ]] || fail old_router_restore_unprovable
    fi

    if [[ "$active" = active && "$pid" =~ ^[1-9][0-9]*$ && "$control_group" = "${RECORD[old_control_group]}" ]]; then
      remaining=$((deadline - SECONDS))
      ((remaining > 0)) || break
      inspection_timeout=$remaining
      ((inspection_timeout <= 10)) || inspection_timeout=10
      listener_ok=0
      if listener=$("$TIMEOUT" --signal=KILL "${inspection_timeout}s" "$SS" -H -ltnp 'sport = :8080' 2>/dev/null); then
        listener_ok=1
      else
        listener=
      fi
      process_ready=0
      main_in_cgroup=0
      if ((FIXTURE)); then
        cgroup_file="$GWM_FAKE_STATE/old-cgroup-pids"
        if [[ -r "$cgroup_file" && ! -L "$cgroup_file" ]]; then
          cgroup_pids=()
          if cgroup_output=$(run_command_before_deadline "$deadline" cat -- "$cgroup_file" 2>/dev/null); then
            mapfile -t cgroup_pids <<< "$cgroup_output"
            for cgroup_pid in "${cgroup_pids[@]}"; do [[ "$cgroup_pid" = "$pid" ]] && main_in_cgroup=1; done
          fi
        fi
        ((main_in_cgroup == 1)) && process_ready=1
      else
        cgroup_file="/sys/fs/cgroup$control_group/cgroup.procs"
        if process_uid=$(run_command_before_deadline "$deadline" stat -c '%u' -- "/proc/$pid" 2>/dev/null); then :; else process_uid=; fi
        if process_exe=$(run_command_before_deadline "$deadline" readlink -f -- "/proc/$pid/exe" 2>/dev/null); then :; else process_exe=; fi
        if [[ -d "/proc/$pid" && "$process_uid" = "$TARGET_UID" \
          && "$process_exe" = /home/agentops/apps/qwen38/build-vulkan/bin/llama-server \
          && -r "$cgroup_file" && ! -L "$cgroup_file" ]]; then
          cgroup_pids=()
          if cgroup_output=$(run_command_before_deadline "$deadline" cat -- "$cgroup_file" 2>/dev/null); then
            mapfile -t cgroup_pids <<< "$cgroup_output"
            for cgroup_pid in "${cgroup_pids[@]}"; do [[ "$cgroup_pid" = "$pid" ]] && main_in_cgroup=1; done
          fi
          ((main_in_cgroup == 1)) && process_ready=1
        fi
      fi
      if ((process_ready == 1 && listener_ok == 1)) && single_ipv4_listener_for_pid "$listener" "$pid"; then
        remaining=$((deadline - SECONDS))
        if ((remaining > 0)); then
          request_timeout=$remaining
          ((request_timeout <= 5)) || request_timeout=5
          if "$CURL" --fail --silent --show-error --max-time "$request_timeout" http://127.0.0.1:8080/health >/dev/null 2>&1; then
            remaining=$((deadline - SECONDS))
            if ((remaining > 0)); then
              request_timeout=$remaining
              ((request_timeout <= 5)) || request_timeout=5
              props_ok=0
              if props_status=$("$CURL" --silent --output /dev/null --write-out '%{http_code}' --max-time "$request_timeout" http://127.0.0.1:8080/props 2>/dev/null); then
                props_ok=1
              else
                props_status=
              fi
              ((props_ok == 1)) && [[ "$props_status" = 401 ]] && return 0
            fi
          fi
        fi
      fi
    fi
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    ((FIXTURE)) || sleep 1
  done
  return 1
}

MIGRATIONS=$(target_path /var/lib/qwen38-workload-manager-migrations)
validate_migration_directory "$BOOTSTRAP_DEADLINE" "$MIGRATIONS"
MIGRATION_LOCK="$MIGRATIONS/install.lock"
MIGRATION_LOCK_META=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" stat -c '%F:%a:%u:%h' -- "$MIGRATION_LOCK") || \
  fail unsafe_migration_lock
IFS=: read -r MIGRATION_LOCK_TYPE MIGRATION_LOCK_MODE MIGRATION_LOCK_UID MIGRATION_LOCK_LINKS <<< "$MIGRATION_LOCK_META"
[[ ( "$MIGRATION_LOCK_TYPE" = 'regular file' || "$MIGRATION_LOCK_TYPE" = 'regular empty file' ) \
  && "$MIGRATION_LOCK_MODE:$MIGRATION_LOCK_UID:$MIGRATION_LOCK_LINKS" = "600:$ADMIN_UID:1" ]] || fail unsafe_migration_lock
if ((LOCK_HELD)); then
  INHERITED_LOCK=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" readlink -f -- /proc/$$/fd/9) || \
    fail migration_lock_not_inherited
  [[ "$INHERITED_LOCK" = "$MIGRATION_LOCK" ]] || fail migration_lock_not_inherited
else
  exec 9<>"$MIGRATION_LOCK"
  run_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" "$FLOCK" -n 9 || fail concurrent_migration
fi

CANONICAL_SNAPSHOT=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" readlink -f -- "$SNAPSHOT") || fail invalid_snapshot
[[ "$CANONICAL_SNAPSHOT" = "$SNAPSHOT" && "$SNAPSHOT" = "$MIGRATIONS"/transaction-*.snapshot ]] || fail invalid_snapshot_location
SNAPSHOT_META=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" stat -c '%F:%a:%u:%h:%s' -- "$SNAPSHOT") || \
  fail invalid_snapshot_policy
IFS=: read -r SNAPSHOT_TYPE SNAPSHOT_MODE SNAPSHOT_UID SNAPSHOT_LINKS SNAPSHOT_SIZE <<< "$SNAPSHOT_META"
[[ "$SNAPSHOT_TYPE" = 'regular file' && "$SNAPSHOT_MODE:$SNAPSHOT_UID:$SNAPSHOT_LINKS" = "600:$ADMIN_UID:1" \
  && "$SNAPSHOT_SIZE" =~ ^[1-9][0-9]*$ && "$SNAPSHOT_SIZE" -le 8192 ]] || fail invalid_snapshot_policy
SNAPSHOT_CONTENT=$(read_bootstrap_command_before_deadline "$BOOTSTRAP_DEADLINE" cat -- "$SNAPSHOT") || fail invalid_snapshot

declare -A RECORD=()
while IFS='=' read -r KEY VALUE || [[ -n "$KEY$VALUE" ]]; do
  case "$KEY" in
    version|release_id|new_service_stage|cleanup_stage|old_active|old_enabled|old_main_pid|old_control_group|old_unit_dev|old_unit_inode|old_unit_uid|old_unit_gid|old_unit_mode|old_unit_mtime|old_unit_ctime|old_unit_size|old_unit_sha256|old_config_dev|old_config_inode|old_config_uid|old_config_gid|old_config_mode|old_config_mtime|old_config_ctime|old_config_size|old_config_sha256|new_unit_sha256|new_manager_sha256|new_models_sha256)
      [[ -z ${RECORD["$KEY"]+x} ]] || fail invalid_snapshot_duplicate_key
      RECORD["$KEY"]=$VALUE
      ;;
    *) fail invalid_snapshot_key ;;
  esac
done <<< "$SNAPSHOT_CONTENT"

REQUIRED_KEYS=(
  version release_id new_service_stage cleanup_stage old_active old_enabled old_main_pid old_control_group
  old_unit_dev old_unit_inode old_unit_uid old_unit_gid old_unit_mode old_unit_mtime old_unit_ctime old_unit_size old_unit_sha256
  old_config_dev old_config_inode old_config_uid old_config_gid old_config_mode old_config_mtime old_config_ctime old_config_size old_config_sha256
  new_unit_sha256 new_manager_sha256 new_models_sha256
)
for KEY in "${REQUIRED_KEYS[@]}"; do [[ -n ${RECORD["$KEY"]+x} ]] || fail invalid_snapshot_missing_key; done
[[ ${RECORD[version]} = 3 ]] || fail invalid_snapshot_version
[[ ${RECORD[release_id]} =~ ^[0-9a-f]{64}$ ]] || fail invalid_snapshot_release_id
case ${RECORD[new_service_stage]} in
  not_installed|files_installed|reload_attempted|enable_attempted|start_attempted) ;;
  *) fail invalid_snapshot_stage ;;
esac
case ${RECORD[cleanup_stage]} in
  not_started|started|complete) ;;
  *) fail invalid_snapshot_stage ;;
esac
[[ ${RECORD[old_active]} = active ]] || fail invalid_snapshot_old_state
[[ ${RECORD[old_enabled]} = enabled || ${RECORD[old_enabled]} = disabled ]] || fail invalid_snapshot_old_state
[[ ${RECORD[old_main_pid]} =~ ^[1-9][0-9]*$ ]] || fail invalid_snapshot_old_state
[[ ${RECORD[old_control_group]} = /user.slice/user-1001.slice/user@1001.service/app.slice/qwen38.service ]] || fail invalid_snapshot_old_state
for KEY in old_unit_dev old_unit_inode old_unit_uid old_unit_gid old_unit_mode old_unit_mtime old_unit_ctime old_unit_size old_config_dev old_config_inode old_config_uid old_config_gid old_config_mode old_config_mtime old_config_ctime old_config_size; do
  [[ ${RECORD["$KEY"]} =~ ^[0-9]+$ ]] || fail invalid_snapshot_metadata
done
for KEY in old_unit_sha256 old_config_sha256 new_unit_sha256 new_manager_sha256 new_models_sha256; do
  [[ ${RECORD["$KEY"]} =~ ^[0-9a-f]{64}$ ]] || fail invalid_snapshot_digest
done

OLD_UNIT=$(target_path /home/agentops/.config/systemd/user/qwen38.service)
OLD_CONFIG=$(target_path /home/agentops/apps/qwen38/config/models.json)
NEW_UNIT=$(target_path /etc/systemd/system/qwen38-workload-manager.service)
NEW_WANTS_LINK=$(target_path /etc/systemd/system/multi-user.target.wants/qwen38-workload-manager.service)
NEW_MANAGER=$(target_path /etc/qwen38-workload-manager/manager.production.json)
NEW_MODELS=$(target_path /etc/qwen38-workload-manager/models.production.json)
CURRENT_LINK=$(target_path /opt/qwen38-workload-manager/current)
RELEASE_TARGET=$(target_path "/opt/qwen38-workload-manager/releases/${RECORD[release_id]}")
CLEANUP_MANIFEST="$SNAPSHOT.cleanup-manifest"
WORKLOAD_HOME=${CURRENT_LINK%/*}
RELEASES=${RELEASE_TARGET%/*}
NEW_CONFIG_DIRECTORY=${NEW_MANAGER%/*}
NEW_UNIT_DIRECTORY=${NEW_UNIT%/*}
NEW_WANTS_DIRECTORY=${NEW_WANTS_LINK%/*}

if ((APPLY == 0)); then
  DRY_RUN_VALIDATION_DEADLINE=$((SECONDS + ARTIFACT_VALIDATION_TIMEOUT_SECONDS))
  verify_transaction_artifacts "$DRY_RUN_VALIDATION_DEADLINE"
  printf 'rollback-ubuntu: dry-run PASS; no changes made snapshot=%s\n' "$SNAPSHOT"
  exit 0
fi

if ((LOCK_HELD == 0)); then
  # An operator-requested rollback still has the new service available, so
  # reject a tampered cleanup tree before making any service mutation. The
  # automatic path prioritizes restoring the already-stopped old router.
  EXPLICIT_VALIDATION_DEADLINE=$((SECONDS + ARTIFACT_VALIDATION_TIMEOUT_SECONDS))
  verify_transaction_artifacts "$EXPLICIT_VALIDATION_DEADLINE"
fi
# Bash's SECONDS has one-second resolution. Add one resolution unit so the
# configured budget cannot collapse to almost zero at a tick boundary.
RECOVERY_IDENTITY_DEADLINE=$((SECONDS + RECOVERY_IDENTITY_TIMEOUT_SECONDS + 1))
verify_old_identity "$RECOVERY_IDENTITY_DEADLINE" old_unit "$OLD_UNIT"
verify_old_identity "$RECOVERY_IDENTITY_DEADLINE" old_config "$OLD_CONFIG"

NEW_SERVICE_CLEANUP_DEADLINE=$((SECONDS + NEW_SERVICE_CLEANUP_TIMEOUT_SECONDS))
case ${RECORD[new_service_stage]} in
  not_installed|files_installed|reload_attempted|enable_attempted)
    # No start was attempted. (enable_attempted may have created only the
    # boot-time wants link.) This branch deliberately avoids the system manager
    # so an unavailable PID 1 cannot prevent restoring the independently
    # managed user service. Kernel state still has to prove that neither the
    # manager nor its inference child exists.
    new_runtime_absent "$NEW_SERVICE_CLEANUP_DEADLINE" || fail new_service_runtime_not_absent
    ;;
  start_attempted)
    if run_systemctl_before_deadline "$NEW_SERVICE_CLEANUP_DEADLINE" stop qwen38-workload-manager.service; then
      new_runtime_absent "$NEW_SERVICE_CLEANUP_DEADLINE" || fail new_service_stop_failed
    else
      prove_new_service_quiesced "$NEW_SERVICE_CLEANUP_DEADLINE" || fail new_service_stop_failed
    fi
    ;;
esac
case ${RECORD[new_service_stage]} in
  enable_attempted|start_attempted)
    run_systemctl_before_deadline "$NEW_SERVICE_CLEANUP_DEADLINE" --no-reload disable qwen38-workload-manager.service || true
    ;;
esac
remove_new_enablement_link "$NEW_SERVICE_CLEANUP_DEADLINE"

# Service operations create a race window, so validate the exact root-owned tree
# before restoration. Keep every recovery artifact until the old 20+ GiB model
# has finished loading and its protected endpoint is proven healthy.
RECOVERY_IDENTITY_DEADLINE=$((SECONDS + RECOVERY_IDENTITY_TIMEOUT_SECONDS + 1))
verify_old_identity "$RECOVERY_IDENTITY_DEADLINE" old_unit "$OLD_UNIT"
verify_old_identity "$RECOVERY_IDENTITY_DEADLINE" old_config "$OLD_CONFIG"

OLD_RESTORE_DEADLINE=$((SECONDS + OLD_RESTORE_TIMEOUT_SECONDS))
if [[ ${RECORD[old_enabled]} = enabled ]]; then
  run_old_systemctl_before_deadline "$OLD_RESTORE_DEADLINE" enable qwen38.service || true
else
  run_old_systemctl_before_deadline "$OLD_RESTORE_DEADLINE" disable qwen38.service || true
fi
unit_file_state_is_before_deadline "$OLD_RESTORE_DEADLINE" old "${RECORD[old_enabled]}" || \
  printf 'rollback-ubuntu: old enablement not yet proven; continuing with bounded service restore\n' >&2
run_old_systemctl_before_deadline "$OLD_RESTORE_DEADLINE" --no-block start qwen38.service || true

verify_old_identity "$OLD_RESTORE_DEADLINE" old_unit "$OLD_UNIT"
verify_old_identity "$OLD_RESTORE_DEADLINE" old_config "$OLD_CONFIG"
verify_old_router "$OLD_RESTORE_DEADLINE" || fail old_router_restore_unprovable

# Only the exact manifest-pinned new artifacts are removed, and only after the
# old router is serving again. Persist a cleanup plan and stage before the first
# unlink so an interrupted cleanup can safely converge on the next invocation.
CLEANUP_DEADLINE=$((SECONDS + ARTIFACT_VALIDATION_TIMEOUT_SECONDS))
verify_transaction_artifacts "$CLEANUP_DEADLINE"
if [[ ${RECORD[cleanup_stage]} = not_started ]]; then
  prepare_cleanup_manifest "$CLEANUP_DEADLINE"
  update_cleanup_stage "$CLEANUP_DEADLINE" not_started started
  verify_transaction_artifacts "$CLEANUP_DEADLINE"
fi
if [[ ${RECORD[cleanup_stage]} = started ]]; then
  for path in "$CURRENT_LINK" "$NEW_WANTS_LINK" "$NEW_UNIT" "$NEW_MANAGER" "$NEW_MODELS"; do
    [[ ! -e "$path" && ! -L "$path" ]] || \
      run_artifact_command_before_deadline "$CLEANUP_DEADLINE" unlink -- "$path" || fail new_artifact_cleanup_failed
  done
  if [[ -d "$RELEASE_TARGET" ]]; then delete_release_tree "$CLEANUP_DEADLINE"; fi
  # The started snapshot and external cleanup manifest are already durable.
  # Flush every filesystem namespace that was mutated before persisting
  # complete, so a power loss can only reveal a safely resumable state.
  sync_cleanup_directories "$CLEANUP_DEADLINE"
  update_cleanup_stage "$CLEANUP_DEADLINE" started complete
fi
verify_transaction_artifacts "$CLEANUP_DEADLINE"
if [[ -e "$CLEANUP_MANIFEST" || -L "$CLEANUP_MANIFEST" ]]; then
  validate_cleanup_manifest "$CLEANUP_DEADLINE"
  run_artifact_command_before_deadline "$CLEANUP_DEADLINE" unlink -- "$CLEANUP_MANIFEST" || fail new_artifact_cleanup_failed
  sync_path_before_deadline "$CLEANUP_DEADLINE" "$MIGRATIONS" || fail new_artifact_cleanup_failed
fi
POST_RESTORE_DEADLINE=$((SECONDS + POST_RESTORE_CLEANUP_TIMEOUT_SECONDS))
run_systemctl_before_deadline "$POST_RESTORE_DEADLINE" daemon-reload || fail new_service_reload_failed
verify_old_router "$POST_RESTORE_DEADLINE" || fail old_router_restore_unprovable
printf 'rollback-ubuntu: PASS old=active enabled=%s snapshot=%s\n' "${RECORD[old_enabled]}" "$SNAPSHOT"
