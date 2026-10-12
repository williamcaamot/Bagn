#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tty = require('node:tty');

const pkg = require('../package.json');

// Docker images, volumes and labels keep the original claude-box names so
// existing logins and containers carry over.
const IMAGE = `claude-box:${pkg.version}`;
const SF_IMAGE = `claude-box:${pkg.version}-sf`;
const CONFIG_VOLUME = 'claude-box-config';
const CURSOR_VOLUME = 'claude-box-cursor';
const SF_VOLUME = 'claude-box-sf';
const IGNORE_FILE = '.claudeboxignore';
const LABEL_FOLDER = 'claude-box.folder';
const LABEL_MOUNTS = 'claude-box.mounts';
const LABEL_SF = 'claude-box.sf';

// Folders are mounted at their host path, except where that would shadow the
// image's own directories or sit somewhere the container user can't reach.
const FALLBACK_ROOT = '/workspace';
const RESERVED_TREES = [
  '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc',
  '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/claude-config',
];
const RESERVED_DIRS = new Set(['/', '/home', '/home/node', '/opt', '/tmp']);

// Files/dirs hidden from the container. Matched against the basename, or
// against the relative path when the pattern contains a '/'.
const DEFAULT_MASKS = [
  '.env', '.env.*', '.envrc', '.dev.vars',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks',
  'id_rsa*', 'id_ecdsa*', 'id_ed25519*',
  '.npmrc', '.yarnrc.yml', '.pypirc', '.netrc', '.pgpass',
  'credentials', 'credentials.json', 'service-account*.json',
  '*.tfvars', '*.tfstate', '*.tfstate.backup',
  '.aws', '.ssh', '.gnupg', '.docker', '.kube',
];
const DEFAULT_ALLOW = ['.env.example', '.env.sample', '.env.template', '*.pub'];
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.turbo', 'dist', 'build', 'out',
  '.venv', 'venv', '__pycache__', 'target', '.cache',
]);

const HELP = `bagn ${pkg.version}
Run Claude Code in Docker with only the current folder mounted.

Usage: bagn [options] [-- args...]

Options:
  --yolo        Skip permission prompts (claude --dangerously-skip-permissions,
                or cursor-agent --yolo with --cursor)
  --list        List bagn containers, most recently used first
  --pick        Choose any container to reuse (from any folder), or start a
                new one
  --new         Start a new container without asking
  --shell       Open a bash shell in the container instead of claude
  --cursor      Run the Cursor CLI (cursor-agent) instead of claude
  --sf          Use an image with the Salesforce CLI (sf) installed
  --sf-org <org>
                Copy the login for an org (alias or username) from sf on this
                computer into the containers' sf, keeping its alias. Repeat
                for more orgs. Implies --sf
  --prune       Remove all stopped bagn containers
  --api-key     Pass ANTHROPIC_API_KEY from your shell into the session
                (default: nothing from your environment is passed)
  --rebuild     Rebuild the Docker image (e.g. to update Claude Code)
  --dry-run     Print the docker commands and masked files, don't run
  --force       Allow running in your home directory or /
  -h, --help    Show this help

Everything after -- is passed to claude (or to cursor-agent/bash), e.g.
  bagn -- -p "summarize this repo"
  bagn --cursor -- login
  bagn --shell -- -c "git status"
Most claude options have an in-session equivalent: /resume, /model, ...

If the current folder has containers, you choose one with the arrow keys
and Enter, or start a new one; several terminals in one folder can share a
container. Without a terminal, the most recent one is reused. A container is not reused
if the image was rebuilt or the set of hidden secret files changed.

The folder is mounted at the same path inside the container, so Claude Code
keeps separate sessions and memory for each folder.

Secret files (.env, *.pem, ...) are replaced by empty read-only files inside
the container. Add more patterns in a ${IGNORE_FILE} file; prefix a line
with ! to un-hide a file.`;

const FLAGS = {
  '--yolo': 'yolo',
  '--list': 'list',
  '--pick': 'pick',
  '--new': 'new',
  '--shell': 'shell',
  '--cursor': 'cursor',
  '--sf': 'sf',
  '--prune': 'prune',
  '--api-key': 'apiKey',
  '--rebuild': 'rebuild',
  '--dry-run': 'dryRun',
  '--force': 'force',
  '--help': 'help',
  '-h': 'help',
};

