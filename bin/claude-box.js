#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = require('../package.json');

const IMAGE = `claude-box:${pkg.version}`;
const CONFIG_VOLUME = 'claude-box-config';
const WORKDIR = '/workspace';
const IGNORE_FILE = '.claudeboxignore';
const LABEL_FOLDER = 'claude-box.folder';
const LABEL_MASKS = 'claude-box.masks';

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

const HELP = `claude-box ${pkg.version}
Run Claude Code in Docker with only the current folder mounted.

Usage: claude-box [box options] [claude args...]

Box options:
  --box-list        List claude-box containers, most recently used first
  --box-pick        Choose a container to reuse from the list, or start a new one
  --box-new         Start a new container instead of reusing this folder's
  --box-shell       Open a bash shell in the container instead of claude
  --box-prune       Remove all stopped claude-box containers
  --box-api-key     Pass ANTHROPIC_API_KEY from your shell into the session
                    (default: nothing from your environment is passed)
  --box-rebuild     Rebuild the Docker image (e.g. to update Claude Code)
  --box-dry-run     Print the docker commands and masked files, don't run
  --box-force       Allow running in your home directory or /
  --box-help        Show this help

By default the most recent container for the current folder is reused, so
several terminals in one folder share a container. A container is not reused
if the image was rebuilt or the set of hidden secret files changed.

Any other arguments are forwarded to claude (or to bash with --box-shell), e.g.
  claude-box --dangerously-skip-permissions

Secret files (.env, *.pem, ...) are replaced by empty read-only files inside
the container. Add more patterns in a ${IGNORE_FILE} file; prefix a line
with ! to un-hide a file.`;

function parseArgs(argv) {
  const opts = {
    apiKey: false, rebuild: false, dryRun: false, force: false, help: false,
    list: false, pick: false, new: false, shell: false, prune: false,
  };
  const claudeArgs = [];
  for (const arg of argv) {
    if (arg === '--box-list') opts.list = true;
    else if (arg === '--box-pick') opts.pick = true;
    else if (arg === '--box-new') opts.new = true;
    else if (arg === '--box-shell') opts.shell = true;
    else if (arg === '--box-prune') opts.prune = true;
    else if (arg === '--box-api-key') opts.apiKey = true;
    else if (arg === '--box-rebuild') opts.rebuild = true;
    else if (arg === '--box-dry-run') opts.dryRun = true;
    else if (arg === '--box-force') opts.force = true;
    else if (arg === '--box-help') opts.help = true;
    else claudeArgs.push(arg);
  }
  return { opts, claudeArgs };
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

function ensureImage(rebuild) {
  if (!rebuild && docker(['image', 'inspect', IMAGE], 'ignore').status === 0) return;
  console.error(`claude-box: building ${IMAGE}...`);
  const res = docker(['build', '-t', IMAGE, path.join(__dirname, '..')]);
  if (res.status !== 0) fail('docker build failed');
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function fail(msg) {
  console.error(`claude-box: ${msg}`);
  process.exit(1);
}

function checkFolder(folder, force) {
  if (!force && (folder === path.parse(folder).root || folder === fs.realpathSync(os.homedir()))) {
    fail(`refusing to mount ${folder} (it would expose everything under it). Use --box-force to override.`);
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
  console.error(`claude-box: hiding ${secrets.length} secret path(s) from the container:`);
  for (const s of secrets) console.error(`  - ${s.rel}${s.dir ? '/' : ''}`);
}

// Mounts are fixed when a container is created, so a container may only be
// reused while the folder's set of masked paths is unchanged.
function masksHash(secrets) {
  const key = secrets.map((s) => `${s.dir ? 'd' : 'f'}:${s.rel}`).sort().join('\n');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function containerName(folder) {
  const base = path.basename(folder).toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 30) || 'folder';
  return `claude-box-${base}-${crypto.randomBytes(3).toString('hex')}`;
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
      masks: c.Config.Labels[LABEL_MASKS],
      image: c.Image,
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

function printContainers(containers, cwd) {
  const rows = [['#', 'NAME', 'STATUS', 'FOLDER']];
  containers.forEach((c, i) => {
    let status = `last used ${ago(c.lastUsed)}`;
    if (c.running) status = c.sessions ? `in use (${c.sessions} session${c.sessions > 1 ? 's' : ''})` : 'running, idle';
    rows.push([String(i + 1), c.name, status, c.folder === cwd ? `${c.folder} (here)` : c.folder]);
  });
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  for (const row of rows) {
    console.error(row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]))).join('  '));
  }
}

// Reads a line from the terminal without opening stdin as a stream, which
// would change its mode under the docker exec that follows.
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

function pickContainer(containers, cwd) {
  if (!process.stdin.isTTY) fail('--box-pick needs an interactive terminal');
  if (!containers.length) {
    console.error('claude-box: no existing containers, starting a new one');
    return null;
  }
  printContainers(containers, cwd);
  const answer = prompt('\nContainer # to reuse, or Enter for a new one: ');
  if (!answer || answer.toLowerCase() === 'n') return null;
  const picked = /^\d+$/.test(answer) && containers[Number(answer) - 1];
  if (!picked) fail(`no container #${answer}`);
  return picked;
}

