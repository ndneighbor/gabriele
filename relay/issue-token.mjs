// Mint a signed per-device relay token. The relay verifies the HMAC with the
// shared secret, then trusts the embedded {role, device} — so you can hand out
// scoped, revocable tokens instead of the raw secret.
//
//   GABRIELE_RELAY_SECRET=<secret> node issue-token.mjs --role view --device phone
//
// roles: host (the bridge) · control (drive sessions) · view (read-only)
// Revoke a device by adding it to the relay's GABRIELE_REVOKED (comma-separated).
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SECRET = process.env.GABRIELE_RELAY_SECRET || process.env.SECRET;
if (!SECRET) { console.error('set GABRIELE_RELAY_SECRET'); process.exit(1); }

const role = opt('role', 'control');
const device = opt('device', 'device');
if (!['host', 'control', 'view'].includes(role)) { console.error('--role must be host | control | view'); process.exit(1); }

const payload = Buffer.from(JSON.stringify({ role, device, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
console.log(`${payload}.${sig}`);
