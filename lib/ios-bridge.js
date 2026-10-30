'use strict';

// The bridge behind bagn --ios. It runs in a worker thread of the bagn
// process on the Mac, so it keeps serving while the main thread waits on
// docker exec, and stops with it. The container's `ios` command posts a
// command to it over HTTP (on host.docker.internal), and it runs one of a
// fixed set of xcodebuild and simctl commands, streaming the output back.
//
// This limits which commands run, not what they do: a build runs the
// project's build scripts and plugins on this Mac. bagn warns about that
// before starting the bridge.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { workerData } = require('node:worker_threads');

// folder is the real path on this Mac, workdir where it's mounted in the
// container. shared receives the port once the server listens (-1 if it
// can't).
const { folder, workdir, token, shared, logFile } = workerData;

// Build output goes inside the folder, so the container can see the built
// app and every path the bridge is given can be checked against the folder.
const DERIVED_DATA = path.join(folder, '.bagn', 'DerivedData');

const BUILD_ACTIONS = new Set(['build', 'test', 'build-for-testing', 'test-without-building', 'analyze']);
const ACTIONS = new Set([...BUILD_ACTIONS, 'clean']);
const INFO_SWITCHES = new Set(['-list', '-showBuildSettings', '-showdestinations', '-showTestPlans']);
const SWITCHES = new Set([
  ...INFO_SWITCHES, '-quiet', '-json', '-hideShellScriptEnvironment', '-retry-tests-on-failure',
  '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile', '-skipUnavailableActions',
]);
// xcodebuild options that take a value, and how the value is checked.
const VALUE_FLAGS = {
  '-scheme': 'any', '-target': 'any', '-configuration': 'any', '-arch': 'any', '-testPlan': 'any',
  '-only-testing': 'any', '-skip-testing': 'any', '-only-test-configuration': 'any', '-skip-test-configuration': 'any',
  '-test-iterations': 'any', '-destination-timeout': 'any', '-parallel-testing-enabled': 'any',
  '-parallel-testing-worker-count': 'any', '-maximum-parallel-testing-workers': 'any',
  '-enableCodeCoverage': 'any', '-enableAddressSanitizer': 'any', '-enableThreadSanitizer': 'any',
  '-enableUndefinedBehaviorSanitizer': 'any', '-test-timeouts-enabled': 'any',
  '-default-test-execution-time-allowance': 'any', '-maximum-test-execution-time-allowance': 'any',
  '-collect-test-diagnostics': 'any', '-testLanguage': 'any', '-testRegion': 'any',
  '-project': 'path', '-workspace': 'path', '-resultBundlePath': 'path',
  '-sdk': 'sdk', '-destination': 'destination',
};
// These are also written as -only-testing:Target/Class.
const COLON_FLAGS = ['-only-testing', '-skip-testing', '-only-test-configuration', '-skip-test-configuration'];
const PLATFORMS = { iOS: 'iOS', tvOS: 'tvOS', watchOS: 'watchOS', xrOS: 'visionOS' };

class UserError extends Error {}

function log(command, args) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const quoted = args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`));
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${folder}: ${command} ${quoted.join(' ')}\n`);
  } catch {
    // Logging is best effort.
  }
}

// Maps a path in the container to this Mac. Returns it only if it resolves,
// following symlinks (which the container can create), to somewhere inside
// the folder. A path that doesn't exist yet is checked by its parent.
function hostPath(p, cwd = workdir) {
  if (typeof p !== 'string' || !p) return null;
  const rel = path.posix.relative(workdir, path.posix.resolve(cwd, p));
  if (rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return null;
  const abs = path.join(folder, rel);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    try {
      real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return null;
    }
  }
  const inside = path.relative(folder, real);
  return inside === '' || (!inside.startsWith(`..${path.sep}`) && inside !== '..' && !path.isAbsolute(inside)) ? real : null;
}

function insidePath(p, cwd, what) {
  const host = hostPath(p, cwd);
  if (!host) throw new UserError(`${what} must be inside ${workdir}: ${p}`);
  return host;
}

function runtimeVersion(runtime) {
  return (runtime.match(/\d+/g) || []).map(Number);
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

function devices() {
  const res = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' });
  if (res.status !== 0) throw new UserError(`simctl failed: ${(res.stderr || '').trim()}`);
  const list = [];
  for (const [id, devs] of Object.entries(JSON.parse(res.stdout).devices)) {
    const runtime = id.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '');
    const os_ = runtime.split('-')[0];
    for (const d of devs) {
      list.push({
        name: d.name, udid: d.udid, state: d.state, runtime,
        platform: `${PLATFORMS[os_] || os_} Simulator`,
        version: runtimeVersion(runtime),
      });
    }
  }
  return list;
}

