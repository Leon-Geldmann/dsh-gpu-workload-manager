#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
umask 077

RELEASE_DIR=
RELEASE_ID=
FIXTURE_ROOT=
RELEASE_ONLY=0
FIREWALL_ONLY=0

usage() {
  printf '%s\n' 'usage: preflight-ubuntu.sh --release-dir ABS_DIR --release-id SHA256 [--fixture-root ABS_DIR] [--release-only|--firewall-only]'
}

fail() {
  printf 'preflight-ubuntu: FAIL %s\n' "$1" >&2
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
    --release-only)
      RELEASE_ONLY=1
      shift
      ;;
    --firewall-only)
      FIREWALL_ONLY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail unknown_argument ;;
  esac
done

[[ -n "$RELEASE_DIR" ]] || fail missing_release_dir
[[ "$RELEASE_ID" =~ ^[0-9a-f]{64}$ ]] || fail invalid_release_id
[[ "$RELEASE_DIR" = /* ]] || fail release_dir_must_be_absolute
((RELEASE_ONLY == 0 || FIREWALL_ONLY == 0)) || fail scopes_are_mutually_exclusive

FIXTURE=0
ROOT_PREFIX=
if [[ -n "$FIXTURE_ROOT" ]]; then
  FIXTURE=1
  [[ "$FIXTURE_ROOT" = /* && "$FIXTURE_ROOT" != / ]] || fail invalid_fixture_root
  [[ -d "$FIXTURE_ROOT" && ! -L "$FIXTURE_ROOT" ]] || fail invalid_fixture_root
  CANONICAL_FIXTURE=$(readlink -f -- "$FIXTURE_ROOT") || fail invalid_fixture_root
  [[ "$CANONICAL_FIXTURE" = "$FIXTURE_ROOT" ]] || fail fixture_root_must_be_canonical
  ROOT_PREFIX=$FIXTURE_ROOT
  FIXTURE_SENTINEL="$ROOT_PREFIX/.qwen38-workload-manager-fixture-v1"
  [[ -f "$FIXTURE_SENTINEL" && ! -L "$FIXTURE_SENTINEL" ]] || fail invalid_fixture_sentinel
  [[ $(stat -c '%a:%u:%h:%s' -- "$FIXTURE_SENTINEL") = "600:$(id -u):1:35" ]] || fail invalid_fixture_sentinel
  IFS= read -r SENTINEL_LINE < "$FIXTURE_SENTINEL" || fail invalid_fixture_sentinel
  [[ "$SENTINEL_LINE" = qwen38-workload-manager-fixture-v1 ]] || fail invalid_fixture_sentinel
  TARGET_USER=$(id -un)
  TARGET_GROUP=$(id -gn)
  TARGET_UID=$(id -u)
  TARGET_GID=$(id -g)
  ADMIN_USER=$TARGET_USER
  ADMIN_GROUP=$TARGET_GROUP
  ADMIN_UID=$TARGET_UID
  ADMIN_GID=$TARGET_GID
  SYSTEMCTL=$(command -v systemctl) || fail missing_systemctl
  SS=$(command -v ss) || fail missing_ss
  UFW=$(command -v ufw) || fail missing_ufw
  IPTABLES_SAVE=$(command -v iptables-save) || fail missing_iptables_save
  IP6TABLES_SAVE=$(command -v ip6tables-save) || fail missing_ip6tables_save
else
  ((EUID == 0)) || fail production_preflight_requires_root
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
  TARGET_USER=agentops
  TARGET_GROUP=agentops
  TARGET_UID=$(id -u "$TARGET_USER" 2>/dev/null) || fail missing_agentops_user
  TARGET_GID=$(id -g "$TARGET_USER" 2>/dev/null) || fail missing_agentops_group
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
  [[ -x "$SYSTEMCTL" && -x "$SS" && -x "$UFW" && -x "$IPTABLES_SAVE" && -x "$IP6TABLES_SAVE" ]] || fail missing_required_command
fi

target_path() {
  printf '%s%s\n' "$ROOT_PREFIX" "$1"
}

old_systemctl() {
  "$SYSTEMCTL" --user --machine="${TARGET_USER}@.host" "$@"
}

require_regular() {
  local path=$1 label=$2
  [[ -f "$path" && ! -L "$path" ]] || fail "${label}_not_regular"
  [[ $(stat -c '%h' -- "$path") = 1 ]] || fail "${label}_multiple_links"
}

require_exact_file_policy() {
  local path=$1 label=$2 mode=$3 uid=$4 gid=$5
  require_regular "$path" "$label"
  [[ $(stat -c '%a:%u:%g' -- "$path") = "$mode:$uid:$gid" ]] || fail "${label}_unsafe_policy"
}

read_exact_credential() {
  local path=$1 label=$2 size value=''
  size=$(stat -c '%s' -- "$path") || fail "${label}_credential_invalid_content"
  [[ "$size" = 64 || "$size" = 65 ]] || fail "${label}_credential_invalid_content"
  IFS= read -r value < "$path" || [[ "$size" = 64 ]] || fail "${label}_credential_invalid_content"
  [[ "$value" =~ ^[0-9a-fA-F]{64}$ ]] || fail "${label}_credential_invalid_content"
  CREDENTIAL_VALUE=${value,,}
}

listeners() {
  "$SS" -H -ltnp "sport = :$1"
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

check_port_free() {
  local port=$1 output
  output=$(listeners "$port") || fail port_inspection_failed
  [[ -z "$output" ]] || fail "canary_port_${port}_not_free"
}

port_spec_includes_8080() {
  local value=${1%/tcp} component first last
  value=${value%/udp}
  IFS=',' read -r -a COMPONENTS <<< "$value"
  for component in "${COMPONENTS[@]}"; do
    if [[ "$component" = 8080 ]]; then
      return 0
    fi
    if [[ "$component" =~ ^([0-9]+):([0-9]+)$ ]]; then
      first=${BASH_REMATCH[1]}
      last=${BASH_REMATCH[2]}
      if ((10#$first <= 8080 && 8080 <= 10#$last)); then
        return 0
      fi
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
  local output ipv4_filter ipv6_filter line port_spec active=0 default_deny=0 safe=0 unsafe=0 trusted_interface=
  local trusted_no_interface='^8080(/tcp)?[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+192\.168\.3\.0/24([[:space:]]+#.*|[[:space:]]*)$'
  local trusted_on_interface='^8080(/tcp)?[[:space:]]+on[[:space:]]+([A-Za-z0-9_][A-Za-z0-9_.:+-]*)[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+192\.168\.3\.0/24([[:space:]]+#.*|[[:space:]]*)$'
  FILTER_CHAIN_POLICY=()
  FILTER_RULE_COUNT=()
  FILTER_RULE=()
  FILTER_RULE_SEEN=()
  output=$($UFW status verbose) || fail trusted_lan_boundary_not_proven
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

  ipv4_filter=$($IPTABLES_SAVE -t filter) || fail trusted_lan_boundary_not_proven
  ipv6_filter=$($IP6TABLES_SAVE -t filter) || fail trusted_lan_boundary_not_proven
  parse_filter_save ipv4 "$ipv4_filter" || fail trusted_lan_boundary_not_proven
  parse_filter_save ipv6 "$ipv6_filter" || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv4 trusted "$trusted_interface" NEW 1 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv4 trusted "$trusted_interface" UNTRACKED 0 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv4 untrusted "$trusted_interface" NEW 0 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv4 untrusted "$trusted_interface" UNTRACKED 0 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv6 ipv6 '' NEW 0 || fail trusted_lan_boundary_not_proven
  analyze_filter_packet ipv6 ipv6 '' UNTRACKED 0 || fail trusted_lan_boundary_not_proven
}

if ((FIREWALL_ONLY)); then
  check_firewall
  printf 'preflight-ubuntu: PASS scope=firewall-only\n'
  exit 0
fi

CANONICAL_RELEASE=$(readlink -f -- "$RELEASE_DIR") || fail release_dir_not_found
[[ "$CANONICAL_RELEASE" = "$RELEASE_DIR" ]] || fail release_dir_must_be_canonical
[[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] || fail release_dir_not_regular
RELEASE_ROOT_MODE=$(stat -c '%a' -- "$RELEASE_DIR")
(( (8#$RELEASE_ROOT_MODE & 022) == 0 )) || fail release_root_group_or_world_writable
(( (8#$RELEASE_ROOT_MODE & 07000) == 0 )) || fail release_root_special_mode
RELEASE_ROOT_OWNER=$(stat -c '%u' -- "$RELEASE_DIR")
[[ "$RELEASE_ROOT_OWNER" = 0 || "$RELEASE_ROOT_OWNER" = "$TARGET_UID" ]] || fail release_root_untrusted_owner
if ((FIXTURE)); then
  [[ "$RELEASE_DIR/" = "$FIXTURE_ROOT/"* ]] || fail fixture_release_outside_root
else
  RELEASE_ANCESTOR=$(dirname -- "$RELEASE_DIR")
  while [[ "$RELEASE_ANCESTOR" != / ]]; do
    [[ -d "$RELEASE_ANCESTOR" && ! -L "$RELEASE_ANCESTOR" ]] || fail release_ancestor_not_secure
    ANCESTOR_MODE=$(stat -c '%a' -- "$RELEASE_ANCESTOR")
    (( (8#$ANCESTOR_MODE & 022) == 0 && (8#$ANCESTOR_MODE & 07000) == 0 )) || fail release_ancestor_not_secure
    ANCESTOR_OWNER=$(stat -c '%u' -- "$RELEASE_ANCESTOR")
    [[ "$ANCESTOR_OWNER" = 0 || "$ANCESTOR_OWNER" = "$TARGET_UID" ]] || fail release_ancestor_not_secure
    RELEASE_ANCESTOR=$(dirname -- "$RELEASE_ANCESTOR")
  done
fi

declare -A RELEASE_FILES=()
declare -A RELEASE_DIRECTORIES=()
while IFS= read -r -d '' ENTRY; do
  RELATIVE=${ENTRY#"$RELEASE_DIR"/}
  [[ "$RELATIVE" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || fail unsafe_release_path
  [[ "$RELATIVE" != */../* && "$RELATIVE" != ../* && "$RELATIVE" != */.. && "$RELATIVE" != *//* ]] || fail unsafe_release_path
  case "$RELATIVE" in
    node-v22|node-v22/*|dist|dist/*|canary|canary/*|config|config/*|systemd|systemd/*|verify|verify/*|release.manifest) ;;
    *) fail unexpected_release_path ;;
  esac
  case "/$RELATIVE" in
    */.env|*.key) fail release_contains_credential_material ;;
  esac
  [[ ! -L "$ENTRY" ]] || fail release_contains_symlink
  if [[ -f "$ENTRY" ]]; then
    RELEASE_FILES["$RELATIVE"]=1
  elif [[ -d "$ENTRY" ]]; then
    RELEASE_DIRECTORIES["$RELATIVE"]=1
  else
    fail release_contains_non_regular_entry
  fi
  MODE=$(stat -c '%a' -- "$ENTRY")
  (( (8#$MODE & 022) == 0 )) || fail release_entry_group_or_world_writable
  (( (8#$MODE & 07000) == 0 )) || fail release_entry_special_mode
  OWNER=$(stat -c '%u' -- "$ENTRY")
  [[ "$OWNER" = 0 || "$OWNER" = "$TARGET_UID" ]] || fail release_entry_untrusted_owner
  [[ ! -f "$ENTRY" || $(stat -c '%h' -- "$ENTRY") = 1 ]] || fail release_entry_multiple_links
done < <(find -P "$RELEASE_DIR" -mindepth 1 -print0)

MANIFEST="$RELEASE_DIR/release.manifest"
require_regular "$MANIFEST" release_manifest
[[ $(sha256sum -- "$MANIFEST" | cut -d ' ' -f 1) = "$RELEASE_ID" ]] || fail release_manifest_digest_mismatch

declare -A LISTED=()
PREVIOUS=
COUNT=0
while IFS= read -r LINE || [[ -n "$LINE" ]]; do
  [[ "$LINE" =~ ^([0-9a-f]{64})[[:space:]][[:space:]]([A-Za-z0-9][A-Za-z0-9._/-]*)$ ]] || fail invalid_release_manifest
  DIGEST=${BASH_REMATCH[1]}
  RELATIVE=${BASH_REMATCH[2]}
  [[ "$RELATIVE" != release.manifest && "$RELATIVE" != */../* && "$RELATIVE" != ../* && "$RELATIVE" != */.. && "$RELATIVE" != *//* ]] || fail invalid_release_manifest_path
  [[ -z ${LISTED["$RELATIVE"]+x} ]] || fail duplicate_release_manifest_path
  [[ -z "$PREVIOUS" || "$PREVIOUS" < "$RELATIVE" ]] || fail unsorted_release_manifest
  [[ -n ${RELEASE_FILES["$RELATIVE"]+x} ]] || fail release_manifest_unknown_path
  ACTUAL=$(sha256sum -- "$RELEASE_DIR/$RELATIVE" | cut -d ' ' -f 1)
  [[ "$ACTUAL" = "$DIGEST" ]] || fail release_file_digest_mismatch
  LISTED["$RELATIVE"]=1
  PREVIOUS=$RELATIVE
  ((COUNT += 1))
done < "$MANIFEST"
((COUNT == ${#RELEASE_FILES[@]} - 1)) || fail incomplete_release_manifest
for RELATIVE in "${!RELEASE_FILES[@]}"; do
  [[ "$RELATIVE" = release.manifest || -n ${LISTED["$RELATIVE"]+x} ]] || fail incomplete_release_manifest
done
for RELATIVE in "${!RELEASE_DIRECTORIES[@]}"; do
  DIRECTORY_PINNED=0
  for LISTED_PATH in "${!LISTED[@]}"; do
    if [[ "$LISTED_PATH" = "$RELATIVE"/* ]]; then
      DIRECTORY_PINNED=1
      break
    fi
  done
  ((DIRECTORY_PINNED == 1)) || fail release_manifest_unpinned_directory
done

for REQUIRED in \
  node-v22/bin/node \
  dist/canary.js \
  dist/managerd.js \
  dist/package.json \
  canary/fake-canary \
  canary/real-canary \
  config/manager.production.json \
  config/models.production.json \
  systemd/qwen38-workload-manager.service \
  verify/preflight-ubuntu.sh \
  verify/verify-live.sh; do
  [[ -n ${LISTED["$REQUIRED"]+x} ]] || fail missing_release_entry
  require_regular "$RELEASE_DIR/$REQUIRED" release_entry
done
[[ -x "$RELEASE_DIR/node-v22/bin/node" ]] || fail node_not_executable
[[ -x "$RELEASE_DIR/canary/fake-canary" && -x "$RELEASE_DIR/canary/real-canary" ]] || fail canary_not_executable
[[ -x "$RELEASE_DIR/verify/preflight-ubuntu.sh" ]] || fail preflight_not_executable

if ((RELEASE_ONLY)); then
  printf 'preflight-ubuntu: PASS release=%s scope=release-only\n' "$RELEASE_ID"
  exit 0
fi

OLD_UNIT=$(target_path /home/agentops/.config/systemd/user/qwen38.service)
OLD_CONFIG=$(target_path /home/agentops/apps/qwen38/config/models.json)
MARKER=$(target_path /home/agentops/.config/ai-stack/qwen38-maintenance-window)
CREDENTIAL_DIRECTORY=$(target_path /etc/qwen38-workload-manager/credentials)
INFERENCE_CREDENTIAL="$CREDENTIAL_DIRECTORY/inference.key"
MANAGEMENT_CREDENTIAL="$CREDENTIAL_DIRECTORY/management.key"
NEW_MANAGER_CONFIG=$(target_path /etc/qwen38-workload-manager/manager.production.json)
NEW_MODELS_CONFIG=$(target_path /etc/qwen38-workload-manager/models.production.json)
NEW_UNIT=$(target_path /etc/systemd/system/qwen38-workload-manager.service)
NEW_WANTS_LINK=$(target_path /etc/systemd/system/multi-user.target.wants/qwen38-workload-manager.service)
CURRENT_LINK=$(target_path /opt/qwen38-workload-manager/current)
RELEASE_TARGET=$(target_path "/opt/qwen38-workload-manager/releases/$RELEASE_ID")

require_regular "$OLD_UNIT" old_unit
require_regular "$OLD_CONFIG" old_config
SYSTEMD_UNIT_DIRECTORY=$(dirname -- "$NEW_UNIT")
NEW_CONFIG_DIRECTORY=$(dirname -- "$NEW_MANAGER_CONFIG")
for ADMIN_DIRECTORY in "$SYSTEMD_UNIT_DIRECTORY" "$NEW_CONFIG_DIRECTORY"; do
  [[ -d "$ADMIN_DIRECTORY" && ! -L "$ADMIN_DIRECTORY" ]] || fail admin_directory_not_safe
  ADMIN_DIRECTORY_MODE=$(stat -c '%a' -- "$ADMIN_DIRECTORY")
  (( (8#$ADMIN_DIRECTORY_MODE & 022) == 0 && (8#$ADMIN_DIRECTORY_MODE & 07000) == 0 )) || fail admin_directory_not_safe
  [[ $(stat -c '%u:%g' -- "$ADMIN_DIRECTORY") = "$ADMIN_UID:$ADMIN_GID" ]] || fail admin_directory_not_safe
done
[[ -d "$CREDENTIAL_DIRECTORY" && ! -L "$CREDENTIAL_DIRECTORY" ]] || fail credential_directory_not_secure
[[ $(stat -c '%a:%u:%g' -- "$CREDENTIAL_DIRECTORY") = "700:$ADMIN_UID:$ADMIN_GID" ]] || fail credential_directory_not_secure
require_exact_file_policy "$INFERENCE_CREDENTIAL" inference_credential 600 "$ADMIN_UID" "$ADMIN_GID"
require_exact_file_policy "$MANAGEMENT_CREDENTIAL" management_credential 600 "$ADMIN_UID" "$ADMIN_GID"
[[ $(stat -c '%d:%i' -- "$INFERENCE_CREDENTIAL") != "$(stat -c '%d:%i' -- "$MANAGEMENT_CREDENTIAL")" ]] || fail credentials_not_distinct
read_exact_credential "$INFERENCE_CREDENTIAL" inference
INFERENCE_CREDENTIAL_VALUE=$CREDENTIAL_VALUE
read_exact_credential "$MANAGEMENT_CREDENTIAL" management
MANAGEMENT_CREDENTIAL_VALUE=$CREDENTIAL_VALUE
[[ "$INFERENCE_CREDENTIAL_VALUE" != "$MANAGEMENT_CREDENTIAL_VALUE" ]] || fail credentials_not_distinct
unset CREDENTIAL_VALUE INFERENCE_CREDENTIAL_VALUE MANAGEMENT_CREDENTIAL_VALUE

for NEW_PATH in "$NEW_MANAGER_CONFIG" "$NEW_MODELS_CONFIG" "$NEW_UNIT" "$NEW_WANTS_LINK" "$CURRENT_LINK" "$RELEASE_TARGET"; do
  [[ ! -e "$NEW_PATH" && ! -L "$NEW_PATH" ]] || fail new_installation_already_exists
done

[[ -f "$MARKER" && ! -L "$MARKER" ]] || fail maintenance_window_not_proven
[[ $(stat -c '%a:%u:%g:%h' -- "$MARKER") = "600:$TARGET_UID:$TARGET_GID:1" ]] || fail maintenance_window_not_proven
MARKER_TEXT=qwen38-maintenance-window-v1
[[ $(stat -c '%s' -- "$MARKER") = $((${#MARKER_TEXT} + 1)) ]] || fail maintenance_window_not_proven
IFS= read -r MARKER_LINE < "$MARKER" || fail maintenance_window_not_proven
[[ "$MARKER_LINE" = "$MARKER_TEXT" ]] || fail maintenance_window_not_proven
NOW=$(date +%s)
MARKER_MTIME=$(stat -c '%Y' -- "$MARKER")
MARKER_AGE=$((NOW - MARKER_MTIME))
((MARKER_AGE >= -60 && MARKER_AGE <= 900)) || fail maintenance_window_not_proven

declare -A OLD_STATE=()
if ! OLD_SHOW=$(old_systemctl show qwen38.service \
  --property=LoadState --property=ActiveState --property=UnitFileState --property=FragmentPath --property=MainPID --property=ControlGroup); then
  fail old_router_state_unprovable
fi
while IFS='=' read -r KEY VALUE; do
  case "$KEY" in
    LoadState|ActiveState|UnitFileState|FragmentPath|MainPID|ControlGroup)
      [[ -z ${OLD_STATE["$KEY"]+x} ]] || fail old_router_state_unprovable
      OLD_STATE["$KEY"]=$VALUE
      ;;
    '') ;;
    *) fail old_router_state_unprovable ;;
  esac
done <<< "$OLD_SHOW"
[[ ${#OLD_STATE[@]} = 6 ]] || fail old_router_state_unprovable
[[ ${OLD_STATE[LoadState]} = loaded ]] || fail old_router_state_unprovable
[[ ${OLD_STATE[ActiveState]} = active ]] || fail old_router_state_unprovable
[[ ${OLD_STATE[UnitFileState]} = enabled || ${OLD_STATE[UnitFileState]} = disabled ]] || fail old_router_state_unprovable
[[ ${OLD_STATE[FragmentPath]} = "$OLD_UNIT" ]] || fail old_router_fragment_unprovable
[[ ${OLD_STATE[MainPID]} =~ ^[0-9]+$ ]] || fail old_router_state_unprovable
[[ ${OLD_STATE[ControlGroup]} = /user.slice/user-1001.slice/user@1001.service/app.slice/qwen38.service ]] || fail old_router_state_unprovable

LISTENER_OUTPUT=$(listeners 8080) || fail port_inspection_failed
((OLD_STATE[MainPID] > 1)) || fail old_router_listener_unprovable
single_ipv4_listener_for_pid "$LISTENER_OUTPUT" "${OLD_STATE[MainPID]}" || fail old_router_listener_unprovable
if ((FIXTURE == 0)); then
  [[ $(stat -c '%u' -- "/proc/${OLD_STATE[MainPID]}") = "$TARGET_UID" ]] || fail old_router_process_unprovable
  OLD_EXE=$(readlink -f -- "/proc/${OLD_STATE[MainPID]}/exe") || fail old_router_process_unprovable
  [[ "$OLD_EXE" = /home/agentops/apps/qwen38/build-vulkan/bin/llama-server ]] || fail old_router_process_unprovable
  OLD_CGROUP_PROCS="/sys/fs/cgroup${OLD_STATE[ControlGroup]}/cgroup.procs"
  [[ -f "$OLD_CGROUP_PROCS" && ! -L "$OLD_CGROUP_PROCS" ]] || fail old_router_process_unprovable
  MAIN_IN_CGROUP=0
  mapfile -t OLD_CGROUP_PIDS < "$OLD_CGROUP_PROCS" || fail old_router_process_unprovable
  for CGROUP_PID in "${OLD_CGROUP_PIDS[@]}"; do
    [[ "$CGROUP_PID" = "${OLD_STATE[MainPID]}" ]] && MAIN_IN_CGROUP=1
  done
  ((MAIN_IN_CGROUP == 1)) || fail old_router_process_unprovable
fi

for PORT in 18081 18082 18181 18182; do
  check_port_free "$PORT"
done
check_firewall

printf 'preflight-ubuntu: PASS release=%s old=%s maintenance=agentops-attested\n' "$RELEASE_ID" "${OLD_STATE[ActiveState]}"
