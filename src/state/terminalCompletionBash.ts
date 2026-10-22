import { terminalFilesBash } from './terminalFilesBash';
/** Session-only Bash integration; installed at SSH creation or manually at an empty prompt. */
const script = [
  '__spc_install() {',
  "if [[ -n $BASH_VERSION && $- == *i* && -o emacs ]] && (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then",
  '__spc_nonce=$1;',
  '__spc_login_uid=${2:-${__spc_login_uid:-$EUID}};',
  'if [[ $EUID == 0 && $__spc_login_uid == 0 && ${SUDO_UID-} =~ ^[0-9]+$ ]]; then __spc_login_uid=$SUDO_UID; fi;',
  terminalFilesBash,
  '__spc_files_start 2>/dev/null;',
  "__spc_seq=0;",
  "__spc_pid=0;",
  "__spc_emit() { printf '\\033]777;spc;%s;%s\\007' \"$__spc_nonce\" \"$1\"; };",
  "__spc_hex() { local LC_ALL=C v=$1 i; REPLY=''; for ((i=0;i<${#v};i++)); do printf -v REPLY '%s%02x' \"$REPLY\" \"'${v:i:1}\"; done; };",
  "__spc_begin() { local v REPLY; __spc_emit B; v=$(HISTTIMEFORMAT= builtin history 1); if [[ $v =~ ^[[:space:]]*[0-9]+[*]?[[:space:]]+(.*)$ ]] && (( ${#BASH_REMATCH[1]} <= 512 )); then __spc_hex \"${BASH_REMATCH[1]}\"; __spc_emit \"H;$REPLY\"; fi; };",
  "__spc_prompt() { local code=$?; ((__spc_pid+=1));",
  '__spc_emit "F;$EUID;$__spc_login_uid;$__spc_files_dir";',
  "__spc_emit \"P;$__spc_pid;$__spc_seq\"; if (( ${#PWD} <= 4096 )); then local REPLY; __spc_hex \"$PWD\"; __spc_emit \"D;$REPLY\"; fi; return \"$code\"; };",
  "__spc_snapshot() { local line cwd home REPLY; ((__spc_seq+=1)); if (( ${#READLINE_LINE} > 512 || ${#PWD} > 1024 )); then",
  "__spc_emit \"S;$__spc_seq;$__spc_pid;-1;;\"; return; fi;",
  "__spc_hex \"$READLINE_LINE\"; line=$REPLY;",
  "__spc_hex \"$PWD\"; cwd=$REPLY; __spc_hex \"${HOME-}\"; home=$REPLY;",
  "__spc_emit \"S;$__spc_seq;$__spc_pid;$READLINE_POINT;$line;$cwd;$home\"; }; if bind -x '\"\\e[99~\":__spc_snapshot'; then if [[ ${__spc_installed-} != 1 ]]; then if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then PROMPT_COMMAND+=(__spc_prompt); else PROMPT_COMMAND=\"${PROMPT_COMMAND:+$PROMPT_COMMAND; }__spc_prompt\"; fi; PS0='$(__spc_begin)'\"${PS0-}\";",
  "__spc_installed=1; fi; if [[ ${PS0-} == '$(__spc_emit B)'* ]]; then PS0='$(__spc_begin)'\"${PS0#'$(__spc_emit B)'}\"; fi;",
  // Only an explicit, command-less login request is wrapped. Authentication stays
  // inside sudo; no payload is ever typed into its password prompt. The target's
  // login environment is prepared by sudo -i, then its interactive bashrc runs
  // before our session-only hooks, through a root-owned process substitution.
  "if [[ $(type -t sudo) != function ]] && ! alias sudo &>/dev/null; then sudo() {",
  "if (( $# == 1 )) && [[ $1 == -i || $1 == --login ]]; then local setup launch encoded='' REPLY index;",
  "printf -v setup '%s\\n__spc_install %q %q\\n' \"$(declare -f __spc_install)\" \"$__spc_nonce\" \"$__spc_login_uid\";",
  "setup=$'if [[ ${SHELL##*/} != bash ]]; then exec \"$SHELL\" -l; fi; if [[ -r ~/.bashrc ]]; then source ~/.bashrc; fi;\\n'\"$setup\";",
  // sudo -i builds a shell -c string but deliberately leaves $ unescaped.
  // Neither %q nor ordinary quoting protects a script from that extra pass.
  // Transfer only hex escapes through sudo; decode inside the target process.
  '__spc_hex "$setup"; for ((index=0;index<${#REPLY};index+=2)); do encoded+="\\x${REPLY:index:2}"; done;',
  "printf -v launch \"exec bash --rcfile <(printf '%%b' '%s') -i\" \"$encoded\";",
  'command sudo -i -- bash -c "$launch";',
  'else command sudo "$@"; fi; }; fi;',
  "__spc_emit I; fi; else printf '%s\\n' '智能补全需要 Bash 4.4+ 和 emacs 行编辑模式。'; printf '\\033]777;spc;__NONCE__;U\\007'; fi;",
  '}; __spc_install __NONCE__',
].join(' ');
export function bashCompletionSetup(nonce: string): string {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error("Invalid integration nonce");
  return script.replace(/__NONCE__/g, nonce);
}

/** Bash read -s restores the terminal mode on completion, interruption or timeout.
 * Its prompt acknowledges readiness before the client sends the private payload. */
export function bashCompletionBootstrap(nonce:string):string {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid integration nonce');
  return ` read -erst 10 -p $'\\e]777;spc;${nonce};R\\a' __spc_setup && eval "$__spc_setup"; unset __spc_setup`;
}
