// Runs the website locally with sign-in against a fake Logto (from @robyrew/astro-logto/testing): no
// real IdP and no secrets. Sign in by picking a seeded person on the fake's page. Never deploy this.
//
//   npm run dev:local   →  http://localhost:4355  (fake Logto on http://127.0.0.1:4356)
import { spawn } from 'node:child_process';
import { startFakeLogto } from '@robyrew/astro-logto/testing';

const SITE = `http://localhost:${process.env.PORT || 4355}`;
const HOOK_KEY = 'dev-webhook-signing-key';
const MONTH_AGO = Date.now() - 30 * 86_400_000;

const logto = await startFakeLogto({
  port: Number(process.env.LOGTO_PORT || 4356),
  apps: { 'archive-dev': 'dev-app-secret' },
  users: [
    { id: 'devalice0001', username: 'alice', name: 'Alice Example', createdAt: MONTH_AGO },
    { id: 'devmira00002', username: 'mira', name: 'Mira (moderator)', roles: ['moderator'], createdAt: MONTH_AGO },
    { id: 'devbob000003', username: 'bob', name: 'Bob Builder', createdAt: MONTH_AGO },
    { id: 'devdave00004', username: 'dave', name: null, createdAt: MONTH_AGO },
    { id: 'deverin00005', username: 'erin', name: 'Erin', createdAt: MONTH_AGO },
    { id: 'devcarol0006', username: null, name: 'Carol (no handle yet)', createdAt: Date.now() },
  ],
});
logto.addHook({ url: `${SITE}/api/hooks/logto`, signingKey: HOOK_KEY, events: ['User.Data.Updated', 'User.Deleted', 'User.SuspensionStatus.Updated'] });
console.log(`fake Logto on ${logto.endpoint}`);

const child = spawn('npx', ['astro', 'dev', '--port', new URL(SITE).port, '--host', 'localhost'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PUBLIC_SITE_URL: SITE,
    LOGTO_ENDPOINT: logto.endpoint,
    LOGTO_APP_ID: 'archive-dev',
    LOGTO_APP_SECRET: 'dev-app-secret',
    LOGTO_COOKIE_SECRET: 'dev-only-session-secret-not-for-production',
    LOGTO_WEBHOOK_SIGNING_KEY: HOOK_KEY,
    DATA_DIR: process.env.DATA_DIR || './data/dev',
  },
});

const stop = async () => {
  child.kill('SIGTERM');
  await logto.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async code => {
  await logto.close();
  process.exit(code ?? 0);
});
