'use strict';
const path = require('path');
const pino = require('pino');
const { createHandler } = require('./handler');
const { createMedia } = require('./media');

// Connects to WhatsApp with the session stored in MongoDB and keeps the connection alive.
async function startBot({ B, runtime, config, store, authColl, deloop, state: status, log = console, restart }) {
  const { useMongoAuthState } = require(path.join(deloop.dir, 'lib', 'mongoauth'));
  const logger = pino({ level: runtime.logLevel });
  const startedAt = Date.now();
  let attempts = 0;
  let bootMessageSent = false;
  let stopped = false;
  let tickTimer = null;

  async function connect() {
    const { state, saveCreds } = await useMongoAuthState(authColl, runtime.sessionId, B);
    if (!state.creds.me) {
      status.set('no-session');
      log.error(`[bot] No WhatsApp session named "${runtime.sessionId}" in MongoDB. Run the scanner first (see README), then restart.`);
      return;
    }

    let version;
    try {
      version = (await B.fetchLatestBaileysVersion()).version;
    } catch {
      log.warn('[bot] could not fetch the latest WhatsApp Web version, using the library default');
    }

    const sock = B.makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      printQRInTerminal: false,
      browser: B.Browsers ? B.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    const media = createMedia({ B, sock, log });
    const handler = createHandler({
      sock, store, config, deloop, media, startedAt, log, restart,
      genId: B.generateMessageID ? () => B.generateMessageID() : undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        attempts = 0;
        status.set('connected');
        log.info(`[bot] connected as ${sock.user && sock.user.id}`);
        clearInterval(tickTimer);
        tickTimer = setInterval(() => handler.tick(), 60000);
        tickTimer.unref();
        if (!bootMessageSent && process.env.BOOT_MESSAGE !== 'off') {
          bootMessageSent = true;
          const owner = `${config.ownerNumber}@s.whatsapp.net`;
          sock
            .sendMessage(owner, { text: `✅ *${config.botName}* is online.\nCommands loaded: ${new Set(deloop.commands.values()).size}\nPrefix: ${config.prefix}\nTry ${config.prefix}ping` })
            .catch((e) => log.warn(`[bot] could not send the boot message: ${e.message}`));
        }
      }
      if (connection === 'close') {
        clearInterval(tickTimer);
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        const R = B.DisconnectReason || {};
        if (stopped) return;
        const err = lastDisconnect && lastDisconnect.error;
        log.warn(`[bot] disconnected: code=${code} message="${err && err.message}" reason="${err && err.data && (err.data.reason || err.data.content && JSON.stringify(err.data.content))}"`);
        if (code === R.loggedOut) {
          status.set('logged-out');
          log.error('[bot] Logged out from WhatsApp. Run the scanner again to create a new session.');
          return;
        }
        if (code === R.connectionReplaced) {
          status.set('replaced');
          log.error('[bot] This session was opened somewhere else (is the scanner or another copy of the bot still running?). Not reconnecting.');
          return;
        }
        attempts++;
        const wait = code === R.restartRequired ? 500 : Math.min(30000, 2000 * attempts);
        status.set('reconnecting');
        log.warn(`[bot] connection closed (code ${code}), reconnecting in ${Math.round(wait / 1000)}s`);
        setTimeout(() => connect().catch((e) => log.error(`[bot] reconnect failed: ${e.message}`)), wait);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) handler.onMessage(m).catch((e) => log.error(`[message] ${e.stack || e.message}`));
    });
    sock.ev.on('group-participants.update', (u) => handler.onParticipants(u).catch((e) => log.error(`[group] ${e.message}`)));
    sock.ev.on('groups.update', (u) => handler.onGroupsUpdate(u));
    sock.ev.on('call', (c) => handler.onCall(c).catch((e) => log.error(`[call] ${e.message}`)));
    return sock;
  }

  await connect();
  return { stop: () => { stopped = true; clearInterval(tickTimer); } };
}

module.exports = { startBot };
