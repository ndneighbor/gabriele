#!/usr/bin/env node
// Development runner for the Electron overlay.
// Renderer assets reload inside Electron; main-process edits restart Electron.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const electron = require('electron');

const root = path.join(__dirname, '..');
const restartFiles = [
  path.join(root, 'overlay', 'main.js'),
];

let child = null;
let restartTimer = null;
let restarting = false;
let restartQueued = false;
let stopping = false;

function start() {
  if (child) return;
  console.log('[gabriele:dev] starting overlay');
  child = spawn(electron, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      GABRIELE_DEV: '1',
    },
  });

  child.on('error', (err) => {
    console.error(`[gabriele:dev] overlay failed to start: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    child = null;
    console.log(`[gabriele:dev] overlay exited (${signal || code})`);
    if (stopping) process.exit(code || 0);
    if (restarting || restartQueued) {
      restarting = false;
      restartQueued = false;
      start();
      return;
    }
    if (code === 0) process.exit(0);
    console.log('[gabriele:dev] waiting for a file change');
  });
}

function restart(reason) {
  console.log(`[gabriele:dev] restart: ${path.relative(root, reason)}`);
  if (restarting) {
    restartQueued = true;
    return;
  }

  if (!child) {
    start();
    return;
  }

  restarting = true;
  const exiting = child;
  exiting.kill();

  setTimeout(() => {
    if (child === exiting) exiting.kill('SIGKILL');
  }, 2500).unref();
}

function scheduleRestart(file) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => restart(file), 150);
}

for (const file of restartFiles) {
  fs.watch(file, { persistent: true }, () => scheduleRestart(file));
}

function stop() {
  stopping = true;
  if (child) child.kill();
  else process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

start();