function parseArgs(argv) {
  const opts = Object.fromEntries(Object.values(FLAGS).map((key) => [key, false]));
  opts.sfOrgs = [];
  const passArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      passArgs.push(...argv.slice(i + 1));
      break;
    }
    if (FLAGS[arg]) {
      opts[FLAGS[arg]] = true;
      continue;
    }
    if (arg === '--sf-org' || arg.startsWith('--sf-org=')) {
      const value = arg === '--sf-org' ? argv[++i] : arg.slice('--sf-org='.length);
      if (!value || value.startsWith('-')) fail('--sf-org needs an org alias or username');
      opts.sfOrgs.push(value);
      opts.sf = true;
      continue;
    }
    // Options were called --box-<name> before they were shortened.
    const renamed = arg.startsWith('--box-') && `--${arg.slice(6)}`;
    if (renamed && FLAGS[renamed]) fail(`${arg} is now ${renamed}`);
    const what = arg.startsWith('-') ? `unknown option ${arg}` : `unexpected argument "${arg}"`;
    fail(`${what}. See bagn --help; pass arguments to claude after --`);
  }
  return { opts, passArgs };
}

function globToRegExp(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function compile(patterns) {
  return patterns.map((p) => {
    const clean = p.replace(/^\/|\/$/g, '');
    return { byPath: clean.includes('/'), re: globToRegExp(clean) };
  });
}

function matches(compiled, relPath) {
  const base = path.posix.basename(relPath);
  return compiled.some(({ byPath, re }) => re.test(byPath ? relPath : base));
}

function loadPatterns(root) {
  const masks = [...DEFAULT_MASKS];
  const allow = [...DEFAULT_ALLOW];
  const file = path.join(root, IGNORE_FILE);
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('!')) allow.push(line.slice(1));
      else masks.push(line);
    }
  }
  return { masks: compile(masks), allow: compile(allow) };
}

function findSecrets(root) {
  const { masks, allow } = loadPatterns(root);
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      // Symlinks are not followed: targets outside the folder don't exist in
      // the container, and targets inside are scanned directly.
      if (entry.isSymbolicLink()) continue;
      const hit = matches(masks, rel) && !matches(allow, rel);
      if (entry.isDirectory()) {
        if (hit) found.push({ rel, dir: true });
        else if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile() && hit) {
        found.push({ rel, dir: false });
      }
    }
  };
  walk(root);
  return found;
}

function docker(args, stdio = 'inherit') {
  return spawnSync('docker', args, { stdio });
}

// Runs docker and returns its trimmed stdout, or null if it failed.
function dockerOut(args) {
  const res = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return res.status === 0 ? res.stdout.trim() : null;
}

