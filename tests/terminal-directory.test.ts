import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { testBash } from './helpers/bash.mjs';
import { TerminalDirectoryTracker, directoryParent, directoryChild } from '../src/state/terminalDirectory';
import { bashCompletionSetup } from '../src/state/terminalCompletionBash';

const nonce = 'd'.repeat(32);
const report = (path: string, token = nonce, end = '\x07') => `\x1b]777;spc;${token};D;${Buffer.from(path).toString('hex')}${end}`;
test('目录来自当前终端 nonce 的完整 UTF-8 报告，任意分包和两种 OSC 结束符均可靠', () => {
  for (const end of ['\x07', '\x1b\\']) {
    const wire = report('/opt/中文 space;$(no-command)', nonce, end);
    for (let split = 1; split < wire.length; split++) {
      const tracker = new TerminalDirectoryTracker(nonce);
      tracker.feed('root@server:~# cd /fake\r\n' + wire.slice(0, split));
      assert.equal(tracker.getSnapshot().path, '');
      tracker.feed(wire.slice(split));
      assert.equal(tracker.getSnapshot().path, '/opt/中文 space;$(no-command)');
    }
  }
});
test('不同会话、伪提示符、控制字符和过大报告不触发目录读取，重新接入保留隔离', () => {
  const tracker = new TerminalDirectoryTracker(nonce); let updates = 0;
  const stop = tracker.subscribe(() => updates++);
  tracker.feed(report('/wrong', 'a'.repeat(32)) + 'root@box:/printed#');
  tracker.feed(report('relative') + report('/bad\npath') + report('/' + 'x'.repeat(4097)));
  assert.equal(updates, 0);
  tracker.feed(report('/home')); tracker.feed(report('/home'));
  assert.equal(updates, 2, '同目录执行命令后也刷新清单');
  tracker.adopt('e'.repeat(32)); tracker.feed(report('/old'));
  assert.equal(updates, 2);
  tracker.feed(report('/new', 'e'.repeat(32))); assert.equal(tracker.getSnapshot().path, '/new');
  stop(); tracker.feed(report('/last', 'e'.repeat(32))); assert.equal(updates, 3);
  const other = new TerminalDirectoryTracker(nonce); assert.equal(other.getSnapshot().path, '');
});
test('异常超长或畸形 OSC 可恢复，不保留整个输出缓冲，父目录和特殊名称不执行命令', () => {
  const tracker = new TerminalDirectoryTracker(nonce);
  tracker.feed('\x1b]777;' + 'x'.repeat(20000)); tracker.feed(report('/恢复'));
  assert.equal(tracker.getSnapshot().path, '/恢复');
  tracker.feed(`\x1b]777;spc;${nonce};D;ff\x07`); assert.equal(tracker.getSnapshot().path, '/恢复');
  assert.equal(directoryParent('/'), '/'); assert.equal(directoryParent('/opt/my folder'), '/opt');
  assert.equal(directoryChild('/', 'a;$(echo)'), '/a;$(echo)');
});
test('命令运行时保留上次目录并标记等待，返回提示符后的新目录清除标记', () => {
  const tracker = new TerminalDirectoryTracker(nonce); tracker.feed(report('/home'));
  const revision = tracker.getSnapshot().revision;
  tracker.feed(`\x1b]777;spc;${nonce};B\x07`);
  assert.equal(tracker.getSnapshot().path, '/home'); assert.equal(tracker.getSnapshot().running, true);
  assert.equal(tracker.getSnapshot().revision, revision);
  tracker.feed(report('/opt')); assert.equal(tracker.getSnapshot().running, false);
  assert.equal(tracker.getSnapshot().path, '/opt');
});

