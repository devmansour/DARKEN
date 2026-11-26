'use strict';
// Gets DELOOP (git clone/pull, or a local path), loads its commands and hooks, and can hot-reload them.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_DIR = path.join(__dirname, '..', 'deloop');

function git(args, { cwd, token } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    // Token goes through the environment, not the command line or .git/config.
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` });
  }
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      const clean = (s) => String(s || '').split(token || '\u0000').join('***');
      reject(new Error(`git ${args[0]} failed: ${clean(stderr || err.message).slice(0, 300)}`));
    });
  });
}

class Deloop {
  constructor({ path: localPath, repo, token, branch = 'main', dir = DEFAULT_DIR, url, log = console } = {}) {
    this.local = localPath ? path.resolve(localPath) : '';
    this.repo = repo;
    this.url = url || `https://github.com/${repo}.git`;
    this.token = token;
    this.branch = branch;
    this.dir = this.local || dir;
    this.log = log;
    this.commands = new Map();
    this.hooks = {};
  }

  async head() {
    if (this.local || !fs.existsSync(path.join(this.dir, '.git'))) return null;
    return git(['rev-parse', 'HEAD'], { cwd: this.dir }).catch(() => null);
  }

  // Clone on first run, otherwise fetch and hard-reset to the branch tip.
  async sync() {
    if (this.local) return;
    const opts = { token: this.token };
    const url = this.url;
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      await git(['clone', '--depth', '1', '--branch', this.branch, url, this.dir], opts);
    } else {
      await git(['fetch', '--depth', '1', url, this.branch], { ...opts, cwd: this.dir });
      await git(['reset', '--hard', 'FETCH_HEAD'], { cwd: this.dir });
    }
  }

  // (Re)load hooks and commands. Clears Node's module cache for DELOOP files only.
  load() {
    const root = path.resolve(this.dir);
    if (!fs.existsSync(path.join(root, 'commands'))) throw new Error(`No commands folder in ${root}`);
    for (const f of Object.keys(require.cache)) if (f.startsWith(root + path.sep) && !f.includes(`${path.sep}node_modules${path.sep}`)) delete require.cache[f];

    this.hooks = require(path.join(root, 'index.js'));
    const commands = new Map();
    const files = [];
    for (const cat of fs.readdirSync(path.join(root, 'commands'))) {
      const dir = path.join(root, 'commands', cat);
      if (fs.statSync(dir).isDirectory()) for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
    for (const file of files) {
      let cmd;
      try {
        cmd = require(file);
      } catch (e) {
        this.log.error(`[deloop] could not load ${path.relative(root, file)}: ${e.message}`);
        continue;
      }
      if (!cmd || !cmd.name || typeof cmd.run !== 'function') {
        this.log.error(`[deloop] ${path.relative(root, file)} is not a valid command`);
        continue;
      }
      for (const n of [cmd.name, ...(cmd.aliases || [])]) {
        if (commands.has(n)) this.log.warn(`[deloop] duplicate command name "${n}" (${path.relative(root, file)})`);
        commands.set(String(n).toLowerCase(), cmd);
      }
    }
    this.commands = commands;
    return commands;
  }

  async init() {
    await this.sync();
    this.load();
    return this;
  }

  // For !update: pull the latest DELOOP and reload it.
  async update() {
    const before = await this.head();
    await this.sync();
    const after = await this.head();
    const changed = this.local ? true : before !== after;
    if (changed) this.load();
    let summary = '';
    if (!this.local && changed && before && after) {
      summary = `${before.slice(0, 7)} → ${after.slice(0, 7)}`;
      try {
        const files = await git(['diff', '--name-only', before, after], { cwd: this.dir });
        if (files) summary += `\n${files.split('\n').slice(0, 15).join('\n')}`;
      } catch {}
    }
    return { changed, count: new Set(this.commands.values()).size, summary };
  }
}

module.exports = { Deloop };