// Finds a simulator by UDID or name, or the booted one when spec is empty.
// Of several with the same name, a booted one wins, then the newest runtime.
// Returns null if none is booted and optional is set.
function resolveDevice(spec, optional = false) {
  const all = devices();
  if (!spec || spec === 'booted') {
    const booted = all.find((d) => d.state === 'Booted');
    if (booted || optional) return booted || null;
    throw new UserError('no simulator is booted. List them with: ios devices, then: ios boot "<name>"');
  }
  const byId = all.find((d) => d.udid.toLowerCase() === spec.toLowerCase());
  if (byId) return byId;
  const named = all.filter((d) => d.name === spec)
    .sort((a, b) => (b.state === 'Booted') - (a.state === 'Booted') || compareVersions(b.version, a.version));
  if (!named.length) throw new UserError(`no simulator called "${spec}". List them with: ios devices`);
  return named[0];
}

function checkBundleId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(id)) throw new UserError(`not a bundle id: ${id}`);
  return id;
}

function startText(res, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked', Trailer: 'X-Exit-Code' });
  res.flushHeaders();
}

function endText(res, code) {
  res.addTrailers({ 'X-Exit-Code': String(code) });
  res.end();
}

function reply(res, text, code = 0) {
  startText(res);
  res.write(text);
  endText(res, code);
}

// Runs a command, streaming its output, and kills it if the client goes
// away (e.g. Ctrl-C on ios in the container).
function stream(res, command, args, cwd = folder) {
  log(command, args);
  startText(res);
  // Writing to a client that went away errors; the child is killed below.
  res.on('error', () => {});
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let done = false;
  child.stdout.pipe(res, { end: false });
  child.stderr.pipe(res, { end: false });
  res.on('close', () => {
    if (!done) child.kill('SIGTERM');
  });
  child.on('error', (err) => {
    done = true;
    res.write(`bagn ios: could not run ${command}: ${err.message}\n`);
    endText(res, 127);
  });
  child.on('close', (code, signal) => {
    if (done) return;
    done = true;
    endText(res, code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1));
  });
}

function checkDestination(value) {
  const fields = Object.fromEntries(value.split(',').map((f) => {
    const i = f.indexOf('=');
    return [f.slice(0, i).trim(), f.slice(i + 1).trim()];
  }));
  const platform = fields.platform || fields['generic/platform'];
  if (!platform || !/ Simulator$/.test(platform)) {
    throw new UserError(`-destination must name a simulator platform, e.g. "platform=iOS Simulator,name=iPhone 16": ${value}`);
  }
}

// Checks xcodebuild arguments against the allowed actions and options, and
// maps paths to this Mac. Builds and tests may only target a simulator.
function xcodebuildArgs(args, cwd, deviceSpec) {
  const out = [];
  const actions = [];
  let hasDestination = false;
  let info = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (ACTIONS.has(arg)) {
      actions.push(arg);
      out.push(arg);
    } else if (SWITCHES.has(arg)) {
      if (INFO_SWITCHES.has(arg)) info = true;
      out.push(arg);
    } else if (COLON_FLAGS.some((f) => arg.startsWith(`${f}:`))) {
      out.push(arg);
    } else if (VALUE_FLAGS[arg]) {
      const value = args[++i];
      if (value === undefined) throw new UserError(`${arg} needs a value`);
      const kind = VALUE_FLAGS[arg];
      if (kind === 'path') {
        out.push(arg, insidePath(value, cwd, arg));
        continue;
      }
      if (kind === 'sdk') {
        if (!/^(iphone|appletv|watch|xr)simulator[\d.]*$/.test(value)) throw new UserError(`-sdk must be a simulator SDK, e.g. iphonesimulator: ${value}`);
        hasDestination = true;
      }
      if (kind === 'destination') {
        checkDestination(value);
        hasDestination = true;
      }
      out.push(arg, value);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]=]*\])?=/.test(arg)) {
      // A build setting, e.g. CODE_SIGNING_ALLOWED=NO.
      out.push(arg);
    } else {
      throw new UserError(`xcodebuild ${arg} isn't allowed through the bridge. See: ios help`);
    }
  }

  // Without an action, xcodebuild builds, unless it's asked for information.
  const builds = actions.some((a) => BUILD_ACTIONS.has(a)) || (!actions.length && !info);
  if (builds && !hasDestination) {
    // Building works without a simulator; running tests needs one.
    const runsTests = actions.includes('test') || actions.includes('test-without-building');
    const device = resolveDevice(deviceSpec, !runsTests && !deviceSpec);
    out.push('-destination', device ? `platform=${device.platform},id=${device.udid}` : 'generic/platform=iOS Simulator');
  }
  if (builds || actions.length) {
    fs.mkdirSync(DERIVED_DATA, { recursive: true });
    const ignore = path.join(folder, '.bagn', '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    out.push('-derivedDataPath', DERIVED_DATA);
  }
  return out;
}

