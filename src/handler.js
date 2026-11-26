'use strict';
// The message pipeline: build ctx -> guards -> ban/mode -> automation -> command.
const { createContextFactory, createGroupCache } = require('./context');
const { unwrap, tsOf } = require('./msg');

const STALE_SECONDS = 60; // ignore messages that piled up while the bot was offline

function createHandler(deps) {
  const { sock, store, config, deloop, media, startedAt, log = console, restart } = deps;
  const genId = deps.genId || (() => `3EB0${Math.random().toString(16).slice(2, 14).toUpperCase().padEnd(12, '0')}`);
  const groups = createGroupCache(sock, log);
  const build = createContextFactory({ sock, store, config, deloop, media, groups, startedAt, restart, log });

  // Remember every message id the bot sends, so its own messages are never treated as commands.
  const sent = new Set();
  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, opts = {}) => {
    const messageId = opts.messageId || genId();
    sent.add(messageId);
    if (sent.size > 1000) sent.delete(sent.values().next().value);
    return origSend(jid, content, { ...opts, messageId });
  };

  const hooks = () => deloop.hooks || {};
  const env = () => ({ sock, store, config, startedAt, getMedia: (raw) => media.download(raw) });
  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      log.error(`[${label}] ${e.stack || e.message}`);
      return undefined;
    }
  };

  async function runCommand(ctx) {
    const cmd = deloop.commands.get(ctx.command);
    if (!cmd) return;
    if (cmd.ownerOnly && !ctx.isOwner) return ctx.reply('❌ This command is for the bot owner only.');
    if (cmd.groupOnly && !ctx.isGroup) return ctx.reply('❌ This command only works in groups.');
    if (cmd.adminOnly && !(ctx.isAdmin || ctx.isOwner || ctx.isSudo)) return ctx.reply('❌ Only group admins can use this command.');
    try {
      await cmd.run(ctx);
      store.incr('usage', ctx.sender).catch(() => {});
    } catch (e) {
      log.error(`[command ${cmd.name}] ${e.stack || e.message}`);
      await ctx.reply(`❌ Something went wrong: ${String(e.message || e).slice(0, 200)}`).catch(() => {});
    }
  }

  async function onMessage(msg) {
    const key = msg && msg.key;
    if (!key || !key.remoteJid || !msg.message) return;
    if (key.remoteJid === 'status@broadcast') return onStatus(msg);
    if (key.id && sent.has(key.id)) return; // our own message

    const proto = unwrap(msg.message).protocolMessage;
    if (proto) {
      if ((proto.type === 0 || proto.type === 'REVOKE') && proto.key && hooks().automation) {
        await safe('antidelete', () => hooks().automation.onDelete(env(), proto.key));
      }
      return;
    }

    const age = Date.now() / 1000 - tsOf(msg.messageTimestamp);
    if (msg.messageTimestamp && age > STALE_SECONDS) return;

    const ctx = await safe('context', () => build(msg));
    if (!ctx) return;
    const h = hooks();

    if (ctx.isGroup && h.guards) {
      const handled = await safe('guards', () => h.guards.run(ctx));
      if (handled === true) return;
    }

    const banned = !ctx.isOwner && (await store.get('banned', ctx.sender, false));
    const privateBlock = config.mode === 'private' && !ctx.isOwner && !ctx.isSudo;
    if (banned || privateBlock) return;

    if (h.automation) await safe('automation', () => h.automation.onMessage(ctx));
    if (ctx.command) await runCommand(ctx);
  }

  async function onStatus(msg) {
    if (!hooks().automation) return;
    const age = Date.now() / 1000 - tsOf(msg.messageTimestamp);
    if (msg.messageTimestamp && age > 6 * 3600) return;
    await safe('status', () => hooks().automation.onStatus(env(), msg));
  }

  return {
    onMessage,
    onStatus,
    onParticipants: async (update) => {
      groups.invalidate(update.id);
      if (hooks().events) await safe('events', () => hooks().events.onParticipants(env(), update));
    },
    onGroupsUpdate: (updates) => (updates || []).forEach((u) => u.id && groups.invalidate(u.id)),
    onCall: async (calls) => {
      if (hooks().automation) await safe('anticall', () => hooks().automation.onCall(env(), calls));
    },
    tick: async () => {
      if (hooks().tick) await safe('tick', () => hooks().tick(env()));
    },
    env,
    _sent: sent,
  };
}

module.exports = { createHandler };
