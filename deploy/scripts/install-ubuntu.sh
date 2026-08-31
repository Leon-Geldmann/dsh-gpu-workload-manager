#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
umask 077

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
PREFLIGHT="$SCRIPT_DIRECTORY/preflight-ubuntu.sh"
ROLLBACK="$SCRIPT_DIRECTORY/rollback-ubuntu.sh"

RELEASE_DIR=
RELEASE_ID=
FIXTURE_ROOT=
APPLY=0
ARTIFACT_GATE_TIMEOUT_SECONDS=7200
SYSTEMCTL_COMMAND_TIMEOUT_SECONDS=30
OLD_QUIESCE_TIMEOUT_SECONDS=120
CANARY_CLEANUP_TIMEOUT_SECONDS=90
ARTIFACT_REVALIDATION_COMMAND_TIMEOUT_SECONDS=7200
STATE_INSPECTION_TIMEOUT_SECONDS=30
FAILURE_CLEANUP_TIMEOUT_SECONDS=60

usage() {
  printf '%s\n' 'usage: install-ubuntu.sh --release-dir ABS_DIR --release-id SHA256 [--fixture-root ABS_DIR] [--apply]'
}

fail() {
  printf 'install-ubuntu: FAIL %s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --release-dir)
      (($# >= 2)) || fail missing_release_dir
      RELEASE_DIR=$2
      shift 2
      ;;
    --release-id)
      (($# >= 2)) || fail missing_release_id
      RELEASE_ID=$2
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
    --help|-h)
      usage
      exit 0
      ;;
    *) fail unknown_argument ;;
  esac
done

PREFLIGHT_ARGUMENTS=(--release-dir "$RELEASE_DIR" --release-id "$RELEASE_ID")
if [[ -n "$FIXTURE_ROOT" ]]; then
  PREFLIGHT_ARGUMENTS+=(--fixture-root "$FIXTURE_ROOT")
fi
"$PREFLIGHT" "${PREFLIGHT_ARGUMENTS[@]}"

if ((APPLY == 0)); then
  printf 'install-ubuntu: dry-run PASS; no changes made release=%s\n' "$RELEASE_ID"
  exit 0
fi

FIXTURE=0
ROOT_PREFIX=
if [[ -n "$FIXTURE_ROOT" ]]; then
  FIXTURE=1
  ROOT_PREFIX=$FIXTURE_ROOT
  TARGET_USER=$(id -un)
  TARGET_GROUP=$(id -gn)
  TARGET_UID=$(id -u)
  ADMIN_USER=$TARGET_USER
  ADMIN_GROUP=$TARGET_GROUP
  ADMIN_UID=$TARGET_UID
  ADMIN_GID=$(id -g)
  SYSTEMCTL=$(command -v systemctl) || fail missing_systemctl
  SS=$(command -v ss) || fail missing_ss
  UFW=$(command -v ufw) || fail missing_ufw
  IPTABLES_SAVE=$(command -v iptables-save) || fail missing_iptables_save
  IP6TABLES_SAVE=$(command -v ip6tables-save) || fail missing_ip6tables_save
  CURL=$(command -v curl) || fail missing_curl
  INSTALL=$(command -v install) || fail missing_install
  FLOCK=$(command -v flock) || fail missing_flock
  TIMEOUT=$(command -v timeout) || fail missing_timeout
  SYSTEMCTL_COMMAND_TIMEOUT_SECONDS=1
  ARTIFACT_REVALIDATION_COMMAND_TIMEOUT_SECONDS=2
  OLD_QUIESCE_TIMEOUT_SECONDS=3
  CANARY_CLEANUP_TIMEOUT_SECONDS=3
  STATE_INSPECTION_TIMEOUT_SECONDS=3
  FAILURE_CLEANUP_TIMEOUT_SECONDS=3
else
  ((EUID == 0)) || fail production_install_requires_root
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
  TARGET_USER=agentops
  TARGET_GROUP=agentops
  TARGET_UID=$(id -u "$TARGET_USER" 2>/dev/null) || fail missing_agentops_user
  [[ "$TARGET_UID" = 1001 ]] || fail unexpected_agentops_uid
  ADMIN_USER=root
  ADMIN_GROUP=root
  ADMIN_UID=0
  ADMIN_GID=0
  SYSTEMCTL=/usr/bin/systemctl
  SS=/usr/bin/ss
  UFW=/usr/sbin/ufw
  IPTABLES_SAVE=/usr/sbin/iptables-save
  IP6TABLES_SAVE=/usr/sbin/ip6tables-save
  CURL=/usr/bin/curl
  INSTALL=/usr/bin/install
  FLOCK=/usr/bin/flock
  TIMEOUT=/usr/bin/timeout
  SYSTEMD_RUN=/usr/bin/systemd-run
  for COMMAND in "$SYSTEMCTL" "$SS" "$UFW" "$IPTABLES_SAVE" "$IP6TABLES_SAVE" "$CURL" "$INSTALL" "$FLOCK" "$TIMEOUT" "$SYSTEMD_RUN"; do
    [[ -x "$COMMAND" ]] || fail missing_required_command
  done
fi

target_path() {
  printf '%s%s\n' "$ROOT_PREFIX" "$1"
}

old_systemctl() {
  "$SYSTEMCTL" --user --machine="${TARGET_USER}@.host" "$@"
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

cgroup_procs_before_deadline() {
  local deadline=$1 path=$2 output
  [[ -e "$path" ]] || return 2
  [[ -r "$path" && ! -L "$path" ]] || return 1
  output=$(run_command_before_deadline "$deadline" cat -- "$path") || return 1
  printf '%s' "$output"
}

cgroup_procs_empty() {
  local deadline=$1 path=$2 cgroup_pid output
  local -a cgroup_pids=()
  [[ ! -e "$path" ]] && return 0
  output=$(cgroup_procs_before_deadline "$deadline" "$path") || return 1
  mapfile -t cgroup_pids <<< "$output"
  for cgroup_pid in "${cgroup_pids[@]}"; do
    [[ -z "$cgroup_pid" ]] && continue
    [[ "$cgroup_pid" =~ ^[1-9][0-9]*$ ]] || return 1
    return 1
  done
  return 0
}

ensure_admin_directory() {
  local path=$1 mode=$2 canonical current_mode
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    "$INSTALL" -d -m "$mode" -o "$ADMIN_USER" -g "$ADMIN_GROUP" "$path"
  fi
  [[ -d "$path" && ! -L "$path" ]] || fail unsafe_admin_directory
  canonical=$(readlink -f -- "$path") || fail unsafe_admin_directory
  [[ "$canonical" = "$path" ]] || fail unsafe_admin_directory
  [[ $(stat -c '%u:%g' -- "$path") = "$ADMIN_UID:$ADMIN_GID" ]] || fail unsafe_admin_directory
  current_mode=$(stat -c '%a' -- "$path")
  (( (8#$current_mode & 022) == 0 && (8#$current_mode & 07000) == 0 )) || fail unsafe_admin_directory
  chmod "$mode" -- "$path"
}

validate_migration_ancestors() {
  local current=$1 mode owner stop=/
  ((FIXTURE == 0)) || stop=$FIXTURE_ROOT
  while :; do
    [[ -d "$current" && ! -L "$current" ]] || fail unsafe_migration_directory
    mode=$(stat -c '%a' -- "$current")
    owner=$(stat -c '%u' -- "$current")
    if ((FIXTURE)); then
      (( (8#$mode & 002) == 0 && (8#$mode & 07000) == 0 )) || fail unsafe_migration_directory
    else
      (( (8#$mode & 022) == 0 && (8#$mode & 07000) == 0 )) || fail unsafe_migration_directory
    fi
    [[ "$owner" = "$ADMIN_UID" ]] || fail unsafe_migration_directory
    [[ "$current" = "$stop" || "$current" = / ]] && break
    current=$(dirname -- "$current")
  done
}

snapshot_old_state() {
  local deadline=$1 output key value main_in_cgroup=0 cgroup_output
  local -a cgroup_pids=()
  declare -A state=()
  declare -g OLD_ACTIVE=
  declare -g OLD_ENABLED=
  declare -g OLD_MAIN_PID=
  declare -g OLD_CONTROL_GROUP=
  output=$(run_old_systemctl_before_deadline "$deadline" show qwen38.service \
    --property=LoadState --property=ActiveState --property=UnitFileState \
    --property=FragmentPath --property=MainPID --property=ControlGroup) || fail old_router_state_unprovable
  while IFS='=' read -r key value; do
    case "$key" in
      LoadState|ActiveState|UnitFileState|FragmentPath|MainPID|ControlGroup)
        [[ -z ${state["$key"]+x} ]] || fail old_router_state_unprovable
        state["$key"]=$value
        ;;
      '') ;;
      *) fail old_router_state_unprovable ;;
    esac
  done <<< "$output"
  [[ ${#state[@]} = 6 && ${state[LoadState]} = loaded && ${state[FragmentPath]} = "$OLD_UNIT" ]] || fail old_router_state_unprovable
  OLD_ACTIVE=${state[ActiveState]}
  OLD_ENABLED=${state[UnitFileState]}
  OLD_MAIN_PID=${state[MainPID]}
  OLD_CONTROL_GROUP=${state[ControlGroup]}
  [[ "$OLD_ACTIVE" = active ]] || fail old_router_state_unprovable
  [[ "$OLD_ENABLED" = enabled || "$OLD_ENABLED" = disabled ]] || fail old_router_state_unprovable
  [[ "$OLD_MAIN_PID" =~ ^[1-9][0-9]*$ ]] || fail old_router_state_unprovable
  [[ "$OLD_CONTROL_GROUP" = /user.slice/user-1001.slice/user@1001.service/app.slice/qwen38.service ]] || fail old_router_state_unprovable
  if ((FIXTURE)); then
    cgroup_output=$(cgroup_procs_before_deadline "$deadline" "$GWM_FAKE_STATE/old-cgroup-pids") || \
      fail old_router_state_unprovable
  else
    OLD_CGROUP_PROCS="/sys/fs/cgroup$OLD_CONTROL_GROUP/cgroup.procs"
    [[ -f "$OLD_CGROUP_PROCS" && ! -L "$OLD_CGROUP_PROCS" ]] || fail old_router_state_unprovable
    cgroup_output=$(cgroup_procs_before_deadline "$deadline" "$OLD_CGROUP_PROCS") || \
      fail old_router_state_unprovable
  fi
  mapfile -t cgroup_pids <<< "$cgroup_output"
  for CGROUP_PID in "${cgroup_pids[@]}"; do [[ "$CGROUP_PID" = "$OLD_MAIN_PID" ]] && main_in_cgroup=1; done
  ((main_in_cgroup == 1)) || fail old_router_state_unprovable
}

legacy_llama_processes_absent() {
  local deadline=$1 proc_root=$2 process_directory process_uid process_exe
  local process_stat process_stat_tail process_state
  [[ ! -e "$proc_root/$OLD_MAIN_PID" ]] || return 1
  for process_directory in "$proc_root"/[0-9]*; do
    ((SECONDS < deadline)) || return 1
    [[ -d "$process_directory" ]] || continue
    if process_uid=$(run_command_before_deadline "$deadline" stat -c '%u' -- "$process_directory" 2>/dev/null); then
      :
    elif [[ ! -d "$process_directory" ]]; then
      continue
    else
      return 1
    fi
    [[ "$process_uid" = "$TARGET_UID" ]] || continue
    if process_exe=$(run_command_before_deadline "$deadline" readlink -f -- "$process_directory/exe" 2>/dev/null); then
      if [[ "$process_exe" = /home/agentops/apps/qwen38/build-vulkan/bin/llama-server \
        || "$process_exe" = '/home/agentops/apps/qwen38/build-vulkan/bin/llama-server (deleted)' ]]; then
        return 1
      fi
      continue
    fi
    [[ -d "$process_directory" ]] || continue
    if process_stat=$(run_command_before_deadline "$deadline" cat -- "$process_directory/stat" 2>/dev/null); then
      process_stat_tail=${process_stat##*) }
      [[ "$process_stat_tail" != "$process_stat" ]] || return 1
      process_state=${process_stat_tail%% *}
      [[ "$process_state" = Z ]] && continue
    elif [[ ! -d "$process_directory" ]]; then
      continue
    fi
    # An extant, same-UID process with an unreadable executable is safe to
    # ignore only when /proc positively identifies it as a zombie.
    return 1
  done
  ((SECONDS < deadline))
}

prove_old_quiesced() {
  local deadline=$1 output key value active sub pid control_group job cgroup_file
  local active_seen sub_seen pid_seen control_group_seen job_seen remaining inspection_timeout
  local attempt=0 max_attempts=0 failure=old_router_not_quiesced runtime_absent
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]] || fail old_router_not_quiesced
  ((FIXTURE == 0)) || max_attempts=8
  while ((SECONDS < deadline)); do
    ((attempt += 1))
    ((max_attempts == 0 || attempt <= max_attempts)) || break
    active= sub= pid= control_group= job=
    active_seen=0 sub_seen=0 pid_seen=0 control_group_seen=0 job_seen=0
    output=$(run_old_systemctl_before_deadline "$deadline" show qwen38.service \
      --property=ActiveState --property=SubState --property=MainPID \
      --property=ControlGroup --property=Job 2>/dev/null) || output=
    while IFS='=' read -r key value; do
      case "$key" in
        ActiveState) ((active_seen += 1)); active=$value ;;
        SubState) ((sub_seen += 1)); sub=$value ;;
        MainPID) ((pid_seen += 1)); pid=$value ;;
        ControlGroup) ((control_group_seen += 1)); control_group=$value ;;
        Job) ((job_seen += 1)); job=$value ;;
        '') ;;
        *) active_seen=2 ;;
      esac
    done <<< "$output"
    if ((active_seen == 1 && sub_seen == 1 && pid_seen == 1 && control_group_seen == 1 && job_seen == 1)) \
      && [[ "$active" = inactive && "$sub" = dead && "$pid" = 0 && -z "$job" \
        && ( -z "$control_group" || "$control_group" = "$OLD_CONTROL_GROUP" ) ]]; then
      remaining=$((deadline - SECONDS))
      if ((remaining <= 0)); then
        failure=port_8080_inspection_failed
      else
        inspection_timeout=$remaining
        ((inspection_timeout <= 10)) || inspection_timeout=10
        if ! PORT_8080=$("$TIMEOUT" --signal=KILL "$inspection_timeout"s "$SS" -H -ltnp 'sport = :8080' 2>/dev/null); then
          failure=port_8080_inspection_failed
        elif [[ -n "$PORT_8080" ]]; then
          failure=port_8080_not_free_after_old_stop
        else
          failure=old_router_not_quiesced
          runtime_absent=1
          if ((FIXTURE)); then
            cgroup_procs_empty "$deadline" "$GWM_FAKE_STATE/old-cgroup-pids" || runtime_absent=0
            [[ $(tr -d '\n' < "$GWM_FAKE_STATE/old-gpu-owner") = 0 ]] || runtime_absent=0
            if [[ -e "$GWM_FAKE_STATE/use-production-process-scan" ]]; then
              legacy_llama_processes_absent "$deadline" "$GWM_FAKE_STATE/proc" || runtime_absent=0
            fi
          else
            cgroup_file="/sys/fs/cgroup$OLD_CONTROL_GROUP/cgroup.procs"
            cgroup_procs_empty "$deadline" "$cgroup_file" || runtime_absent=0
            legacy_llama_processes_absent "$deadline" /proc || runtime_absent=0
          fi
          ((runtime_absent == 0)) || return 0
        fi
      fi
    else
      failure=old_router_not_quiesced
    fi
    ((FIXTURE)) || sleep 1
  done
  fail "$failure"
}

port_spec_includes_8080() {
  local value=${1%/tcp} component first last
  value=${value%/udp}
  IFS=',' read -r -a COMPONENTS <<< "$value"
  for component in "${COMPONENTS[@]}"; do
    if [[ "$component" = 8080 ]]; then return 0; fi
    if [[ "$component" =~ ^([0-9]+):([0-9]+)$ ]]; then
      first=${BASH_REMATCH[1]}
      last=${BASH_REMATCH[2]}
      if ((10#$first <= 8080 && 8080 <= 10#$last)); then return 0; fi
    fi
  done
  return 1
}

declare -A FILTER_CHAIN_POLICY=()
declare -A FILTER_RULE_COUNT=()
declare -A FILTER_RULE=()
declare -A FILTER_RULE_SEEN=()

valid_chain_name() {
  [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.:+-]*$ ]]
}

valid_interface_name() {
  [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.:+-]*$ ]]
}

valid_port_spec() {
  local value=$1 component first last
  local -a components=()
  [[ "$value" =~ ^[0-9,:]+$ ]] || return 1
  IFS=',' read -r -a components <<< "$value"
  ((${#components[@]} > 0)) || return 1
  for component in "${components[@]}"; do
    if [[ "$component" =~ ^([0-9]+):([0-9]+)$ ]]; then
      first=${BASH_REMATCH[1]}
      last=${BASH_REMATCH[2]}
      ((10#$first <= 65535 && 10#$last <= 65535 && 10#$first <= 10#$last)) || return 1
    elif [[ "$component" =~ ^[0-9]+$ ]]; then
      ((10#$component <= 65535)) || return 1
    else
      return 1
    fi
  done
}

state_spec_valid() {
  local value=$1 state
  local -a states=()
  declare -A seen=()
  [[ "$value" =~ ^[A-Z]+(,[A-Z]+)*$ ]] || return 1
  IFS=',' read -r -a states <<< "$value"
  for state in "${states[@]}"; do
    case "$state" in NEW|ESTABLISHED|RELATED|INVALID|UNTRACKED|SNAT|DNAT) ;; *) return 1 ;; esac
    [[ -z ${seen["$state"]+x} ]] || return 1
    seen["$state"]=1
  done
}

ipv4_cidr_range() {
  local value=$1 address prefix a b c d ip mask
  if [[ "$value" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)(/([0-9]+))?$ ]]; then
    a=${BASH_REMATCH[1]}; b=${BASH_REMATCH[2]}; c=${BASH_REMATCH[3]}; d=${BASH_REMATCH[4]}
    prefix=${BASH_REMATCH[6]:-32}
  else
    return 1
  fi
  ((10#$a <= 255 && 10#$b <= 255 && 10#$c <= 255 && 10#$d <= 255 && 10#$prefix <= 32)) || return 1
  ip=$(((10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d))
  if ((10#$prefix == 0)); then mask=0; else mask=$(((0xffffffff << (32 - 10#$prefix)) & 0xffffffff)); fi
  (( (ip & mask) == ip )) || return 1
  CIDR_FIRST=$ip
  CIDR_LAST=$((ip | ((~mask) & 0xffffffff)))
}

valid_ipv6_cidr() {
  local value=$1 address prefix
  if [[ "$value" =~ ^([0-9A-Fa-f:.]+)(/([0-9]+))?$ ]]; then
    address=${BASH_REMATCH[1]}
    prefix=${BASH_REMATCH[3]:-128}
  else
    return 1
  fi
  [[ "$address" = *:* && "$address" != *:::* ]] || return 1
  ((10#$prefix <= 128))
}

parse_filter_save() {
  local family=$1 output=$2 line chain policy key count
  local in_filter=0 seen_filter=0 seen_commit=0 seen_rule=0 input_count=0
  local line_count=0 chain_count=0 rule_count=0
  ((${#output} <= 1048576)) || return 1
  while IFS= read -r line; do
    line_count=$((line_count + 1))
    ((line_count <= 20000 && ${#line} <= 4096)) || return 1
    [[ "$line" != *$'\r'* ]] || return 1
    if ((in_filter == 0)); then
      if [[ "$line" = '*filter' ]]; then
        ((seen_filter == 0 && seen_commit == 0)) || return 1
        seen_filter=1
        in_filter=1
      elif [[ -n "$line" && "$line" != \#* ]]; then
        return 1
      fi
      continue
    fi
    if [[ "$line" = COMMIT ]]; then
      in_filter=0
      seen_commit=1
      continue
    fi
    if [[ "$line" =~ ^:([A-Za-z0-9_][A-Za-z0-9_.:+-]*)[[:space:]]+(ACCEPT|DROP|-)[[:space:]]+\[([0-9]+):([0-9]+)\]$ ]]; then
      ((seen_rule == 0)) || return 1
      chain=${BASH_REMATCH[1]}
      policy=${BASH_REMATCH[2]}
      key="$family:$chain"
      [[ -z ${FILTER_CHAIN_POLICY["$key"]+x} ]] || return 1
      if [[ "$chain" = INPUT ]]; then
        input_count=$((input_count + 1))
        [[ "$policy" = DROP ]] || return 1
      elif [[ "$chain" = FORWARD || "$chain" = OUTPUT ]]; then
        [[ "$policy" = ACCEPT || "$policy" = DROP ]] || return 1
      else
        [[ "$policy" = - ]] || return 1
      fi
      FILTER_CHAIN_POLICY["$key"]=$policy
      FILTER_RULE_COUNT["$key"]=0
      chain_count=$((chain_count + 1))
      ((chain_count <= 512)) || return 1
      continue
    fi
    if [[ "$line" =~ ^-A[[:space:]]+([A-Za-z0-9_][A-Za-z0-9_.:+-]*)[[:space:]]+.+$ ]]; then
      seen_rule=1
      chain=${BASH_REMATCH[1]}
      key="$family:$chain"
      [[ -n ${FILTER_CHAIN_POLICY["$key"]+x} ]] || return 1
      validate_filter_rule_structure "$family" "$line" || return 1
      [[ -z ${FILTER_RULE_SEEN["$family:$line"]+x} ]] || return 1
      FILTER_RULE_SEEN["$family:$line"]=1
      count=${FILTER_RULE_COUNT["$key"]}
      count=$((count + 1))
      FILTER_RULE_COUNT["$key"]=$count
      FILTER_RULE["$key:$count"]=$line
      rule_count=$((rule_count + 1))
      ((rule_count <= 10000)) || return 1
      continue
    fi
    return 1
  done <<< "$output"
  ((seen_filter == 1 && seen_commit == 1 && in_filter == 0 && input_count == 1))
}

lex_filter_rule() {
  local line=$1 length=${#1} index=0 character quote= token= in_token=0 escaped=0
  RULE_TOKENS=()
  ((length <= 4096)) || return 1
  while ((index < length)); do
    character=${line:index:1}
    if [[ -n "$quote" ]]; then
      if ((escaped == 1)); then
        token+=$character
        escaped=0
      elif [[ "$character" = '\\' ]]; then
        escaped=1
      elif [[ "$character" = "$quote" ]]; then
        quote=
      else
        token+=$character
      fi
      in_token=1
    else
      case "$character" in
        ' '|$'\t')
          if ((in_token == 1)); then
            RULE_TOKENS+=("$token")
            ((${#RULE_TOKENS[@]} <= 128 && ${#token} <= 1024)) || return 1
            token=
            in_token=0
          fi
          ;;
        '"'|"'") quote=$character; in_token=1 ;;
        '\\')
          index=$((index + 1))
          ((index < length)) || return 1
          token+=${line:index:1}
          in_token=1
          ;;
        [[:cntrl:]]) return 1 ;;
        *) token+=$character; in_token=1 ;;
      esac
    fi
    index=$((index + 1))
  done
  [[ -z "$quote" && $escaped -eq 0 ]] || return 1
  if ((in_token == 1)); then
    RULE_TOKENS+=("$token")
    ((${#RULE_TOKENS[@]} <= 128 && ${#token} <= 1024)) || return 1
  fi
  ((${#RULE_TOKENS[@]} > 0))
}

validate_filter_rule_structure() {
  local family=$1 line=$2 index=2 jump_count=0 target= key
  lex_filter_rule "$line" || return 1
  ((${#RULE_TOKENS[@]} >= 4)) || return 1
  [[ ${RULE_TOKENS[0]} = -A ]] || return 1
  valid_chain_name "${RULE_TOKENS[1]}" || return 1
  while ((index < ${#RULE_TOKENS[@]})); do
    case "${RULE_TOKENS[$index]}" in
      -g|--goto) return 1 ;;
      -j|--jump)
        ((index + 1 < ${#RULE_TOKENS[@]})) || return 1
        jump_count=$((jump_count + 1))
        ((jump_count == 1)) || return 1
        target=${RULE_TOKENS[$((index + 1))]}
        valid_chain_name "$target" || return 1
        index=$((index + 2))
        ;;
      *) index=$((index + 1)) ;;
    esac
  done
  ((jump_count == 1)) || return 1
  case "$target" in ACCEPT|DROP|REJECT|RETURN|LOG|NFLOG) return 0 ;; esac
  key="$family:$target"
  [[ -n ${FILTER_CHAIN_POLICY["$key"]+x} && ${FILTER_CHAIN_POLICY["$key"]} = - ]]
}

decode_filter_rule() {
  local family=$1 line=$2 i=2 count token value module
  local protocol_seen=0 source_seen=0 destination_seen=0 input_seen=0 output_seen=0
  local dport_seen=0 sport_seen=0 state_seen=0 dst_type_seen=0 target_seen=0
  local -a tokens=()
  lex_filter_rule "$line" || return 1
  tokens=("${RULE_TOKENS[@]}")
  count=${#tokens[@]}
  ((count >= 4)) || return 1
  [[ ${tokens[0]} = -A ]] || return 1
  valid_chain_name "${tokens[1]}" || return 1
  RULE_CHAIN=${tokens[1]}
  RULE_PROTOCOL=
  RULE_SOURCE=
  RULE_DESTINATION=
  RULE_INPUT_INTERFACE=
  RULE_OUTPUT_INTERFACE=
  RULE_DPORT=
  RULE_DPORT_KIND=
  RULE_SPORT=
  RULE_STATE=
  RULE_DST_TYPE=
  RULE_TARGET=
  RULE_UNSUPPORTED=0
  RULE_MAYBE=0
  RULE_NEGATED=0
  while ((i < count)); do
    token=${tokens[$i]}
    case "$token" in
      '!') RULE_UNSUPPORTED=1; RULE_NEGATED=1; i=$((i + 1)) ;;
      -p|--protocol)
        ((protocol_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}
        [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
        RULE_PROTOCOL=$value; protocol_seen=1; i=$((i + 2)) ;;
      -s|--source)
        ((source_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}
        if [[ "$family" = ipv4 ]]; then ipv4_cidr_range "$value" || return 1; else valid_ipv6_cidr "$value" || return 1; fi
        RULE_SOURCE=$value; source_seen=1; i=$((i + 2)) ;;
      -d|--destination)
        ((destination_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}
        if [[ "$family" = ipv4 ]]; then ipv4_cidr_range "$value" || return 1; else valid_ipv6_cidr "$value" || return 1; fi
        RULE_DESTINATION=$value; destination_seen=1; i=$((i + 2)) ;;
      -i|--in-interface)
        ((input_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}; valid_interface_name "$value" || return 1
        RULE_INPUT_INTERFACE=$value; input_seen=1; i=$((i + 2)) ;;
      -o|--out-interface)
        ((output_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}; valid_interface_name "$value" || return 1
        RULE_OUTPUT_INTERFACE=$value; output_seen=1; i=$((i + 2)) ;;
      -m|--match)
        ((i + 1 < count)) || return 1
        module=${tokens[$((i + 1))]}
        case "$module" in
          tcp|udp|conntrack|state|comment|addrtype|multiport|icmp|icmp6|ipv6-icmp) ;;
          limit|recent|set|pkttype|rt|hl) RULE_MAYBE=1 ;;
          *) return 1 ;;
        esac
        i=$((i + 2)) ;;
      --dport|--destination-port|--dports)
        ((dport_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}; valid_port_spec "$value" || return 1
        RULE_DPORT=$value
        if [[ "$token" = --dports ]]; then RULE_DPORT_KIND=multi; else RULE_DPORT_KIND=single; fi
        dport_seen=1; i=$((i + 2)) ;;
      --sport|--source-port|--sports)
        ((sport_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}; valid_port_spec "$value" || return 1
        RULE_SPORT=$value; sport_seen=1; i=$((i + 2)) ;;
      --ctstate|--state)
        ((state_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}; state_spec_valid "$value" || return 1
        RULE_STATE=$value; state_seen=1; i=$((i + 2)) ;;
      --dst-type)
        ((dst_type_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}
        case "$value" in LOCAL|UNICAST|MULTICAST|BROADCAST) ;; *) return 1 ;; esac
        RULE_DST_TYPE=$value; dst_type_seen=1; i=$((i + 2)) ;;
      -j|--jump)
        ((target_seen == 0 && i + 1 < count)) || return 1
        value=${tokens[$((i + 1))]}; valid_chain_name "$value" || return 1
        RULE_TARGET=$value; target_seen=1; i=$((i + 2)) ;;
      -g|--goto) return 1 ;;
      --comment|--log-prefix)
        ((i + 1 < count)) || return 1
        i=$((i + 2)) ;;
      --limit|--limit-burst|--log-level|--icmp-type|--icmpv6-type|--reject-with|--pkt-type|--seconds|--hitcount|--mask|--name|--side|--rt-type|--hl-eq)
        ((i + 1 < count)) || return 1
        case "$token" in --reject-with) ;; *) RULE_MAYBE=1 ;; esac
        i=$((i + 2)) ;;
      --match-set|--tcp-flags)
        ((i + 2 < count)) || return 1
        RULE_MAYBE=1; i=$((i + 3)) ;;
      --syn|--log-tcp-options|--log-ip-options|--log-uid|--set|--rcheck|--update|--remove|-f|--fragment)
        RULE_MAYBE=1; i=$((i + 1)) ;;
      *) return 1 ;;
    esac
  done
  ((target_seen == 1))
}

source_match_relation() {
  local family=$1 packet=$2 source=$3 first last trusted_first=$((0xc0a80300)) trusted_last=$((0xc0a803ff))
  if [[ -z "$source" ]]; then SOURCE_RELATION=1; return 0; fi
  if [[ "$family" = ipv6 ]]; then
    valid_ipv6_cidr "$source" || return 1
    if [[ "$source" = ::/0 ]]; then SOURCE_RELATION=1; else SOURCE_RELATION=2; fi
    return 0
  fi
  ipv4_cidr_range "$source" || return 1
  first=$CIDR_FIRST; last=$CIDR_LAST
  if [[ "$packet" = trusted ]]; then
    if ((first <= trusted_first && last >= trusted_last)); then SOURCE_RELATION=1
    elif ((last < trusted_first || first > trusted_last)); then SOURCE_RELATION=0
    else SOURCE_RELATION=2
    fi
  else
    if ((first == 0 && last == 0xffffffff)); then SOURCE_RELATION=1
    elif ((first >= trusted_first && last <= trusted_last)); then SOURCE_RELATION=0
    else SOURCE_RELATION=2
    fi
  fi
}

rule_match_relation() {
  local family=$1 packet=$2 expected_interface=$3 packet_state=$4 relation=1 some=0 unsupported=0 condition
  if ((RULE_NEGATED == 1)); then RULE_RELATION=3; return 0; fi
  case "$RULE_PROTOCOL" in ''|all|tcp) ;; *) relation=0 ;; esac
  if [[ -n "$RULE_DPORT" ]]; then
    if port_spec_includes_8080 "$RULE_DPORT"; then :; else relation=0; fi
  fi
  if [[ -n "$RULE_STATE" && ",$RULE_STATE," != *",$packet_state,"* ]]; then relation=0; fi
  if [[ -n "$RULE_DST_TYPE" && "$RULE_DST_TYPE" != LOCAL ]]; then relation=0; fi
  if [[ "$RULE_INPUT_INTERFACE" = lo ]]; then
    relation=0
  elif [[ -n "$RULE_INPUT_INTERFACE" ]]; then
    if [[ "$packet" = trusted && -n "$expected_interface" ]]; then
      if [[ "$RULE_INPUT_INTERFACE" = *+ ]]; then
        [[ "$expected_interface" = "${RULE_INPUT_INTERFACE%+}"* ]] || relation=0
      else
        [[ "$RULE_INPUT_INTERFACE" = "$expected_interface" ]] || relation=0
      fi
    else
      some=1
    fi
  fi
  source_match_relation "$family" "$packet" "$RULE_SOURCE" || return 1
  condition=$SOURCE_RELATION
  if ((condition == 0)); then relation=0; elif ((condition == 2)); then some=1; fi
  if [[ -n "$RULE_DESTINATION" ]]; then
    if [[ "$family" = ipv4 && "$RULE_DESTINATION" = 0.0.0.0/0 ]] || [[ "$family" = ipv6 && "$RULE_DESTINATION" = ::/0 ]]; then
      :
    else
      some=1
    fi
  fi
  if [[ -n "$RULE_SPORT" && "$RULE_SPORT" != 0:65535 ]]; then some=1; fi
  [[ -z "$RULE_OUTPUT_INTERFACE" ]] || unsupported=1
  ((RULE_UNSUPPORTED == 0)) || unsupported=1
  ((RULE_MAYBE == 0)) || some=1
  if ((relation == 0)); then RULE_RELATION=0
  elif ((unsupported == 1)); then RULE_RELATION=3
  elif ((some == 1)); then RULE_RELATION=2
  else RULE_RELATION=1
  fi
}

rule_is_exact_trusted_accept() {
  local expected_interface=$1 packet_state=$2
  [[ "$RULE_TARGET" = ACCEPT && "$RULE_PROTOCOL" = tcp && "$RULE_SOURCE" = 192.168.3.0/24 \
    && ( -z "$RULE_DESTINATION" || "$RULE_DESTINATION" = 0.0.0.0/0 ) \
    && "$RULE_DPORT_KIND" = single && "$RULE_DPORT" = 8080 && -z "$RULE_SPORT" \
    && -z "$RULE_DST_TYPE" \
    && -z "$RULE_OUTPUT_INTERFACE" && $RULE_UNSUPPORTED -eq 0 && $RULE_MAYBE -eq 0 ]] || return 1
  if [[ "$packet_state" = NEW ]]; then
    [[ -z "$RULE_STATE" || "$RULE_STATE" = NEW ]] || return 1
  else
    [[ -z "$RULE_STATE" ]] || return 1
  fi
  if [[ -n "$expected_interface" ]]; then
    [[ "$RULE_INPUT_INTERFACE" = "$expected_interface" ]]
  else
    [[ -z "$RULE_INPUT_INTERFACE" ]]
  fi
}

filter_target_kind() {
  local family=$1 target=$2 key
  key="$family:$target"
  case "$target" in
    ACCEPT|DROP|REJECT|RETURN|LOG|NFLOG) TARGET_KIND=$target ;;
    *)
      [[ -n ${FILTER_CHAIN_POLICY["$key"]+x} && ${FILTER_CHAIN_POLICY["$key"]} = - ]] || return 1
      TARGET_KIND=CHAIN ;;
  esac
}

analyze_filter_packet() {
  local family=$1 packet=$2 expected_interface=$3 packet_state=$4 require_accept=$5 state chain index stack key count line target_kind
  local frame rest resume_chain resume_index new_stack seen_safe=0 steps=0 queue_index=0
  local -a queue=("INPUT|1|")
  declare -A seen_states=()
  while ((queue_index < ${#queue[@]})); do
    ((${#queue[@]} <= 10000)) || return 1
    state=${queue[$queue_index]}
    queue_index=$((queue_index + 1))
    [[ -z ${seen_states["$state"]+x} ]] || continue
    seen_states["$state"]=1
    steps=$((steps + 1))
    ((steps <= 10000)) || return 1
    IFS='|' read -r chain index stack <<< "$state"
    key="$family:$chain"
    count=${FILTER_RULE_COUNT["$key"]-}
    [[ "$count" =~ ^[0-9]+$ ]] || return 1
    if ((index > count)); then
      if [[ -z "$stack" ]]; then
        ((require_accept == 0)) || return 1
        continue
      fi
      if [[ "$stack" = *';'* ]]; then frame=${stack##*;}; rest=${stack%;*}; else frame=$stack; rest=; fi
      resume_chain=${frame%%,*}; resume_index=${frame#*,}
      queue+=("$resume_chain|$resume_index|$rest")
      continue
    fi
    line=${FILTER_RULE["$key:$index"]-}
    [[ -n "$line" ]] || return 1
    decode_filter_rule "$family" "$line" || return 1
    [[ "$RULE_CHAIN" = "$chain" ]] || return 1
    filter_target_kind "$family" "$RULE_TARGET" || return 1
    target_kind=$TARGET_KIND
    if [[ "$target_kind" = LOG || "$target_kind" = NFLOG ]]; then
      queue+=("$chain|$((index + 1))|$stack")
      continue
    fi
    rule_match_relation "$family" "$packet" "$expected_interface" "$packet_state" || return 1
    if ((RULE_RELATION == 0)); then
      queue+=("$chain|$((index + 1))|$stack")
      continue
    fi
    ((RULE_RELATION != 3)) || return 1
    if ((RULE_RELATION == 2)); then queue+=("$chain|$((index + 1))|$stack"); fi
    case "$target_kind" in
      ACCEPT)
        if [[ "$packet" = trusted ]]; then
          rule_is_exact_trusted_accept "$expected_interface" "$packet_state" || return 1
          seen_safe=$((seen_safe + 1))
        else
          return 1
        fi
        ;;
      DROP|REJECT)
        ((require_accept == 0)) || return 1
        ;;
      RETURN)
        if [[ -z "$stack" ]]; then
          ((require_accept == 0)) || return 1
        else
          if [[ "$stack" = *';'* ]]; then frame=${stack##*;}; rest=${stack%;*}; else frame=$stack; rest=; fi
          resume_chain=${frame%%,*}; resume_index=${frame#*,}
          queue+=("$resume_chain|$resume_index|$rest")
        fi
        ;;
      CHAIN)
        if [[ "$RULE_TARGET" = "$chain" || ";$stack;" = *";$RULE_TARGET,"* ]]; then return 1; fi
        new_stack=$stack
        [[ -z "$new_stack" ]] || new_stack+=';'
        new_stack+="$chain,$((index + 1))"
        frame=${new_stack//[^;]/}
        ((${#frame} + 1 <= 64)) || return 1
        queue+=("$RULE_TARGET|1|$new_stack")
        ;;
      *) return 1 ;;
    esac
  done
  if ((require_accept == 1)); then ((seen_safe == 1)); else ((seen_safe <= 1)); fi
}

check_firewall() {
  local deadline=$1
  local output ipv4_filter ipv6_filter line port_spec active=0 default_deny=0 safe=0 unsafe=0 trusted_interface=
  local trusted_no_interface='^8080(/tcp)?[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+192\.168\.3\.0/24([[:space:]]+#.*|[[:space:]]*)$'
  local trusted_on_interface='^8080(/tcp)?[[:space:]]+on[[:space:]]+([A-Za-z0-9_][A-Za-z0-9_.:+-]*)[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+192\.168\.3\.0/24([[:space:]]+#.*|[[:space:]]*)$'
  FILTER_CHAIN_POLICY=()
  FILTER_RULE_COUNT=()
  FILTER_RULE=()
  FILTER_RULE_SEEN=()
  output=$(run_command_before_deadline "$deadline" "$UFW" status verbose) || fail trusted_lan_boundary_not_proven
  while IFS= read -r line; do
    [[ "$line" = 'Status: active' ]] && active=$((active + 1))
    if [[ "$line" =~ ^Default:[[:space:]]+deny[[:space:]]+\(incoming\),.*(deny|disabled)[[:space:]]+\(routed\) ]]; then
      default_deny=$((default_deny + 1))
    fi
    read -r port_spec _ <<< "$line"
    if port_spec_includes_8080 "$port_spec"; then
      if [[ "$line" =~ $trusted_on_interface && $unsafe -eq 0 ]]; then
        safe=$((safe + 1)); trusted_interface=${BASH_REMATCH[2]}
      elif [[ "$line" =~ $trusted_no_interface && $unsafe -eq 0 ]]; then
        safe=$((safe + 1)); trusted_interface=
      elif [[ "$line" == *'ALLOW IN'* || "$line" == *'LIMIT IN'* || ( $safe -eq 0 && ( "$line" == *'DENY IN'* || "$line" == *'REJECT IN'* ) ) ]]; then
        unsafe=1
      fi
    fi
  done <<< "$output"
  ((active == 1 && default_deny == 1 && safe == 1 && unsafe == 0)) || fail trusted_lan_boundary_not_proven

  ipv4_filter=$(run_command_before_deadline "$deadline" "$IPTABLES_SAVE" -t filter) || fail trusted_lan_boundary_not_proven
  ipv6_filter=$(run_command_before_deadline "$deadline" "$IP6TABLES_SAVE" -t filter) || fail trusted_lan_boundary_not_proven
  parse_filter_save ipv4 "$ipv4_filter" || fail trusted_lan_boundary_not_proven
  parse_filter_save ipv6 "$ipv6_filter" || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv4 trusted "$trusted_interface" NEW 1 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv4 trusted "$trusted_interface" UNTRACKED 0 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv4 untrusted "$trusted_interface" NEW 0 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv4 untrusted "$trusted_interface" UNTRACKED 0 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv6 ipv6 '' NEW 0 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv6 ipv6 '' UNTRACKED 0 || fail trusted_lan_boundary_not_proven
}

delete_verified_staging() {
  local path=$1 deadline=$2 line digest relative directory manifest_contents directory_listing
  local -a files=() directories=()
  declare -A directory_set=()
  [[ -d "$path" && ! -L "$path" && "$path" = "$RELEASES"/.installing-"$RELEASE_ID"-* ]] || return 1
  [[ -f "$path/release.manifest" && ! -L "$path/release.manifest" ]] || return 1
  [[ $(sha256_before_deadline "$deadline" "$path/release.manifest") = "$RELEASE_ID" ]] || return 1
  manifest_contents=$(run_command_before_deadline "$deadline" cat -- "$path/release.manifest") || return 1
  ((${#manifest_contents} <= 1048576)) || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    ((SECONDS < deadline)) || return 1
    [[ "$line" =~ ^([0-9a-f]{64})[[:space:]][[:space:]]([A-Za-z0-9][A-Za-z0-9._/-]*)$ ]] || return 1
    digest=${BASH_REMATCH[1]}
    relative=${BASH_REMATCH[2]}
    [[ -f "$path/$relative" && ! -L "$path/$relative" ]] || return 1
    [[ $(sha256_before_deadline "$deadline" "$path/$relative") = "$digest" ]] || return 1
    files+=("$relative")
    if [[ "$relative" = */* ]]; then directory=${relative%/*}; else directory=.; fi
    while [[ "$directory" != . ]]; do
      ((SECONDS < deadline)) || return 1
      directory_set["$directory"]=1
      if [[ "$directory" = */* ]]; then directory=${directory%/*}; else directory=.; fi
    done
  done <<< "$manifest_contents"
  if ((FIXTURE)); then
    run_command_before_deadline "$deadline" chmod u+w -- "$path" || return 1
    for directory in "${!directory_set[@]}"; do
      run_command_before_deadline "$deadline" chmod u+w -- "$path/$directory" || return 1
    done
  fi
  for relative in "${files[@]}"; do
    run_command_before_deadline "$deadline" unlink -- "$path/$relative" || return 1
  done
  run_command_before_deadline "$deadline" unlink -- "$path/release.manifest" || return 1
  directory_listing=$(run_command_before_deadline "$deadline" \
    find -P "$path" -mindepth 1 -depth -type d -printf '%P\n') || return 1
  mapfile -t directories <<< "$directory_listing"
  for directory in "${directories[@]}"; do
    [[ -n "$directory" && -n ${directory_set["$directory"]+x} ]] || return 1
    run_command_before_deadline "$deadline" rmdir -- "$path/$directory" || return 1
  done
  run_command_before_deadline "$deadline" rmdir -- "$path" || return 1
}

prove_canary_quiesced() {
  local unit_name=$1 port=$2 child_port=$3 deadline=$4 cgroup_file listener child_listener
  local remaining inspection_timeout
  if ((FIXTURE)); then
    cgroup_file="$GWM_FAKE_STATE/canary-cgroup-pids"
  else
    cgroup_file="/sys/fs/cgroup/system.slice/$unit_name.service/cgroup.procs"
  fi
  while ((SECONDS < deadline)); do
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    inspection_timeout=$remaining
    ((inspection_timeout <= 10)) || inspection_timeout=10
    if cgroup_procs_empty "$deadline" "$cgroup_file" \
      && listener=$("$TIMEOUT" --signal=KILL "$inspection_timeout"s "$SS" -H -ltnp "sport = :$port" 2>/dev/null) \
      && child_listener=$("$TIMEOUT" --signal=KILL "$inspection_timeout"s "$SS" -H -ltnp "sport = :$child_port" 2>/dev/null) \
      && [[ -z "$listener" && -z "$child_listener" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

prove_canary_systemd_terminal() {
  local unit_name=$1 deadline=$2 output key value load active sub pid control_group job
  local load_seen active_seen sub_seen pid_seen control_group_seen job_seen attempt=0 max_attempts=0
  ((FIXTURE == 0)) || max_attempts=8
  while ((SECONDS < deadline)); do
    ((attempt += 1))
    ((max_attempts == 0 || attempt <= max_attempts)) || break
    load= active= sub= pid= control_group= job=
    load_seen=0 active_seen=0 sub_seen=0 pid_seen=0 control_group_seen=0 job_seen=0
    output=$(run_systemctl_before_deadline "$deadline" show "$unit_name.service" \
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
        '') ;;
        *) load_seen=2 ;;
      esac
    done <<< "$output"
    if ((load_seen == 1 && active_seen == 1 && sub_seen == 1 && pid_seen == 1 && control_group_seen == 1 && job_seen == 1)) \
      && [[ ( "$load" = loaded || "$load" = not-found ) \
        && ( "$active" = inactive || "$active" = failed ) \
        && ( "$sub" = dead || "$sub" = failed ) && "$pid" = 0 && -z "$job" \
        && ( -z "$control_group" || "$control_group" = "/system.slice/$unit_name.service" ) ]]; then
      return 0
    fi
    ((FIXTURE)) || sleep 1
  done
  return 1
}

run_canary() {
  local kind=$1 port=$2 child_port=$3 limit=120s watchdog=150s
  local unit_name cleanup_deadline status
  if [[ "$kind" = real ]]; then limit=1800s; watchdog=1830s; fi
  if ((FIXTURE)); then
    if env \
      QWEN38_CANARY_KIND="$kind" \
      QWEN38_CANARY_MODE=full \
      QWEN38_CANARY_HOST=127.0.0.1 \
      QWEN38_CANARY_PORT="$port" \
      QWEN38_CANARY_CHILD_PORT="$child_port" \
      QWEN38_RELEASE_DIR="$STAGING" \
      QWEN38_MANAGER_CONFIG="$STAGED_MANAGER_CONFIG" \
      QWEN38_MODELS_CONFIG="$STAGED_MODELS_CONFIG" \
      CREDENTIALS_DIRECTORY="$CREDENTIAL_DIRECTORY" \
      "$TIMEOUT" --signal=TERM --kill-after=15s "$limit" "$STAGING/canary/$kind-canary" >/dev/null 2>&1; then
      return 0
    else
      status=$?
    fi
    if [[ "$kind" = real && -e "$GWM_FAKE_STATE/residual-real-canary" ]]; then
      ROLLBACK_BLOCKED_REASON=canary_quiescence_unproven
    elif [[ "$kind" = real && -e "$GWM_FAKE_STATE/exercise-canary-quiescence" ]]; then
      cleanup_deadline=$((SECONDS + CANARY_CLEANUP_TIMEOUT_SECONDS))
      if ! prove_canary_quiesced "qwen38-workload-manager-canary-$kind-$$" \
        "$port" "$child_port" "$cleanup_deadline"; then
        ROLLBACK_BLOCKED_REASON=canary_quiescence_unproven
      fi
    fi
    return "$status"
  fi

  local -a command=(
    "$SYSTEMD_RUN" --quiet --wait --collect
    "--unit=qwen38-workload-manager-canary-$kind-$$"
    --property=Type=exec
    --property=User=agentops
    --property=Group=agentops
    '--property=SupplementaryGroups=aiops video render'
    --property=NoNewPrivileges=yes
    --property=PrivateTmp=yes
    --property=ProtectSystem=strict
    --property=ProtectHome=read-only
    --property=ProtectKernelTunables=yes
    --property=ProtectKernelModules=yes
    --property=ProtectKernelLogs=yes
    --property=ProtectControlGroups=yes
    --property=ProtectHostname=yes
    --property=ProtectClock=yes
    --property=ProtectProc=invisible
    --property=ProcSubset=pid
    --property=RestrictSUIDSGID=yes
    --property=RestrictNamespaces=yes
    --property=RestrictRealtime=yes
    --property=LockPersonality=yes
    --property=RemoveIPC=yes
    --property=KeyringMode=private
    --property=CapabilityBoundingSet=
    --property=AmbientCapabilities=
    --property=KillMode=control-group
    --property=UMask=0077
    '--property=RestrictAddressFamilies=AF_UNIX AF_INET'
    --property=IPAddressDeny=any
    --property=IPAddressAllow=localhost
    --property=DevicePolicy=closed
    --property=StandardInput=null
    --property=StandardOutput=null
    --property=StandardError=null
    --property=TimeoutStopSec=15s
    "--property=RuntimeMaxSec=$limit"
    "--property=WorkingDirectory=$STAGING"
    "--property=ReadOnlyPaths=$STAGING"
    "--property=LoadCredential=inference.key:$INFERENCE_CREDENTIAL"
    "--property=LoadCredential=management.key:$MANAGEMENT_CREDENTIAL"
    "--setenv=QWEN38_CANARY_KIND=$kind"
    --setenv=QWEN38_CANARY_MODE=full
    --setenv=QWEN38_CANARY_HOST=127.0.0.1
    "--setenv=QWEN38_CANARY_PORT=$port"
    "--setenv=QWEN38_CANARY_CHILD_PORT=$child_port"
    "--setenv=QWEN38_RELEASE_DIR=$STAGING"
    "--setenv=QWEN38_MANAGER_CONFIG=$STAGED_MANAGER_CONFIG"
    "--setenv=QWEN38_MODELS_CONFIG=$STAGED_MODELS_CONFIG"
  )
  if [[ "$kind" = real ]]; then
    command+=(--property='DeviceAllow=/dev/dri/card1 rw' --property='DeviceAllow=/dev/dri/renderD128 rw')
  fi
  command+=(-- "$STAGING/canary/$kind-canary")
  if "$TIMEOUT" --signal=TERM --kill-after=15s "$watchdog" "${command[@]}"; then
    return 0
  else
    status=$?
  fi
  if [[ "$kind" = real ]]; then
    unit_name="qwen38-workload-manager-canary-$kind-$$"
    cleanup_deadline=$((SECONDS + CANARY_CLEANUP_TIMEOUT_SECONDS))
    if ! run_systemctl_before_deadline "$cleanup_deadline" stop "$unit_name.service"; then
      if ! prove_canary_systemd_terminal "$unit_name" "$cleanup_deadline"; then
        ROLLBACK_BLOCKED_REASON=canary_quiescence_unproven
        return 1
      fi
    fi
    if ! prove_canary_quiesced "$unit_name" "$port" "$child_port" "$cleanup_deadline"; then
      ROLLBACK_BLOCKED_REASON=canary_quiescence_unproven
      return 1
    fi
  fi
  return "$status"
}

run_artifact_gate() {
  local limit="$ARTIFACT_GATE_TIMEOUT_SECONDS"s
  if ((FIXTURE)); then
    env -u QWEN38_CANARY_HOST -u QWEN38_CANARY_PORT -u QWEN38_CANARY_CHILD_PORT -u CREDENTIALS_DIRECTORY \
      QWEN38_CANARY_KIND=real \
      QWEN38_CANARY_MODE=artifact-only \
      QWEN38_RELEASE_DIR="$STAGING" \
      QWEN38_MANAGER_CONFIG="$STAGED_MANAGER_CONFIG" \
      QWEN38_MODELS_CONFIG="$STAGED_MODELS_CONFIG" \
      "$TIMEOUT" --signal=TERM --kill-after=15s "$limit" "$STAGING/canary/real-canary" >/dev/null 2>&1
    return
  fi

  "$SYSTEMD_RUN" --quiet --wait --collect "--unit=qwen38-workload-manager-artifact-gate-$$" \
    --property=Type=exec --property=User=agentops --property=Group=agentops --property=SupplementaryGroups=aiops \
    --property=NoNewPrivileges=yes --property=PrivateTmp=yes --property=ProtectSystem=strict --property=ProtectHome=read-only \
    --property=ProtectKernelTunables=yes --property=ProtectKernelModules=yes --property=ProtectKernelLogs=yes \
    --property=ProtectControlGroups=yes --property=ProtectHostname=yes --property=ProtectClock=yes \
    --property=ProtectProc=invisible --property=ProcSubset=pid --property=RestrictSUIDSGID=yes \
    --property=RestrictNamespaces=yes --property=RestrictRealtime=yes --property=LockPersonality=yes \
    --property=RemoveIPC=yes --property=KeyringMode=private --property=CapabilityBoundingSet= --property=AmbientCapabilities= \
    --property=KillMode=control-group --property=UMask=0077 --property=RestrictAddressFamilies=AF_UNIX \
    --property=IPAddressDeny=any --property=DevicePolicy=closed --property=StandardInput=null \
    --property=StandardOutput=null --property=StandardError=null --property=TimeoutStopSec=15s \
    "--property=RuntimeMaxSec=$limit" "--property=WorkingDirectory=$STAGING" "--property=ReadOnlyPaths=$STAGING" \
    --property='UnsetEnvironment=QWEN38_CANARY_HOST QWEN38_CANARY_PORT QWEN38_CANARY_CHILD_PORT CREDENTIALS_DIRECTORY' \
    --setenv=QWEN38_CANARY_KIND=real --setenv=QWEN38_CANARY_MODE=artifact-only \
    "--setenv=QWEN38_RELEASE_DIR=$STAGING" "--setenv=QWEN38_MANAGER_CONFIG=$STAGED_MANAGER_CONFIG" \
    "--setenv=QWEN38_MODELS_CONFIG=$STAGED_MODELS_CONFIG" -- "$STAGING/canary/real-canary"
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
  ((command_timeout <= ARTIFACT_REVALIDATION_COMMAND_TIMEOUT_SECONDS)) || \
    command_timeout=$ARTIFACT_REVALIDATION_COMMAND_TIMEOUT_SECONDS
  "$TIMEOUT" --signal=KILL "$command_timeout"s "$@"
}

sha256_before_deadline() {
  local deadline=$1 path=$2 output digest
  output=$(run_command_before_deadline "$deadline" sha256sum -- "$path") || return 1
  digest=${output%% *}
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$digest"
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

old_unit_file_state_is_before_deadline() {
  local deadline=$1 expected=$2 output
  output=$(run_old_systemctl_before_deadline "$deadline" show qwen38.service \
    --property=UnitFileState --value 2>/dev/null) || return 1
  [[ "$output" = "$expected" ]]
}

update_snapshot_stage() {
  local expected=$1 next=$2 deadline=$3 field payload matches=0 metadata
  metadata=$(run_command_before_deadline "$deadline" stat -c '%a:%u:%h' -- "$SNAPSHOT") || \
    fail invalid_snapshot_during_stage_update
  [[ -f "$SNAPSHOT" && ! -L "$SNAPSHOT" && "$metadata" = "600:$ADMIN_UID:1" ]] || \
    fail invalid_snapshot_during_stage_update
  SNAPSHOT_TEMP="$SNAPSHOT.stage-$$"
  : > "$SNAPSHOT_TEMP"
  while IFS='=' read -r field payload || [[ -n "$field$payload" ]]; do
    if [[ "$field" = new_service_stage ]]; then
      ((matches += 1))
      [[ "$payload" = "$expected" ]] || fail invalid_snapshot_stage_transition
      printf 'new_service_stage=%s\n' "$next" >> "$SNAPSHOT_TEMP"
    else
      printf '%s=%s\n' "$field" "$payload" >> "$SNAPSHOT_TEMP"
    fi
  done < "$SNAPSHOT"
  ((matches == 1)) || fail invalid_snapshot_stage_transition
  run_command_before_deadline "$deadline" chmod 0600 -- "$SNAPSHOT_TEMP" || fail invalid_snapshot_during_stage_update
  run_command_before_deadline "$deadline" mv -T -- "$SNAPSHOT_TEMP" "$SNAPSHOT" || fail invalid_snapshot_during_stage_update
  SNAPSHOT_TEMP=
}

verify_new_service() {
  local output key value load= active= sub= result= nrestarts= pid= control_group= job= listener child health attempt=0 max_attempts=0
  local cgroup_file cgroup_pid cgroup_count cgroup_main cgroup_ready cgroup_output
  local systemctl_ok listener_ok child_ok
  local load_seen active_seen sub_seen result_seen nrestarts_seen pid_seen control_group_seen job_seen
  local -a cgroup_pids=()
  local deadline=$1
  local remaining inspection_timeout request_timeout acceptance_timeout
  ((FIXTURE == 0)) || max_attempts=64
  while ((SECONDS < deadline)); do
    ((attempt += 1))
    ((max_attempts == 0 || attempt <= max_attempts)) || break
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    inspection_timeout=$remaining
    ((inspection_timeout <= 10)) || inspection_timeout=10
    load=
    active=
    sub=
    result=
    nrestarts=
    pid=
    control_group=
    job=
    load_seen=0
    active_seen=0
    sub_seen=0
    result_seen=0
    nrestarts_seen=0
    pid_seen=0
    control_group_seen=0
    job_seen=0
    systemctl_ok=0
    if output=$("$TIMEOUT" --signal=KILL "$inspection_timeout"s \
      "$SYSTEMCTL" show qwen38-workload-manager.service \
      --property=LoadState --property=ActiveState --property=SubState --property=Result \
      --property=NRestarts --property=MainPID --property=ControlGroup --property=Job 2>/dev/null); then
      systemctl_ok=1
    else
      output=
    fi
    while IFS='=' read -r key value; do
      case "$key" in
        LoadState) load_seen=$((load_seen + 1)); load=$value ;;
        ActiveState) active_seen=$((active_seen + 1)); active=$value ;;
        SubState) sub_seen=$((sub_seen + 1)); sub=$value ;;
        Result) result_seen=$((result_seen + 1)); result=$value ;;
        NRestarts) nrestarts_seen=$((nrestarts_seen + 1)); nrestarts=$value ;;
        MainPID) pid_seen=$((pid_seen + 1)); pid=$value ;;
        ControlGroup) control_group_seen=$((control_group_seen + 1)); control_group=$value ;;
        Job) job_seen=$((job_seen + 1)); job=$value ;;
        '') ;;
        *) systemctl_ok=0 ;;
      esac
    done <<< "$output"
    if ((systemctl_ok == 1)); then
      if ((load_seen != 1 || active_seen != 1 || sub_seen != 1 || result_seen != 1 \
        || nrestarts_seen != 1 || pid_seen != 1 || control_group_seen != 1 || job_seen != 1)); then
        return 1
      fi
    fi
    if ((systemctl_ok == 1)); then
      [[ "$load" = loaded ]] || return 1
      [[ -z "$job" ]] || return 1
      [[ "$result" = success && "$nrestarts" =~ ^[0-9]+$ && "$nrestarts" = 0 ]] || return 1
      case "$active:$sub" in
        active:running|activating:start|activating:start-pre|activating:start-post) ;;
        *) return 1 ;;
      esac
      [[ "$control_group" = /system.slice/qwen38-workload-manager.service ]] || return 1
      if [[ "$active" = active ]]; then
        [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
      else
        [[ "$pid" =~ ^[0-9]+$ ]] || return 1
      fi
    fi
    listener_ok=0
    child_ok=0
    health=0
    listener=
    child=
    if ((systemctl_ok == 1)) \
      && [[ "$load" = loaded && "$active" = active && "$pid" =~ ^[1-9][0-9]*$ \
        && "$control_group" = /system.slice/qwen38-workload-manager.service ]]; then
      remaining=$((deadline - SECONDS))
      if ((remaining > 0)); then
        inspection_timeout=$remaining
        ((inspection_timeout <= 10)) || inspection_timeout=10
        if listener=$("$TIMEOUT" --signal=KILL "$inspection_timeout"s \
          "$SS" -H -ltnp 'sport = :8080' 2>/dev/null); then
          listener_ok=1
        else
          listener=
        fi
      fi
      remaining=$((deadline - SECONDS))
      if ((remaining > 0)); then
        inspection_timeout=$remaining
        ((inspection_timeout <= 10)) || inspection_timeout=10
        if child=$("$TIMEOUT" --signal=KILL "$inspection_timeout"s \
          "$SS" -H -ltnp 'sport = :18080' 2>/dev/null); then
          child_ok=1
        else
          child=
        fi
      fi
      remaining=$((deadline - SECONDS))
      if ((remaining > 0)); then
        request_timeout=$remaining
        ((request_timeout <= 5)) || request_timeout=5
        "$TIMEOUT" --signal=KILL "$request_timeout"s \
          "$CURL" --fail --silent --show-error --max-time "$request_timeout" \
          http://127.0.0.1:8080/health >/dev/null 2>&1 && health=1
      fi
    fi
    cgroup_ready=0
    cgroup_count=0
    cgroup_main=0
    if ((systemctl_ok == 1)) \
      && [[ "$load" = loaded && "$active" = active && "$pid" =~ ^[1-9][0-9]*$ \
        && "$control_group" = /system.slice/qwen38-workload-manager.service ]]; then
      if ((FIXTURE)); then cgroup_file="$GWM_FAKE_STATE/new-cgroup-pids"; else cgroup_file="/sys/fs/cgroup$control_group/cgroup.procs"; fi
      if [[ -e "$cgroup_file" && ! -L "$cgroup_file" ]]; then
        cgroup_pids=()
        if cgroup_output=$(cgroup_procs_before_deadline "$deadline" "$cgroup_file"); then
          mapfile -t cgroup_pids <<< "$cgroup_output"
          for cgroup_pid in "${cgroup_pids[@]}"; do
            [[ -n "$cgroup_pid" ]] || continue
            ((cgroup_count += 1))
            [[ "$cgroup_pid" = "$pid" ]] && cgroup_main=1
          done
          ((cgroup_count == 1 && cgroup_main == 1)) && cgroup_ready=1
        fi
      fi
    fi
    if ((systemctl_ok == 1 && listener_ok == 1 && child_ok == 1)) \
      && [[ "$load" = loaded && "$active" = active && "$pid" =~ ^[1-9][0-9]*$ \
        && "$control_group" = /system.slice/qwen38-workload-manager.service ]] \
      && single_ipv4_listener_for_pid "$listener" "$pid" \
      && [[ -z "$child" && "$health" = 1 && "$cgroup_ready" = 1 ]]; then
      if ((FIXTURE)); then
        [[ ! -e "$GWM_FAKE_STATE/fail-new-readiness" && $(tr -d '\n' < "$GWM_FAKE_STATE/new-phase") = UNLOADED ]] || return 1
        return 0
      fi
      local verifier='const fs=require("node:fs");(async()=>{const p=process.env.CREDENTIALS_DIRECTORY+"/management.key";const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0)process.exit(1);const k=fs.readFileSync(p,"utf8").trim();const r=await fetch("http://127.0.0.1:8080/gpu/v1/status",{headers:{authorization:`Bearer ${k}`},signal:AbortSignal.timeout(5000)});if(r.status!==200)process.exit(1);const b=await r.json();if(b.phase!=="UNLOADED"||b.activeRequestCount!==0||b.activeModel!==undefined||b.activeOperation!==undefined)process.exit(1)})().catch(()=>process.exit(1))'
      remaining=$((deadline - SECONDS))
      ((remaining > 0)) || return 1
      acceptance_timeout=$remaining
      ((acceptance_timeout <= 15)) || acceptance_timeout=15
      "$TIMEOUT" --signal=KILL "$acceptance_timeout"s \
        "$SYSTEMD_RUN" --quiet --wait --collect "--unit=qwen38-workload-manager-acceptance-$$" \
        --property=Type=exec --property=User=agentops --property=Group=agentops \
        --property=NoNewPrivileges=yes --property=PrivateTmp=yes --property=ProtectSystem=strict --property=ProtectHome=read-only \
        '--property=RestrictAddressFamilies=AF_UNIX AF_INET' --property=IPAddressDeny=any --property=IPAddressAllow=localhost \
        --property=DevicePolicy=closed --property=CapabilityBoundingSet= --property=AmbientCapabilities= --property=UMask=0077 \
        --property=KillMode=control-group --property=StandardInput=null --property=StandardOutput=null --property=StandardError=null \
        "--property=RuntimeMaxSec=$acceptance_timeout"s \
        "--property=LoadCredential=management.key:$MANAGEMENT_CREDENTIAL" -- "$RELEASE_TARGET/node-v22/bin/node" -e "$verifier"
      return
    fi
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    ((FIXTURE)) || sleep 1
  done
  return 1
}

OLD_UNIT=$(target_path /home/agentops/.config/systemd/user/qwen38.service)
OLD_CONFIG=$(target_path /home/agentops/apps/qwen38/config/models.json)
MARKER=$(target_path /home/agentops/.config/ai-stack/qwen38-maintenance-window)
CREDENTIAL_DIRECTORY=$(target_path /etc/qwen38-workload-manager/credentials)
INFERENCE_CREDENTIAL="$CREDENTIAL_DIRECTORY/inference.key"
MANAGEMENT_CREDENTIAL="$CREDENTIAL_DIRECTORY/management.key"
NEW_CONFIG_DIRECTORY=$(target_path /etc/qwen38-workload-manager)
NEW_MANAGER_CONFIG="$NEW_CONFIG_DIRECTORY/manager.production.json"
NEW_MODELS_CONFIG="$NEW_CONFIG_DIRECTORY/models.production.json"
NEW_UNIT=$(target_path /etc/systemd/system/qwen38-workload-manager.service)
WORKLOAD_HOME=$(target_path /opt/qwen38-workload-manager)
RELEASES="$WORKLOAD_HOME/releases"
RELEASE_TARGET="$RELEASES/$RELEASE_ID"
CURRENT_LINK="$WORKLOAD_HOME/current"
MIGRATIONS=$(target_path /var/lib/qwen38-workload-manager-migrations)

ensure_admin_directory "$MIGRATIONS" 0700
validate_migration_ancestors "$MIGRATIONS"
MIGRATION_LOCK="$MIGRATIONS/install.lock"
[[ ! -L "$MIGRATION_LOCK" ]] || fail unsafe_migration_lock
if [[ ! -e "$MIGRATION_LOCK" ]]; then
  (set -o noclobber; : > "$MIGRATION_LOCK") 2>/dev/null || fail unsafe_migration_lock
  chmod 0600 -- "$MIGRATION_LOCK"
fi
[[ -f "$MIGRATION_LOCK" && ! -L "$MIGRATION_LOCK" ]] || fail unsafe_migration_lock
[[ $(stat -c '%a:%u:%h' -- "$MIGRATION_LOCK") = "600:$ADMIN_UID:1" ]] || fail unsafe_migration_lock
exec 9<>"$MIGRATION_LOCK"
"$FLOCK" -n 9 || fail concurrent_installation

ensure_admin_directory "$WORKLOAD_HOME" 0755
ensure_admin_directory "$RELEASES" 0755
validate_migration_ancestors "$WORKLOAD_HOME"
ensure_admin_directory "$NEW_CONFIG_DIRECTORY" 0755
[[ ! -e "$RELEASE_TARGET" && ! -L "$RELEASE_TARGET" ]] || fail release_already_installed

ROLLBACK_ARMED=0
ROLLBACK_BLOCKED_REASON=
STAGING=
STAGING_VALIDATED=0
CURRENT_TEMP=
SNAPSHOT=
SNAPSHOT_TEMP=
on_exit() {
  local status=$? failure_cleanup_deadline
  trap - EXIT
  if ((status != 0)); then
    # Once the old GPU owner has been stopped, service recovery always comes
    # before best-effort cleanup. Slow storage must never delay the rollback.
    if ((ROLLBACK_ARMED)); then
      if [[ -n "$ROLLBACK_BLOCKED_REASON" ]]; then
        printf 'install-ubuntu: automatic rollback BLOCKED reason=%s; old router remains stopped; manual intervention required snapshot=%s\n' \
          "$ROLLBACK_BLOCKED_REASON" "$SNAPSHOT" >&2
      else
        local rollback_arguments=(--snapshot "$SNAPSHOT" --apply --lock-held)
        [[ -z "$FIXTURE_ROOT" ]] || rollback_arguments+=(--fixture-root "$FIXTURE_ROOT")
        if "$ROLLBACK" "${rollback_arguments[@]}"; then
          printf 'install-ubuntu: automatic rollback completed\n' >&2
        else
          printf 'install-ubuntu: automatic rollback FAILED; manual intervention required snapshot=%s\n' "$SNAPSHOT" >&2
        fi
      fi
    fi
    failure_cleanup_deadline=$((SECONDS + FAILURE_CLEANUP_TIMEOUT_SECONDS))
    if [[ -n "$CURRENT_TEMP" && (-e "$CURRENT_TEMP" || -L "$CURRENT_TEMP") ]]; then
      run_command_before_deadline "$failure_cleanup_deadline" unlink -- "$CURRENT_TEMP" || true
    fi
    if [[ -n "$SNAPSHOT_TEMP" && -f "$SNAPSHOT_TEMP" && ! -L "$SNAPSHOT_TEMP" ]]; then
      run_command_before_deadline "$failure_cleanup_deadline" unlink -- "$SNAPSHOT_TEMP" || true
    fi
    if [[ -n "$STAGING" && -d "$STAGING" && -n "$ROLLBACK_BLOCKED_REASON" ]]; then
      printf 'install-ubuntu: retained staging because automatic rollback is unsafe path=%s reason=%s\n' \
        "$STAGING" "$ROLLBACK_BLOCKED_REASON" >&2
    elif [[ -n "$STAGING" && -d "$STAGING" ]]; then
      if ((STAGING_VALIDATED)); then
        delete_verified_staging "$STAGING" "$failure_cleanup_deadline" || \
          printf 'install-ubuntu: retained staging after failed exact cleanup path=%s\n' "$STAGING" >&2
      else
        printf 'install-ubuntu: retained unverified staging for manual inspection path=%s\n' "$STAGING" >&2
      fi
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

STAGING="$RELEASES/.installing-$RELEASE_ID-$$"
"$INSTALL" -d -m 0700 -o "$ADMIN_USER" -g "$ADMIN_GROUP" "$STAGING"
/usr/bin/cp -R --no-preserve=ownership,mode,timestamps,xattr -- "$RELEASE_DIR/." "$STAGING/"
while IFS= read -r -d '' COPIED_ENTRY; do
  [[ ! -L "$COPIED_ENTRY" && (-f "$COPIED_ENTRY" || -d "$COPIED_ENTRY") ]] || fail unsafe_copied_release_entry
done < <(find -P "$STAGING" -mindepth 1 -print0)
for EXECUTABLE in node-v22/bin/node canary/fake-canary canary/real-canary verify/preflight-ubuntu.sh; do
  [[ -f "$STAGING/$EXECUTABLE" && ! -L "$STAGING/$EXECUTABLE" ]] || fail unsafe_copied_release_entry
  chmod 0500 -- "$STAGING/$EXECUTABLE"
done
STAGED_PREFLIGHT_ARGUMENTS=(--release-dir "$STAGING" --release-id "$RELEASE_ID")
if [[ -n "$FIXTURE_ROOT" ]]; then STAGED_PREFLIGHT_ARGUMENTS+=(--fixture-root "$FIXTURE_ROOT"); fi
"$PREFLIGHT" "${STAGED_PREFLIGHT_ARGUMENTS[@]}"
STAGING_VALIDATED=1

chown -R -- "$ADMIN_USER:$TARGET_GROUP" "$STAGING"
find -P "$STAGING" -type d -exec chmod 0550 -- {} +
find -P "$STAGING" -type f -exec chmod 0440 -- {} +
chmod 0550 -- "$STAGING/node-v22/bin/node" "$STAGING/canary/fake-canary" "$STAGING/canary/real-canary" "$STAGING/verify/preflight-ubuntu.sh"
"$PREFLIGHT" "${STAGED_PREFLIGHT_ARGUMENTS[@]}"

STAGED_MANAGER_CONFIG="$STAGING/config/manager.production.json"
STAGED_MODELS_CONFIG="$STAGING/config/models.production.json"
STAGED_UNIT="$STAGING/systemd/qwen38-workload-manager.service"
NEW_MANAGER_SHA=$(sha256sum -- "$STAGED_MANAGER_CONFIG" | cut -d ' ' -f 1)
NEW_MODELS_SHA=$(sha256sum -- "$STAGED_MODELS_CONFIG" | cut -d ' ' -f 1)
NEW_UNIT_SHA=$(sha256sum -- "$STAGED_UNIT" | cut -d ' ' -f 1)
INFERENCE_CREDENTIAL_META=$(stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$INFERENCE_CREDENTIAL")
MANAGEMENT_CREDENTIAL_META=$(stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$MANAGEMENT_CREDENTIAL")

run_canary fake 18081 18181 || fail fake_canary_failed

# Revalidate every proof after the unprivileged fake canary. The real model is
# intentionally deferred until the old 20+ GiB model cgroup is fully quiesced.
"$PREFLIGHT" "${STAGED_PREFLIGHT_ARGUMENTS[@]}"
[[ $(stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$INFERENCE_CREDENTIAL") = "$INFERENCE_CREDENTIAL_META" ]] || fail credential_changed_during_canary
[[ $(stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$MANAGEMENT_CREDENTIAL") = "$MANAGEMENT_CREDENTIAL_META" ]] || fail credential_changed_during_canary
[[ $(sha256sum -- "$STAGED_MANAGER_CONFIG" | cut -d ' ' -f 1) = "$NEW_MANAGER_SHA" ]] || fail staged_artifact_changed
[[ $(sha256sum -- "$STAGED_MODELS_CONFIG" | cut -d ' ' -f 1) = "$NEW_MODELS_SHA" ]] || fail staged_artifact_changed
[[ $(sha256sum -- "$STAGED_UNIT" | cut -d ' ' -f 1) = "$NEW_UNIT_SHA" ]] || fail staged_artifact_changed

# Hash and pin the production binary plus every catalog model as agentops while
# the old router is still serving. This mode cannot bind, enumerate a GPU, read
# credentials, or create a child; strict integrity debt therefore fails before
# the maintenance window causes any downtime.
run_artifact_gate || fail artifact_integrity_preflight_failed
"$PREFLIGHT" "${STAGED_PREFLIGHT_ARGUMENTS[@]}"
[[ $(stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$INFERENCE_CREDENTIAL") = "$INFERENCE_CREDENTIAL_META" ]] || fail credential_changed_during_artifact_gate
[[ $(stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$MANAGEMENT_CREDENTIAL") = "$MANAGEMENT_CREDENTIAL_META" ]] || fail credential_changed_during_artifact_gate
[[ $(sha256sum -- "$STAGED_MANAGER_CONFIG" | cut -d ' ' -f 1) = "$NEW_MANAGER_SHA" ]] || fail staged_artifact_changed
[[ $(sha256sum -- "$STAGED_MODELS_CONFIG" | cut -d ' ' -f 1) = "$NEW_MODELS_SHA" ]] || fail staged_artifact_changed
[[ $(sha256sum -- "$STAGED_UNIT" | cut -d ' ' -f 1) = "$NEW_UNIT_SHA" ]] || fail staged_artifact_changed

# Capture recovery state only after the final gate while the migration lock is
# held, immediately before the old service is changed.
STATE_INSPECTION_DEADLINE=$((SECONDS + STATE_INSPECTION_TIMEOUT_SECONDS))
snapshot_old_state "$STATE_INSPECTION_DEADLINE"
OLD_UNIT_META=$(stat -c '%d %i %u %g %a %Y %Z %s' -- "$OLD_UNIT")
OLD_CONFIG_META=$(stat -c '%d %i %u %g %a %Y %Z %s' -- "$OLD_CONFIG")
OLD_UNIT_SHA=$(sha256sum -- "$OLD_UNIT" | cut -d ' ' -f 1)
OLD_CONFIG_SHA=$(sha256sum -- "$OLD_CONFIG" | cut -d ' ' -f 1)
read -r OLD_UNIT_DEV OLD_UNIT_INODE OLD_UNIT_UID OLD_UNIT_GID OLD_UNIT_MODE OLD_UNIT_MTIME OLD_UNIT_CTIME OLD_UNIT_SIZE <<< "$OLD_UNIT_META"
read -r OLD_CONFIG_DEV OLD_CONFIG_INODE OLD_CONFIG_UID OLD_CONFIG_GID OLD_CONFIG_MODE OLD_CONFIG_MTIME OLD_CONFIG_CTIME OLD_CONFIG_SIZE <<< "$OLD_CONFIG_META"

SNAPSHOT="$MIGRATIONS/transaction-$(date -u +%Y%m%dT%H%M%SZ)-$$.snapshot"
SNAPSHOT_TEMP="$SNAPSHOT.tmp"
{
  printf 'version=3\n'
  printf 'release_id=%s\n' "$RELEASE_ID"
  printf 'new_service_stage=not_installed\n'
  printf 'cleanup_stage=not_started\n'
  printf 'old_active=%s\n' "$OLD_ACTIVE"
  printf 'old_enabled=%s\n' "$OLD_ENABLED"
  printf 'old_main_pid=%s\n' "$OLD_MAIN_PID"
  printf 'old_control_group=%s\n' "$OLD_CONTROL_GROUP"
  printf 'old_unit_dev=%s\n' "$OLD_UNIT_DEV"
  printf 'old_unit_inode=%s\n' "$OLD_UNIT_INODE"
  printf 'old_unit_uid=%s\n' "$OLD_UNIT_UID"
  printf 'old_unit_gid=%s\n' "$OLD_UNIT_GID"
  printf 'old_unit_mode=%s\n' "$OLD_UNIT_MODE"
  printf 'old_unit_mtime=%s\n' "$OLD_UNIT_MTIME"
  printf 'old_unit_ctime=%s\n' "$OLD_UNIT_CTIME"
  printf 'old_unit_size=%s\n' "$OLD_UNIT_SIZE"
  printf 'old_unit_sha256=%s\n' "$OLD_UNIT_SHA"
  printf 'old_config_dev=%s\n' "$OLD_CONFIG_DEV"
  printf 'old_config_inode=%s\n' "$OLD_CONFIG_INODE"
  printf 'old_config_uid=%s\n' "$OLD_CONFIG_UID"
  printf 'old_config_gid=%s\n' "$OLD_CONFIG_GID"
  printf 'old_config_mode=%s\n' "$OLD_CONFIG_MODE"
  printf 'old_config_mtime=%s\n' "$OLD_CONFIG_MTIME"
  printf 'old_config_ctime=%s\n' "$OLD_CONFIG_CTIME"
  printf 'old_config_size=%s\n' "$OLD_CONFIG_SIZE"
  printf 'old_config_sha256=%s\n' "$OLD_CONFIG_SHA"
  printf 'new_unit_sha256=%s\n' "$NEW_UNIT_SHA"
  printf 'new_manager_sha256=%s\n' "$NEW_MANAGER_SHA"
  printf 'new_models_sha256=%s\n' "$NEW_MODELS_SHA"
} > "$SNAPSHOT_TEMP"
chmod 0600 -- "$SNAPSHOT_TEMP"
mv -T -- "$SNAPSHOT_TEMP" "$SNAPSHOT"
SNAPSHOT_TEMP=

# The snapshot is not armed until all identities are checked once more. A
# failure here leaves the still-running old router untouched.
SNAPSHOT_OLD_ACTIVE=$OLD_ACTIVE
SNAPSHOT_OLD_ENABLED=$OLD_ENABLED
SNAPSHOT_OLD_MAIN_PID=$OLD_MAIN_PID
SNAPSHOT_OLD_CONTROL_GROUP=$OLD_CONTROL_GROUP
"$PREFLIGHT" "${STAGED_PREFLIGHT_ARGUMENTS[@]}"
[[ $(stat -c '%d %i %u %g %a %Y %Z %s' -- "$OLD_UNIT") = "$OLD_UNIT_META" && $(sha256sum -- "$OLD_UNIT" | cut -d ' ' -f 1) = "$OLD_UNIT_SHA" ]] || fail old_unit_changed_before_stop
[[ $(stat -c '%d %i %u %g %a %Y %Z %s' -- "$OLD_CONFIG") = "$OLD_CONFIG_META" && $(sha256sum -- "$OLD_CONFIG" | cut -d ' ' -f 1) = "$OLD_CONFIG_SHA" ]] || fail old_config_changed_before_stop
[[ $(stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$INFERENCE_CREDENTIAL") = "$INFERENCE_CREDENTIAL_META" ]] || fail credential_changed_before_stop
[[ $(stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$MANAGEMENT_CREDENTIAL") = "$MANAGEMENT_CREDENTIAL_META" ]] || fail credential_changed_before_stop
STATE_INSPECTION_DEADLINE=$((SECONDS + STATE_INSPECTION_TIMEOUT_SECONDS))
snapshot_old_state "$STATE_INSPECTION_DEADLINE"
[[ "$OLD_ACTIVE" = "$SNAPSHOT_OLD_ACTIVE" && "$OLD_ENABLED" = "$SNAPSHOT_OLD_ENABLED" && "$OLD_MAIN_PID" = "$SNAPSHOT_OLD_MAIN_PID" && "$OLD_CONTROL_GROUP" = "$SNAPSHOT_OLD_CONTROL_GROUP" ]] || fail old_router_state_changed_before_stop
ROLLBACK_ARMED=1

OLD_QUIESCE_DEADLINE=$((SECONDS + OLD_QUIESCE_TIMEOUT_SECONDS))
run_old_systemctl_before_deadline "$OLD_QUIESCE_DEADLINE" stop qwen38.service || true
run_old_systemctl_before_deadline "$OLD_QUIESCE_DEADLINE" disable qwen38.service || true
old_unit_file_state_is_before_deadline "$OLD_QUIESCE_DEADLINE" disabled || fail old_service_disable_failed
prove_old_quiesced "$OLD_QUIESCE_DEADLINE"
[[ -f "$MARKER" && ! -L "$MARKER" ]] || fail maintenance_marker_changed
run_command_before_deadline "$OLD_QUIESCE_DEADLINE" unlink -- "$MARKER" || fail maintenance_marker_changed

run_canary real 18082 18182 || fail real_canary_failed
NEW_SERVICE_DEADLINE=$((SECONDS + ARTIFACT_GATE_TIMEOUT_SECONDS))
prove_old_quiesced "$NEW_SERVICE_DEADLINE"
RELEASE_ONLY_ARGUMENTS=(--release-dir "$STAGING" --release-id "$RELEASE_ID" --release-only)
if [[ -n "$FIXTURE_ROOT" ]]; then RELEASE_ONLY_ARGUMENTS+=(--fixture-root "$FIXTURE_ROOT"); fi
run_artifact_command_before_deadline "$NEW_SERVICE_DEADLINE" "$PREFLIGHT" "${RELEASE_ONLY_ARGUMENTS[@]}" || \
  fail release_only_revalidation_failed
for CANARY_PORT in 18081 18082 18181 18182; do
  CANARY_LISTENERS=$(run_command_before_deadline "$NEW_SERVICE_DEADLINE" "$SS" -H -ltnp "sport = :$CANARY_PORT") || \
    fail canary_port_inspection_failed
  [[ -z "$CANARY_LISTENERS" ]] || fail canary_process_not_quiesced
done
CURRENT_INFERENCE_CREDENTIAL_META=$(run_command_before_deadline "$NEW_SERVICE_DEADLINE" stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$INFERENCE_CREDENTIAL") || \
  fail credential_changed_during_canary
CURRENT_MANAGEMENT_CREDENTIAL_META=$(run_command_before_deadline "$NEW_SERVICE_DEADLINE" stat -c '%d:%i:%u:%g:%a:%s:%y:%z' -- "$MANAGEMENT_CREDENTIAL") || \
  fail credential_changed_during_canary
[[ "$CURRENT_INFERENCE_CREDENTIAL_META" = "$INFERENCE_CREDENTIAL_META" ]] || fail credential_changed_during_canary
[[ "$CURRENT_MANAGEMENT_CREDENTIAL_META" = "$MANAGEMENT_CREDENTIAL_META" ]] || fail credential_changed_during_canary
[[ $(sha256_before_deadline "$NEW_SERVICE_DEADLINE" "$STAGED_MANAGER_CONFIG") = "$NEW_MANAGER_SHA" ]] || fail staged_artifact_changed
[[ $(sha256_before_deadline "$NEW_SERVICE_DEADLINE" "$STAGED_MODELS_CONFIG") = "$NEW_MODELS_SHA" ]] || fail staged_artifact_changed
[[ $(sha256_before_deadline "$NEW_SERVICE_DEADLINE" "$STAGED_UNIT") = "$NEW_UNIT_SHA" ]] || fail staged_artifact_changed
check_firewall "$NEW_SERVICE_DEADLINE"

run_command_before_deadline "$NEW_SERVICE_DEADLINE" "$INSTALL" -m 0644 -o "$ADMIN_USER" -g "$ADMIN_GROUP" "$STAGED_MANAGER_CONFIG" "$NEW_MANAGER_CONFIG" || fail installed_artifact_changed
run_command_before_deadline "$NEW_SERVICE_DEADLINE" "$INSTALL" -m 0644 -o "$ADMIN_USER" -g "$ADMIN_GROUP" "$STAGED_MODELS_CONFIG" "$NEW_MODELS_CONFIG" || fail installed_artifact_changed
run_command_before_deadline "$NEW_SERVICE_DEADLINE" "$INSTALL" -m 0644 -o "$ADMIN_USER" -g "$ADMIN_GROUP" "$STAGED_UNIT" "$NEW_UNIT" || fail installed_artifact_changed
run_command_before_deadline "$NEW_SERVICE_DEADLINE" mv -T -- "$STAGING" "$RELEASE_TARGET" || fail installed_artifact_changed
STAGING=
CURRENT_TEMP="$WORKLOAD_HOME/.current-$RELEASE_ID-$$"
run_command_before_deadline "$NEW_SERVICE_DEADLINE" ln -s -- "$RELEASE_TARGET" "$CURRENT_TEMP" || fail installed_artifact_changed
run_command_before_deadline "$NEW_SERVICE_DEADLINE" mv -T -- "$CURRENT_TEMP" "$CURRENT_LINK" || fail installed_artifact_changed
CURRENT_TEMP=
[[ $(sha256_before_deadline "$NEW_SERVICE_DEADLINE" "$NEW_MANAGER_CONFIG") = "$NEW_MANAGER_SHA" ]] || fail installed_artifact_changed
[[ $(sha256_before_deadline "$NEW_SERVICE_DEADLINE" "$NEW_MODELS_CONFIG") = "$NEW_MODELS_SHA" ]] || fail installed_artifact_changed
[[ $(sha256_before_deadline "$NEW_SERVICE_DEADLINE" "$NEW_UNIT") = "$NEW_UNIT_SHA" ]] || fail installed_artifact_changed

update_snapshot_stage not_installed files_installed "$NEW_SERVICE_DEADLINE"
update_snapshot_stage files_installed reload_attempted "$NEW_SERVICE_DEADLINE"
run_systemctl_before_deadline "$NEW_SERVICE_DEADLINE" daemon-reload || fail new_service_activation_failed
# Persist the potentially-startable stage before enable creates a boot-time
# wants link. A crash/reboot after that link exists must cancel any queued or
# automatically started unit before the old GPU owner can be restored.
update_snapshot_stage reload_attempted enable_attempted "$NEW_SERVICE_DEADLINE"
update_snapshot_stage enable_attempted start_attempted "$NEW_SERVICE_DEADLINE"
run_systemctl_before_deadline "$NEW_SERVICE_DEADLINE" enable qwen38-workload-manager.service || fail new_service_activation_failed
run_systemctl_before_deadline "$NEW_SERVICE_DEADLINE" start qwen38-workload-manager.service || fail new_service_activation_failed
verify_new_service "$NEW_SERVICE_DEADLINE" || fail new_service_readiness_failed
check_firewall "$NEW_SERVICE_DEADLINE"

ROLLBACK_ARMED=0
trap - EXIT
printf 'install-ubuntu: PASS release=%s snapshot=%s initial=UNLOADED\n' "$RELEASE_ID" "$SNAPSHOT"