function screenshot(res, device) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bagn-ios-'));
  const file = path.join(dir, 'screenshot.png');
  const args = ['simctl', 'io', device.udid, 'screenshot', '--type=png', file];
  log('xcrun', args);
  const result = spawnSync('xcrun', args, { encoding: 'utf8' });
  try {
    if (result.status !== 0) throw new UserError(`screenshot failed: ${(result.stderr || '').trim()}`);
    const png = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function deviceTable(list) {
  if (!list.length) return 'No simulators.\n';
  const rows = [['NAME', 'STATE', 'RUNTIME', 'UDID'], ...list.map((d) => [d.name, d.state, d.runtime, d.udid])];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return `${rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd()).join('\n')}\n`;
}

function handle(res, body) {
  const { command, device: deviceSpec, cwd: containerCwd } = body;
  const args = body.args || [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new UserError('bad arguments');
  if (deviceSpec !== undefined && typeof deviceSpec !== 'string') throw new UserError('bad --device');
  const cwd = hostPath(containerCwd) ? path.posix.resolve(containerCwd) : workdir;

  switch (command) {
    case 'status': {
      const version = spawnSync('xcrun', ['xcodebuild', '-version'], { encoding: 'utf8' });
      const booted = devices().filter((d) => d.state === 'Booted');
      return reply(res, `${(version.stdout || version.stderr || '').trim()}\nFolder: ${workdir}\n\nBooted simulators:\n${booted.length ? deviceTable(booted) : 'none\n'}`);
    }
    case 'devices':
      return reply(res, deviceTable(devices().sort((a, b) => compareVersions(b.version, a.version) || a.name.localeCompare(b.name))));
    case 'boot': {
      if (!deviceSpec && !args[0]) throw new UserError('ios boot needs a simulator name or UDID. List them with: ios devices');
      const device = resolveDevice(deviceSpec || args[0]);
      // Shows the simulator, so you can watch what the container does.
      spawnSync('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', device.udid], { stdio: 'ignore' });
      return stream(res, 'xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
    }
    case 'shutdown':
      return stream(res, 'xcrun', ['simctl', 'shutdown', resolveDevice(deviceSpec || args[0]).udid]);
    case 'open':
      return stream(res, 'open', ['-a', 'Simulator']);
    case 'xcodebuild': {
      const host = hostPath(cwd);
      return stream(res, 'xcrun', ['xcodebuild', ...xcodebuildArgs(args, cwd, deviceSpec)], host);
    }
    case 'install': {
      const app = insidePath(args[0], cwd, 'the app');
      if (!app.endsWith('.app') || !fs.statSync(app, { throwIfNoEntry: false })?.isDirectory()) {
        throw new UserError(`not an .app bundle: ${args[0]}`);
      }
      return stream(res, 'xcrun', ['simctl', 'install', resolveDevice(deviceSpec).udid, app]);
    }
    case 'uninstall':
      return stream(res, 'xcrun', ['simctl', 'uninstall', resolveDevice(deviceSpec).udid, checkBundleId(args[0])]);
    case 'launch': {
      const [id, ...appArgs] = args;
      return stream(res, 'xcrun', ['simctl', 'launch', '--terminate-running-process', resolveDevice(deviceSpec).udid, checkBundleId(id), ...appArgs]);
    }
    case 'terminate':
      return stream(res, 'xcrun', ['simctl', 'terminate', resolveDevice(deviceSpec).udid, checkBundleId(args[0])]);
    case 'open-url': {
      const url = args[0] || '';
      // file: URLs would open files from this Mac in the simulator.
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^file:/i.test(url)) throw new UserError(`not a URL (file: URLs aren't allowed): ${url}`);
      return stream(res, 'xcrun', ['simctl', 'openurl', resolveDevice(deviceSpec).udid, url]);
    }
    case 'screenshot':
      return screenshot(res, resolveDevice(deviceSpec));
    case 'logs': {
      const [last = '5m', proc] = args;
      if (!/^\d+[smhd]$/.test(last)) throw new UserError(`--last must be like 30s, 5m or 1h: ${last}`);
      const logArgs = ['simctl', 'spawn', resolveDevice(deviceSpec).udid, 'log', 'show', '--style', 'compact', '--last', last];
      if (proc) {
        if (!/^[\w .+-]+$/.test(proc)) throw new UserError(`not a process name: ${proc}`);
        logArgs.push('--predicate', `process == "${proc}"`);
      }
      return stream(res, 'xcrun', logArgs);
    }
    default:
      throw new UserError(`unknown command ${command}. See: ios help`);
  }
}

function authorized(req) {
  const given = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('not authorized (wrong BAGN_IOS_TOKEN)\n');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
    return;
  }
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    try {
      handle(res, JSON.parse(data));
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(err instanceof UserError ? 400 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${err.message}\n`);
    }
  });
});

// Only on this Mac's loopback, which Docker Desktop and OrbStack forward
// host.docker.internal to. Other machines on the network can't reach it.
server.listen(0, '127.0.0.1', () => {
  Atomics.store(shared, 0, server.address().port);
  Atomics.notify(shared, 0);
});
server.on('error', () => {
  Atomics.store(shared, 0, -1);
  Atomics.notify(shared, 0);
});
