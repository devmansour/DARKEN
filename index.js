'use strict';
const path = require('path');
const { fromEnv, applySettings } = require('./src/config');
const { createStore } = require('./src/db');
const { Deloop } = require('./src/deloop');
const { startHealth } = require('./src/health');

try { process.loadEnvFile('.env'); } catch {} // local development only; Render injects env vars itself
try { process.env.FFMPEG_PATH ||= require('ffmpeg-static') || ''; } catch {}

const log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

async function main() {
  const { runtime, config } = fromEnv(); // fails first, with a clear message, if the setup is incomplete
  const { MongoClient } = require('mongodb');
  const { startBot } = require('./src/bot');
  const startedAt = Date.now();
  let current = 'starting';
  const status = { set: (s) => (current = s) };

  // Open the port first so Render sees the service as live while the rest boots.
  startHealth({
    port: runtime.port,
    selfUrl: runtime.selfUrl,
    log,
    getStatus: () => ({ bot: config.botName, status: current, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }),
  });

  const client = new MongoClient(runtime.mongoUri);
  await client.connect();
  const db = client.db(runtime.mongoDb);
  const store = createStore(db.collection('kv'));
  const authColl = db.collection('auth');
  log.info('[db] connected to MongoDB');

  if (!runtime.sessionId) {
    const latest = await authColl.findOne({ _id: '__latest' });
    runtime.sessionId = (latest && latest.sessionId) || 'darken';
    log.info(`[db] no SESSION_ID set, using the newest scanner session: ${runtime.sessionId}`);
  }

  applySettings(config, await store.all('settings'));

  const deloop = new Deloop({ ...runtime.deloop, log });
  await deloop.init();
  log.info(`[deloop] loaded ${new Set(deloop.commands.values()).size} commands from ${deloop.dir}`);

  const { loadBaileys } = require(path.join(deloop.dir, 'lib', 'baileys'));
  const B = await loadBaileys();

  let bot = null;
  const restart = () => {
    if (bot) bot.stop();
    client.close().finally(() => process.exit(0)); // Render starts the service again
  };
  bot = await startBot({ B, runtime, config, store, authColl, deloop, state: status, log, restart });

  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { if (bot) bot.stop(); client.close().finally(() => process.exit(0)); });
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack ? e.stack : e));
main().catch((e) => {
  console.error(`[fatal] ${e.message}`);
  process.exit(1);
});