function createArgs(name, folder, secrets) {
  const args = [
    'run', '-d', '--init', '--name', name,
    '--label', `${LABEL_FOLDER}=${folder}`,
    '--label', `${LABEL_MASKS}=${masksHash(secrets)}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${folder},target=${WORKDIR}`,
    '--mount', `type=volume,source=${CONFIG_VOLUME},target=/claude-config`,
    '-w', WORKDIR,
  ];

  for (const s of secrets) {
    const target = path.posix.join(WORKDIR, s.rel);
    if (s.dir) args.push('--mount', `type=tmpfs,target=${target},tmpfs-mode=0555`);
    else args.push('--mount', `type=bind,source=/dev/null,target=${target},readonly`);
  }

  // On Linux, match the host uid so created files aren't owned by uid 1000.
  // Docker Desktop (macOS/Windows) maps ownership itself.
  if (process.platform === 'linux' && process.getuid) {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }

  // The container only idles; each claude session is a separate docker exec.
  args.push(IMAGE, 'sleep', 'infinity');
  return args;
}

function execArgs(name, opts, command) {
  const args = ['exec', process.stdin.isTTY && process.stdout.isTTY ? '-it' : '-i'];
  // Docker passes no host environment by default. Only these are added, per
  // session so they're never stored in the container's config, and -e NAME
  // (without =value) keeps values out of the process list.
  for (const envName of ['TERM', 'COLORTERM']) {
    if (process.env[envName]) args.push('-e', envName);
  }
  if (opts.apiKey) {
    if (!process.env.ANTHROPIC_API_KEY) fail('--box-api-key given but ANTHROPIC_API_KEY is not set');
    args.push('-e', 'ANTHROPIC_API_KEY');
  }
  args.push(name, ...command);
  return args;
}

function main() {
  const { opts, claudeArgs } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const cwd = fs.realpathSync(process.cwd());
  const command = opts.shell ? ['bash', ...claudeArgs] : ['claude', ...claudeArgs];

  if (opts.dryRun) {
    checkFolder(cwd, opts.force);
    const secrets = scanSecrets(cwd);
    printSecrets(secrets);
    const name = containerName(cwd);
    console.log(['docker', ...createArgs(name, cwd, secrets)].map(shellQuote).join(' '));
    console.log(['docker', ...execArgs(name, opts, command)].map(shellQuote).join(' '));
    return;
  }

  if (docker(['version'], 'ignore').status !== 0) fail('docker is not available or the daemon is not running');

  if (opts.list) {
    const containers = listContainers({ sessions: true });
    if (containers.length) printContainers(containers, cwd);
    else console.error('claude-box: no containers');
    return;
  }

  if (opts.prune) {
    const stopped = listContainers().filter((c) => !c.running).map((c) => c.name);
    if (!stopped.length) console.error('claude-box: no stopped containers to remove');
    else if (docker(['rm', ...stopped], 'ignore').status !== 0) fail('docker rm failed');
    else console.error(`claude-box: removed ${stopped.join(', ')}`);
    return;
  }

  ensureImage(opts.rebuild);
  const imageId = dockerOut(['image', 'inspect', '-f', '{{.Id}}', IMAGE]);

  let target = opts.pick ? pickContainer(listContainers({ sessions: true }), cwd) : null;
  const folder = target ? target.folder : cwd;
  if (!target) checkFolder(folder, opts.force);
  else if (!fs.existsSync(folder)) fail(`${target.name}'s folder ${folder} no longer exists`);
  const secrets = scanSecrets(folder);
  const hash = masksHash(secrets);

  if (target) {
    if (target.image !== imageId) {
      fail(`${target.name} uses an older image. Run with --box-new to start a fresh container.`);
    }
    if (target.masks !== hash) {
      fail(`the secret files in ${folder} changed since ${target.name} was created. Run with --box-new from that folder.`);
    }
  } else if (!opts.new) {
    const mine = listContainers().filter((c) => c.folder === folder);
    target = mine.find((c) => c.image === imageId && c.masks === hash) || null;
    if (!target && mine.length) {
      console.error("claude-box: this folder's containers are out of date (image rebuilt or secret files changed)");
    }
  }

  printSecrets(secrets);
  let name;
  if (target) {
    name = target.name;
    console.error(`claude-box: reusing container ${name}`);
    if (!target.running && docker(['start', name], 'ignore').status !== 0) fail(`could not start ${name}`);
  } else {
    name = containerName(folder);
    console.error(`claude-box: starting new container ${name}`);
    if (docker(createArgs(name, folder, secrets), 'ignore').status !== 0) fail('docker run failed');
  }

  const res = docker(execArgs(name, opts, command));
  // Stop the container once its last session ends; it is started again on
  // the next reuse. Background processes left in it are stopped too.
  if (sessionCount(name) === 0) docker(['stop', '-t', '2', name], 'ignore');
  process.exit(res.status ?? 1);
}

main();