function ensureImage(image, sf, rebuild) {
  if (!rebuild && docker(['image', 'inspect', image], 'ignore').status === 0) return;
  console.error(`bagn: building ${image}...`);
  // On rebuild, skip the layer cache, which would otherwise keep the old
  // Claude Code install, and pull the latest base image.
  const cacheArgs = rebuild ? ['--pull', '--no-cache'] : [];
  const sfArgs = sf ? ['--build-arg', 'INSTALL_SF=1'] : [];
  const res = docker(['build', ...cacheArgs, ...sfArgs, '-t', image, path.join(__dirname, '..')]);
  if (res.status !== 0) fail('docker build failed');
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function fail(msg) {
  console.error(`bagn: ${msg}`);
  process.exit(1);
}

function checkFolder(folder, force) {
  if (!force && (folder === path.parse(folder).root || folder === fs.realpathSync(os.homedir()))) {
    fail(`refusing to mount ${folder} (it would expose everything under it). Use --force to override.`);
  }
  // --mount uses comma-separated fields; fail closed rather than risk a mask
  // silently not applying.
  if (folder.includes(',')) fail(`folder path contains a comma, which docker --mount cannot express: ${folder}`);
}

function scanSecrets(folder) {
  const secrets = findSecrets(folder);
  for (const s of secrets) {
    if (s.rel.includes(',')) fail(`cannot mask a path containing a comma: ${s.rel}`);
  }
  return secrets;
}

function printSecrets(secrets) {
  if (!secrets.length) return;
  console.error(`bagn: hiding ${secrets.length} secret path(s) from the container:`);
  for (const s of secrets) console.error(`  - ${s.rel}${s.dir ? '/' : ''}`);
}

// Mounts are fixed when a container is created, so a container may only be
// reused while its mount path and masked paths are unchanged.
function mountsHash(workdir, secrets) {
  const key = [workdir, ...secrets.map((s) => `${s.dir ? 'd' : 'f'}:${s.rel}`).sort()].join('\n');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function slug(folder) {
  return path.basename(folder).toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 30) || 'folder';
}

function containerName(folder) {
  return `bagn-${slug(folder)}-${crypto.randomBytes(3).toString('hex')}`;
}

// Claude Code keys sessions and memory by working directory, so mounting
// every folder at one fixed path would mix them all together.
function containerPath(folder) {
  let p = folder;
  if (process.platform === 'win32') {
    p = `/${folder.replace(/^([A-Za-z]):/, (_, drive) => drive.toLowerCase()).replace(/\\/g, '/')}`;
  }
  const reserved = RESERVED_DIRS.has(p) || RESERVED_TREES.some((r) => p === r || p.startsWith(`${r}/`));
  if (!reserved) return p;
  const hash = crypto.createHash('sha256').update(folder).digest('hex').slice(0, 8);
  return path.posix.join(FALLBACK_ROOT, `${slug(folder)}-${hash}`);
}

// Processes started with `docker exec` have no parent inside the container
// (ppid 0). Excludes PID 1 (the init process) and this ps itself.
function sessionCount(name) {
  const out = dockerOut(['exec', name, 'ps', '-eo', 'pid=,ppid=']);
  if (out === null) return 0;
  const top = out.split('\n').filter((line) => {
    const [pid, ppid] = line.trim().split(/\s+/);
    return ppid === '0' && pid !== '1';
  });
  return Math.max(0, top.length - 1);
}

function listContainers({ sessions = false } = {}) {
  const ids = dockerOut(['ps', '-aq', '--filter', `label=${LABEL_FOLDER}`]);
  if (!ids) return [];
  const info = JSON.parse(dockerOut(['inspect', ...ids.split('\n')]) || '[]');
  const containers = info.map((c) => {
    const running = c.State.Running;
    const name = c.Name.replace(/^\//, '');
    // Containers are stopped when their last session ends, so FinishedAt is
    // when a stopped container was last used.
    const lastUsed = running
      ? Date.now()
      : Math.max(Date.parse(c.Created), Date.parse(c.State.FinishedAt) || 0);
    return {
      name,
      running,
      lastUsed,
      folder: c.Config.Labels[LABEL_FOLDER],
      mounts: c.Config.Labels[LABEL_MOUNTS],
      image: c.Image,
      sf: c.Config.Labels[LABEL_SF] === '1',
      sessions: sessions && running ? sessionCount(name) : 0,
    };
  });
  return containers.sort((a, b) => b.lastUsed - a.lastUsed);
}

function ago(ms) {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

function statusText(c) {
  let status = `last used ${ago(c.lastUsed)}`;
  if (c.running) status = c.sessions ? `in use (${c.sessions} session${c.sessions > 1 ? 's' : ''})` : 'running, idle';
  if (c.sf) status += ', sf';
  return status;
}

// Pads every column but the last to a common width.
function formatTable(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows.map((row) => row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]))).join('  '));
}

function folderText(c, cwd) {
  return c.folder === cwd ? `${c.folder} (here)` : c.folder;
}

function printContainers(containers, cwd) {
  const rows = [['#', 'NAME', 'STATUS', 'FOLDER']];
  containers.forEach((c, i) => rows.push([String(i + 1), c.name, statusText(c), folderText(c, cwd)]));
  for (const line of formatTable(rows)) console.error(line);
}

// Checks for a terminal without touching process.stdin: creating that stream
// makes stdin non-blocking, which breaks the reads below and changes its mode
// under the docker exec that follows.
function interactive() {
  return tty.isatty(0) && tty.isatty(2);
}

// Reads a line from the terminal without opening stdin as a stream.
function prompt(question) {
  process.stderr.write(question);
  const buf = Buffer.alloc(1024);
  let n = 0;
  try {
    n = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    // An unreadable stdin counts as an empty answer.
  }
  return buf.toString('utf8', 0, n).trim();
}

