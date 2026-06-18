// node-pty ships its darwin prebuilt `spawn-helper` without the execute bit,
// which makes pty.spawn fail with "posix_spawnp failed". Restore it after every
// install. No-op on platforms/paths where it doesn't apply.
const fs = require('fs');
const path = require('path');
try {
  const dir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
  for (const p of fs.readdirSync(dir)) {
    const helper = path.join(dir, p, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch {}
