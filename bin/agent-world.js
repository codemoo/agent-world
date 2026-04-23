#!/usr/bin/env node
//
// agent-world — CLI entry point for npx / global installs.
//
// Responsibilities:
//   1. Parse a minimal flag set.
//   2. Auto-generate AGENT_WORLD_API_TOKEN when the user didn't set one.
//   3. Redirect persistence to ~/.agent-world/ so an npm-cache install
//      doesn't scribble into the package's own directory.
//   4. Exec `server/index.js` or `scripts/install-agent-world-hooks.js`
//      depending on subcommand.

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'index.js');
const HOOKS_ENTRY = path.join(REPO_ROOT, 'scripts', 'install-agent-world-hooks.js');

function printHelp() {
  process.stdout.write(`agent-world — live Claude Code CLI session visualizer

Usage:
  agent-world                            Start the server on port 3102
  agent-world --port 4000                Start on a custom port
  agent-world --token <value>            Override AGENT_WORLD_API_TOKEN
                                         (auto-generated if omitted)
  agent-world --install-hooks            Dry-run the hook plugin installer
  agent-world --install-hooks --apply    Actually write the hooks to
                                         ~/.claude/plugins/agent-world/
  agent-world --version                  Print package version
  agent-world --help                     This message

Persistence: user-edited state (world-layout.json, repoAssignments.json)
is written under ~/.agent-world/ when run via this wrapper. The bundled
baseline layout + sprites stay inside the installed package.

See https://github.com/codemoo/agent-world for the full README.
`);
}

function parseArgs(argv) {
  const flags = {
    port: null, token: null,
    installHooks: false, apply: false,
    help: false, version: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port')          { flags.port = argv[++i]; continue; }
    if (a === '--token')         { flags.token = argv[++i]; continue; }
    if (a === '--install-hooks') { flags.installHooks = true; continue; }
    if (a === '--apply')         { flags.apply = true; continue; }
    if (a === '--help' || a === '-h')    { flags.help = true; continue; }
    if (a === '--version' || a === '-v') { flags.version = true; continue; }
  }
  return flags;
}

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureUserDataDir() {
  const dir = path.join(os.homedir(), '.agent-world');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`agent-world: failed to create ${dir}: ${err.message}`);
    process.exit(2);
  }
  return dir;
}

const flags = parseArgs(process.argv.slice(2));

if (flags.help) {
  printHelp();
  process.exit(0);
}

if (flags.version) {
  process.stdout.write(`agent-world ${readPackageVersion()}\n`);
  process.exit(0);
}

if (flags.installHooks) {
  const argv = [HOOKS_ENTRY];
  if (flags.apply) argv.push('--apply');
  const child = spawn('node', argv, { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 1));
  return;
}

const env = { ...process.env };
if (flags.port)  env.PORT = String(flags.port);
if (flags.token) env.AGENT_WORLD_API_TOKEN = flags.token;
if (!env.AGENT_WORLD_API_TOKEN) {
  env.AGENT_WORLD_API_TOKEN = crypto.randomBytes(16).toString('hex');
  console.log(`agent-world: generated AGENT_WORLD_API_TOKEN=${env.AGENT_WORLD_API_TOKEN}`);
}

// Persistence redirect. The server honors AGENT_WORLD_DATA_DIR for
// user-editable state (world-layout.json, repoAssignments.json).
// Read-only bundled assets (default layout, sprites) stay in the
// installed package.
env.AGENT_WORLD_DATA_DIR = ensureUserDataDir();

const child = spawn('node', [SERVER_ENTRY], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 1));
process.on('SIGINT',  () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