// Runs fn with the terminal sending keys as they are pressed, unechoed, and
// Ctrl-C as a key. Returns undefined if stty is unavailable (e.g. Windows).
function withRawTerminal(fn) {
  const stty = (...args) => spawnSync('stty', args, { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' });
  const saved = stty('-g');
  if (saved.status !== 0) return undefined;
  stty('-icanon', '-echo', '-isig', 'min', '1', 'time', '0');
  try {
    return fn();
  } finally {
    stty(saved.stdout.trim());
  }
}

function readKeys() {
  const buf = Buffer.alloc(64);
  let n = 0;
  try {
    n = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    // Treated like end of input.
  }
  if (!n) return ['\x04'];
  return buf.toString('utf8', 0, n).match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g);
}

// Shows items with an arrow-key cursor. Returns the chosen index, or -1 if
// cancelled.
function menu(title, items) {
  const out = process.stderr;
  const fit = (s) => {
    const max = (out.columns || 80) - 3;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  let sel = 0;
  let drawn = 0;
  const clear = () => out.write(`${drawn ? `\x1b[${drawn}A` : ''}\r\x1b[J`);
  const draw = () => {
    clear();
    const lines = [
      fit(title),
      ...items.map((item, i) => (i === sel ? `\x1b[36m❯ ${fit(item)}\x1b[0m` : `  ${fit(item)}`)),
      '\x1b[2m↑/↓ to move, Enter to select, Esc to cancel\x1b[0m',
    ];
    out.write(`${lines.join('\n')}\n`);
    drawn = lines.length;
  };
  out.write('\x1b[?25l');
  try {
    draw();
    for (;;) {
      for (const key of readKeys()) {
        if (['\x1b[A', '\x1bOA', 'k'].includes(key)) sel = (sel + items.length - 1) % items.length;
        else if (['\x1b[B', '\x1bOB', 'j'].includes(key)) sel = (sel + 1) % items.length;
        else if (/^[1-9]$/.test(key) && Number(key) <= items.length) sel = Number(key) - 1;
        else if (key === '\r' || key === '\n') {
          clear();
          out.write(`${fit(title)} \x1b[36m${fit(items[sel].trim())}\x1b[0m\n`);
          return sel;
        } else if (['\x03', '\x04', '\x1b', 'q'].includes(key)) {
          clear();
          return -1;
        }
      }
      draw();
    }
  } finally {
    out.write('\x1b[?25h');
  }
}

// Lets the user pick one of containers, or null for a new container.
function chooseContainer(containers, cwd, title) {
  const showFolders = containers.some((c) => c.folder !== cwd);
  const rows = formatTable(containers.map((c) => [c.name, statusText(c), ...(showFolders ? [folderText(c, cwd)] : [])]));
  const items = [...rows, '+ Start a new container'];
  let choice = withRawTerminal(() => menu(title, items));
  if (choice === undefined) {
    printContainers(containers, cwd);
    const answer = prompt('\nContainer # to reuse, or Enter for a new one: ');
    if (!answer || answer.toLowerCase() === 'n') return null;
    choice = /^\d+$/.test(answer) ? Number(answer) - 1 : -2;
    if (!containers[choice]) fail(`no container #${answer}`);
  }
  if (choice === -1) {
    console.error('bagn: cancelled');
    process.exit(130);
  }
  return containers[choice] || null;
}

function pickContainer(containers, cwd) {
  if (!interactive()) fail('--pick needs an interactive terminal');
  if (!containers.length) {
    console.error('bagn: no existing containers, starting a new one');
    return null;
  }
  return chooseContainer(containers, cwd, 'Pick a container:');
}

function createArgs(name, folder, secrets, sf) {
  const workdir = containerPath(folder);
  const args = [
    'run', '-d', '--init', '--name', name,
    '--label', `${LABEL_FOLDER}=${folder}`,
    '--label', `${LABEL_MOUNTS}=${mountsHash(workdir, secrets)}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${folder},target=${workdir}`,
    '--mount', `type=volume,source=${CONFIG_VOLUME},target=/claude-config`,
    '--mount', `type=volume,source=${CURSOR_VOLUME},target=/cursor-config`,
    '-w', workdir,
  ];
  if (sf) {
    args.push('--label', `${LABEL_SF}=1`, '--mount', `type=volume,source=${SF_VOLUME},target=/sf-config`);
  }

  for (const s of secrets) {
    const target = path.posix.join(workdir, s.rel);
    if (s.dir) args.push('--mount', `type=tmpfs,target=${target},tmpfs-mode=0555`);
    else args.push('--mount', `type=bind,source=/dev/null,target=${target},readonly`);
  }

  // On Linux, match the host uid so created files aren't owned by uid 1000.
  // Docker Desktop (macOS/Windows) maps ownership itself.
  if (process.platform === 'linux' && process.getuid) {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }

  // The container only idles; each claude session is a separate docker exec.
  args.push(sf ? SF_IMAGE : IMAGE, 'sleep', 'infinity');
  return args;
}

function execArgs(name, opts, command) {
  const args = ['exec', tty.isatty(0) && tty.isatty(1) ? '-it' : '-i'];
  // Docker passes no host environment by default. Only these are added, per
  // session so they're never stored in the container's config, and -e NAME
  // (without =value) keeps values out of the process list.
  for (const envName of ['TERM', 'COLORTERM']) {
    if (process.env[envName]) args.push('-e', envName);
  }
  if (opts.apiKey) {
    if (!process.env.ANTHROPIC_API_KEY) fail('--api-key given but ANTHROPIC_API_KEY is not set');
    args.push('-e', 'ANTHROPIC_API_KEY');
  }
  args.push(name, ...command);
  return args;
}

// sf error messages wrap the reason in lines like "Parsing --target-org" and
// "See more help with --help", and can contain a whole HTML error page.
function sfMessage(msg) {
  const lines = String(msg || '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/^(Parsing |See more help)/.test(l));
  return (lines[0] || '').slice(0, 200);
}

// Runs sf on the host with --json and returns its parsed output.
function hostSf(args, env = {}) {
  const res = spawnSync('sf', [...args, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ...env },
  });
  if (res.error) fail('--sf-org needs the Salesforce CLI (sf) installed on this computer');
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { status: res.status || 1 };
  }
}

// Reads an org's login from sf on the host. The sfdxAuthUrl holds a refresh
// token, which works anywhere, unlike the host's stored tokens: on macOS those
// are encrypted with a key in the Keychain.
function exportSfOrg(org) {
  // Older sf versions include the URL here. Newer ones redact it unless
  // SF_TEMP_SHOW_SECRETS is set, and will stop showing it at all, so then
  // 'sf org auth show-sfdx-auth-url' is used instead.
  const info = hostSf(['org', 'display', '--target-org', org, '--verbose'], { SF_TEMP_SHOW_SECRETS: 'true' });
  if (info.status !== 0 || !info.result) {
    fail(`sf on this computer: ${sfMessage(info.message) || `could not read org ${org}`}`);
  }
  const { alias, username } = info.result;
  let url = info.result.sfdxAuthUrl;
  if (!url?.startsWith('force://')) url = hostSf(['org', 'auth', 'show-sfdx-auth-url', '--target-org', org]).result?.sfdxAuthUrl;
  if (!url?.startsWith('force://')) {
    fail(`${org} has no refresh token to copy. Orgs authorized with JWT (including scratch orgs created from a JWT-authorized Dev Hub) don't have one.`);
  }
  return { org, url, alias: alias || (org !== username ? org : null) };
}

function importArgs(name, org) {
  const args = ['exec', '-i', name, 'sf', 'org', 'login', 'sfdx-url', '--sfdx-url-stdin', '-', '--json'];
  if (org.alias) args.push('--alias', org.alias);
  return args;
}

// The URL goes in on stdin so the refresh token never appears in a process list.
function importSfOrg(name, org) {
  const res = spawnSync('docker', importArgs(name, org), { input: org.url, encoding: 'utf8' });
  if (res.status === 0) return null;
  let msg;
  try {
    msg = JSON.parse(res.stdout).message;
  } catch {
    msg = res.stderr;
  }
  return sfMessage(msg) || 'sf org login failed';
}

function stopIfIdle(name) {
  if (sessionCount(name) === 0) docker(['stop', '-t', '2', name], 'ignore');
}

function main() {
  const { opts, passArgs } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const cwd = fs.realpathSync(process.cwd());
  if (opts.shell && opts.cursor) fail('--shell and --cursor cannot be combined');
  if (opts.shell && opts.yolo) fail('--yolo applies to claude or --cursor, not --shell');
  let command = ['claude', ...(opts.yolo ? ['--dangerously-skip-permissions'] : [])];
  if (opts.shell) command = ['bash'];
  else if (opts.cursor) command = ['cursor-agent', ...(opts.yolo ? ['--yolo'] : [])];
  command.push(...passArgs);

  if (opts.dryRun) {
    checkFolder(cwd, opts.force);
    const secrets = scanSecrets(cwd);
    printSecrets(secrets);
    const name = containerName(cwd);
    console.log(['docker', ...createArgs(name, cwd, secrets, opts.sf)].map(shellQuote).join(' '));
    for (const org of opts.sfOrgs) {
      const args = importArgs(name, { alias: org });
      console.log(`${['docker', ...args].map(shellQuote).join(' ')} < (sfdxAuthUrl from: sf org display -o ${shellQuote(org)} --verbose)`);
    }
    console.log(['docker', ...execArgs(name, opts, command)].map(shellQuote).join(' '));
    return;
  }

  if (docker(['version'], 'ignore').status !== 0) fail('docker is not available or the daemon is not running');

  if (opts.list) {
    const containers = listContainers({ sessions: true });
    if (containers.length) printContainers(containers, cwd);
    else console.error('bagn: no containers');
    return;
  }

  if (opts.prune) {
    const stopped = listContainers().filter((c) => !c.running).map((c) => c.name);
    if (!stopped.length) console.error('bagn: no stopped containers to remove');
    else if (docker(['rm', ...stopped], 'ignore').status !== 0) fail('docker rm failed');
    else console.error(`bagn: removed ${stopped.join(', ')}`);
    return;
  }

  // Read host logins first, so a missing org fails before any docker work.
  const orgs = opts.sfOrgs.map(exportSfOrg);

  let target = opts.pick ? pickContainer(listContainers({ sessions: true }), cwd) : null;
  // A picked container keeps its own image variant.
  const sf = target ? target.sf : opts.sf;
  if (orgs.length && !sf) fail(`${target.name} has no Salesforce CLI; pick an sf container or use --new`);
  const image = sf ? SF_IMAGE : IMAGE;
  ensureImage(image, sf, opts.rebuild);
  const imageId = dockerOut(['image', 'inspect', '-f', '{{.Id}}', image]);

  const folder = target ? target.folder : cwd;
  if (!target) checkFolder(folder, opts.force);
  else if (!fs.existsSync(folder)) fail(`${target.name}'s folder ${folder} no longer exists`);
  const secrets = scanSecrets(folder);
  const hash = mountsHash(containerPath(folder), secrets);

  if (target) {
    if (target.image !== imageId) {
      fail(`${target.name} uses an older image. Run with --new to start a fresh container.`);
    }
    if (target.mounts !== hash) {
      fail(`${target.name}'s mounts are out of date (secret files in ${folder} changed, or bagn was updated). Run with --new from that folder.`);
    }
  } else if (!opts.new) {
    const mine = listContainers().filter((c) => c.folder === folder && c.sf === sf);
    const usable = mine.filter((c) => c.image === imageId && c.mounts === hash);
    if (!usable.length && mine.length) {
      console.error("bagn: this folder's containers are out of date (image rebuilt, secret files changed, or bagn updated)");
    }
    if (usable.length && interactive()) {
      for (const c of usable) c.sessions = c.running ? sessionCount(c.name) : 0;
      target = chooseContainer(usable, cwd, `Containers for ${folder}:`);
    } else {
      target = usable[0] || null;
    }
  }

  printSecrets(secrets);
  let name;
  if (target) {
    name = target.name;
    console.error(`bagn: reusing container ${name}`);
    if (!target.running && docker(['start', name], 'ignore').status !== 0) fail(`could not start ${name}`);
  } else {
    name = containerName(folder);
    console.error(`bagn: starting new container ${name}`);
    if (docker(createArgs(name, folder, secrets, sf), 'ignore').status !== 0) fail('docker run failed');
  }

  for (const org of orgs) {
    const err = importSfOrg(name, org);
    if (err) {
      stopIfIdle(name);
      fail(`could not link org ${org.org}: ${err}`);
    }
    console.error(`bagn: linked org ${org.alias || org.org}`);
  }

  const res = docker(execArgs(name, opts, command));
  // Stop the container once its last session ends; it is started again on
  // the next reuse. Background processes left in it are stopped too.
  stopIfIdle(name);
  process.exit(res.status ?? 1);
}

main();
