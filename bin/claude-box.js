#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = require('../package.json');

const IMAGE = `claude-box:${pkg.version}`;
const CONFIG_VOLUME = 'claude-box-config';
const WORKDIR = '/workspace';
const IGNORE_FILE = '.claudeboxignore';

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
  --box-api-key     Pass ANTHROPIC_API_KEY from your shell into the container
                    (default: nothing from your environment is passed)
  --box-rebuild     Rebuild the Docker image (e.g. to update Claude Code)
  --box-dry-run     Print the docker command and masked files, don't run
  --box-force       Allow running in your home directory or /
  --box-help        Show this help

Any other arguments are forwarded to claude, e.g.
  claude-box --dangerously-skip-permissions

Secret files (.env, *.pem, ...) are replaced by empty read-only files inside
the container. Add more patterns in a ${IGNORE_FILE} file; prefix a line
with ! to un-hide a file.`;

function parseArgs(argv) {
  const opts = { apiKey: false, rebuild: false, dryRun: false, force: false, help: false };
  const claudeArgs = [];
  for (const arg of argv) {
    if (arg === '--box-api-key') opts.apiKey = true;
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

function main() {
  const { opts, claudeArgs } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const cwd = fs.realpathSync(process.cwd());
  if (!opts.force && (cwd === path.parse(cwd).root || cwd === fs.realpathSync(os.homedir()))) {
    fail(`refusing to mount ${cwd} (it would expose everything under it). Use --box-force to override.`);
  }
  // --mount uses comma-separated fields; fail closed rather than risk a mask
  // silently not applying.
  if (cwd.includes(',')) fail(`folder path contains a comma, which docker --mount cannot express: ${cwd}`);

  const secrets = findSecrets(cwd);
  for (const s of secrets) {
    if (s.rel.includes(',')) fail(`cannot mask a path containing a comma: ${s.rel}`);
  }

  const args = [
    'run', '--rm', process.stdin.isTTY && process.stdout.isTTY ? '-it' : '-i',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${cwd},target=${WORKDIR}`,
    '--mount', `type=volume,source=${CONFIG_VOLUME},target=/claude-config`,
    '-w', WORKDIR,
  ];

  for (const s of secrets) {
    const target = path.posix.join(WORKDIR, s.rel);
    if (s.dir) args.push('--mount', `type=tmpfs,target=${target},tmpfs-mode=0555`);
    else args.push('--mount', `type=bind,source=/dev/null,target=${target},readonly`);
  }

  // Docker passes no host environment by default. Only these are added, and
  // -e NAME (without =value) keeps values out of the process list.
  for (const name of ['TERM', 'COLORTERM']) {
    if (process.env[name]) args.push('-e', name);
  }
  if (opts.apiKey) {
    if (!process.env.ANTHROPIC_API_KEY) fail('--box-api-key given but ANTHROPIC_API_KEY is not set');
    args.push('-e', 'ANTHROPIC_API_KEY');
  }

  // On Linux, match the host uid so created files aren't owned by uid 1000.
  // Docker Desktop (macOS/Windows) maps ownership itself.
  if (process.platform === 'linux' && process.getuid) {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }

  args.push(IMAGE, 'claude', ...claudeArgs);

  if (secrets.length) {
    console.error(`claude-box: hiding ${secrets.length} secret path(s) from the container:`);
    for (const s of secrets) console.error(`  - ${s.rel}${s.dir ? '/' : ''}`);
  }

  if (opts.dryRun) {
    console.log(['docker', ...args].map(shellQuote).join(' '));
    return;
  }

  if (docker(['version'], 'ignore').status !== 0) fail('docker is not available or the daemon is not running');
  ensureImage(opts.rebuild);
  const res = docker(args);
  process.exit(res.status ?? 1);
}

main();