test('文件身份随私有报告切换，绑定 nonce 的通道才显示 root，并在退出后恢复', () => {
  const tracker = new TerminalDirectoryTracker(nonce);
  const bridge = `/tmp/shellpilot-files.${nonce}.abcdefgh12`;
  const frame = `\x1b]777;spc;${nonce};F;0;1000;${bridge}\x07`;
  for (const byte of frame) tracker.feed(byte);
  tracker.feed(report('/root'));
  assert.equal(tracker.getSnapshot().access, 'root');
  assert.equal(tracker.getSnapshot().path, '/root');
  tracker.feed(`\x1b]777;spc;${nonce};F;0;1000;/tmp/shellpilot-files.${'a'.repeat(32)}.abcdefgh12\x07`);
  assert.equal(tracker.getSnapshot().access, 'unavailable');
  tracker.feed(`\x1b]777;spc;${nonce};F;1000;1000;\x07`);
  tracker.feed(report('/home/user'));
  assert.equal(tracker.getSnapshot().access, 'login');
  assert.equal(tracker.getSnapshot().path, '/home/user');
});
test('真实 Bash 提示钩子上报 cd 后目录，保留退出码、用户钩子和提示次数', () => {
  const script = bashCompletionSetup(nonce);
  const command = `PROMPT_COMMAND=':'; ${script}; cd /tmp; false; __spc_prompt; code=$?; [[ $code == 1 ]]; result=$?; printf '\\nEXIT:%s\\n' "$result"; [[ $PROMPT_COMMAND == *'__spc_prompt'* ]]`;
  const result = spawnSync(testBash(), ['--noprofile', '--norc', '-ic', command], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const tracker = new TerminalDirectoryTracker(nonce); tracker.feed(result.stdout);
  assert.equal(tracker.getSnapshot().path, '/tmp'); assert.match(result.stdout, /EXIT:0/);
});

test('sudo 按真实登录参数转义后仍继承目录报告，退出恢复，认证与普通命令不受接管', () => {
  const command = `
    fixture=$(mktemp -d); trap 'rm -rf "$fixture"' EXIT;
    mkdir -p "$fixture/bin" "$fixture/root/child";
    printf '%s\\n' 'printf "ROOT_BASHRC\\n"; PROMPT_COMMAND=":"' > "$fixture/root/.bashrc";
    cat > "$fixture/bin/sudo" <<'FAKE'
#!/usr/bin/env bash
if [[ $1 == -i && $2 == -- && $3 == bash && $4 == -c ]]; then
  [[ \${SP_DENY-} != 1 ]] || exit 1
  printf 'PASSWORD_PROMPT_SIMULATED\\n';
  IFS= read -rs password; [[ $password == synthetic-password ]] || exit 2
  shift 2; export HOME="$SP_ROOT" SHELL="$(command -v bash)";
  unset PROMPT_COMMAND PS0; cd "$HOME";
  # sudo src/parse_args.c rewrites -i arguments into a shell -c command.
  # It escapes metacharacters EXCEPT dollar signs, so exec "$@" is not equivalent.
  command_line=$(printf '%s\\n' "$@" | LC_ALL=C awk '{ for(i=1;i<=length($0);i++) { c=substr($0,i,1); if(c !~ /^[a-zA-Z0-9_$-]$/) printf "%c",92; printf "%s",c } printf " " }')
  # Keep both parsing passes inside Bash to avoid Windows' native argument limit.
  # The final exec bash --rcfile still starts a real interactive child process.
  bash() { builtin eval "$2"; }
  builtin eval "$command_line"
  exit $?
fi
printf 'PASSTHROUGH'; printf '<%s>' "$@"; printf '\\n'; exit 37
FAKE
    chmod +x "$fixture/bin/sudo";
    export PATH="$fixture/bin:$PATH" SP_ROOT="$fixture/root";
    ${bashCompletionSetup(nonce)};
    cd /tmp;
    sudo -i <<'CHILD'
synthetic-password
cd "$HOME/child"
exit
CHILD
    __spc_prompt;
    sudo printf '%s' 'a b;$(literal)'; status=$?; printf 'SUDO_STATUS:%s\\n' "$status";
    sudo -i whoami; status=$?; printf 'COMMAND_STATUS:%s\\n' "$status";
    SP_DENY=1 sudo -i </dev/null; status=$?; printf 'DENIED_STATUS:%s\\n' "$status";
  `;
  const result = spawnSync(testBash(), ['--noprofile', '--norc', '-i'], { input: command, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /syntax error|unexpected token/);
  assert.match(result.stdout, /ROOT_BASHRC/);
  assert.match(result.stdout, /PASSWORD_PROMPT_SIMULATED/);
  assert.match(result.stdout, /PASSTHROUGH<printf><%s><a b;\$\(literal\)>/);
  assert.match(result.stdout, /PASSTHROUGH<-i><whoami>/);
  assert.match(result.stdout, /SUDO_STATUS:37/);
  assert.match(result.stdout, /COMMAND_STATUS:37/);
  assert.match(result.stdout, /DENIED_STATUS:1/);
  assert.doesNotMatch(result.stdout, /synthetic-password/);
  const tracker = new TerminalDirectoryTracker(nonce), paths: string[] = [];
  tracker.subscribe(() => { if (!tracker.getSnapshot().running) paths.push(tracker.getSnapshot().path); });
  tracker.feed(result.stdout);
  assert.ok(paths.some(path => path.endsWith('/root')), JSON.stringify(paths));
  assert.ok(paths.some(path => path.endsWith('/root/child')), JSON.stringify(paths));
  assert.equal(paths.at(-1), '/tmp');
  assert.ok(bashCompletionSetup(nonce).length < 8192);
});

test('已有 sudo 函数和别名不被 Shell 集成覆盖', () => {
  for (const definition of ['sudo() { printf USER_FUNCTION; };', "alias sudo='printf USER_ALIAS';"]) {
    const command = `${definition} before=$(declare -f sudo; alias sudo 2>/dev/null); ${bashCompletionSetup(nonce)}; after=$(declare -f sudo; alias sudo 2>/dev/null); [[ $before == "$after" ]]`;
    const result = spawnSync(testBash(), ['--noprofile', '--norc', '-ic', command], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('WSL 真实 sudo -i、sudo --login、嵌套与退出的目录上报', { skip: !process.env.SHELLPILOT_TEST_WSL }, () => {
  // Opt-in only: root launch avoids passwords/sudoers changes. Disable history
  // inside the test installer before Bash reads or saves interactive history.
  const setup = bashCompletionSetup(nonce).replace('__spc_install() {', '__spc_install() { HISTFILE=/dev/null;');
  const command = `
    HISTFILE=/dev/null;
    fixture=$(mktemp -d /tmp/shellpilot-sudo-test.XXXXXX); trap 'rm -rf "$fixture"' EXIT;
    mkdir -p "$fixture/parent" "$fixture/child";
    ${setup}; cd "$fixture/parent"; __spc_login_uid=1000;
    sudo -i <<CHILD
HISTFILE=/dev/null
cd "$fixture/child"
false
__spc_prompt
printf 'WSL_STATUS:%s\\n' "\\$?"
sudo --login <<NESTED
HISTFILE=/dev/null
cd "$fixture/child"
exit
NESTED
exit
CHILD
    __spc_login_uid=0; __spc_prompt;
    printf 'WSL_DONE\\n';
  `;
  const result = spawnSync('wsl.exe', ['-d', process.env.SHELLPILOT_TEST_WSL!, '-u', 'root', '--exec',
    '/usr/bin/env', 'HISTFILE=/dev/null', '/bin/bash', '--noprofile', '--norc', '-ic', command],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.doesNotMatch(result.stderr, /syntax error|unexpected token|command not found/);
  assert.match(result.stdout, /WSL_STATUS:1/);
  assert.match(result.stdout, /WSL_DONE/);
  const tracker = new TerminalDirectoryTracker(nonce), paths: string[] = [];
  let reusedRoot = false;
  tracker.subscribe(() => {
    if (tracker.getSnapshot().access === 'root') reusedRoot = true;
    if (!tracker.getSnapshot().running) paths.push(tracker.getSnapshot().path);
  });
  tracker.feed(result.stdout);
  assert.ok(paths.filter(path => path.endsWith('/child')).length >= 2, JSON.stringify(paths));
  assert.ok(paths.at(-1)?.endsWith('/parent'), JSON.stringify(paths));
  assert.equal(reusedRoot, true, 'sudo 与嵌套 Shell 必须传递原登录 UID 并提供目录通道');
  assert.equal(tracker.getSnapshot().access, 'login');
});

test('WSL 目录通道复用 root 权限，普通 UID 能取元数据但不能直读目录，Shell 退出后清理', { skip: !process.env.SHELLPILOT_TEST_WSL }, () => {
  const setup = bashCompletionSetup(nonce).replace('__spc_install() {', '__spc_install() { HISTFILE=/dev/null;');
  // Execute the production collector as the unprivileged UID, not a duplicate.
  const collector = readFileSync(new URL('../../ai-ssh-terminal-server-rust/src/terminal/directory_collect.sh', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n').replace("'__BRIDGE__'", '"$1"').replace('__REQUEST__', '11111111111111111111111111111111').replace("'__PATH__'", '"$2"');
  const quotedCollector = "'" + collector.replace(/'/g, "'\\''") + "'";
  const command = `
HISTFILE=/dev/null; fixture=$(mktemp -d /tmp/shellpilot-root-metadata.XXXXXX);
trap 'rm -rf "$fixture"' EXIT;
mkdir "$fixture/folder"; printf PRIVATE_FILE_CONTENT > "$fixture/中文 space.txt";
${setup}; __spc_login_uid=1000; __spc_files_start;
before=$__spc_files_dir; __spc_files_start; [[ $before == "$__spc_files_dir" ]] || exit 21;
printf 'BRIDGE:%s\\n' "$__spc_files_dir";
setpriv --reuid=1000 --regid=1000 --clear-groups test -r "$fixture/中文 space.txt"; printf 'DIRECT_READ:%s\\n' "$?";
__spc_hex "$fixture";
setpriv --reuid=1000 --regid=1000 --clear-groups bash --noprofile --norc -c ${quotedCollector} _ "$__spc_files_dir" "$REPLY";
`;
  const run = (command: string) => spawnSync('wsl.exe', ['-d', process.env.SHELLPILOT_TEST_WSL!, '-u', 'root', '--exec',
    '/usr/bin/env', 'HISTFILE=/dev/null', '/bin/bash', '--noprofile', '--norc', '-ic', command], { encoding: 'utf8', timeout: 30000 });
  const result = run(command);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /DIRECT_READ:1/);
  assert.match(result.stdout, /OK\x00\/tmp\/shellpilot-root-metadata\./);
  assert.ok(result.stdout.includes('中文 space.txt\0f\0'));
  assert.ok(result.stdout.includes('folder\0d\0'));
  assert.doesNotMatch(result.stdout, /PRIVATE_FILE_CONTENT/);
  const bridge = result.stdout.match(/BRIDGE:(\/tmp\/shellpilot-files\.[a-f0-9]{32}\.[a-zA-Z0-9]{10})/u)?.[1];
  assert.ok(bridge, result.stdout);
  const cleanup = run(`for ((i=0;i<40;i++)); do [[ ! -e '${bridge}' ]] && exit 0; sleep 0.1; done; exit 1`);
  assert.equal(cleanup.status, 0, '目录通道必须在父 Shell 退出后撤销并清理');
});

for (const transport of ['local', 'ssh']) test(`WSL 文件管理通过生产通道复用 root 权限，SFTP 可定位、列目录、下载和上传 (${transport})`, { skip: !process.env.SHELLPILOT_TEST_WSL }, () => {
  const setup = bashCompletionSetup(nonce).replace('__spc_install() {', '__spc_install() { HISTFILE=/dev/null;');
  const collector = readFileSync(new URL('../../ai-ssh-terminal-server-rust/src/terminal/files_collect.sh', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n').replace("'__BRIDGE__'", '"$1"').replace('__REQUEST__', '22222222222222222222222222222222');
  const python = readFileSync(new URL('./helpers/wsl-terminal-sftp.py', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const command = `HISTFILE=/dev/null; fixture=$(mktemp -d /tmp/shellpilot-sftp-test.XXXXXX);
trap 'rm -rf "$fixture"' EXIT;
printf root-only-test > "$fixture/private.txt";
${setup}; __spc_login_uid=1000; __spc_files_start;
collector=${quote(collector)};
python3 -c ${quote(python)} "$collector" "$__spc_files_dir" "$fixture" ${transport === 'ssh' ? '--ssh' : ''};
`;
  const result = spawnSync('wsl.exe', ['-d', process.env.SHELLPILOT_TEST_WSL!, '-u', 'root', '--exec',
    '/usr/bin/env', 'HISTFILE=/dev/null', '/bin/bash', '--noprofile', '--norc', '-ic', command], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /WSL_TERMINAL_SFTP_OK/);
});
