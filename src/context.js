'use strict';
// Builds the ctx object every DELOOP command receives (see DELOOP/CONTRACT.md).
const { normJid, jidNumber, toPN } = require('./jid');
const { typeOf, textOf, contextInfoOf, unwrap, MEDIA } = require('./msg');

const GROUP_TTL = 5 * 60000;

function createGroupCache(sock, log) {
  const cache = new Map();
  async function normalise(md) {
    const participants = await Promise.all(
      md.participants.map(async (p) => ({
        ...p,
        rawId: p.id,
        id: await toPN(sock, p.id, p.phoneNumber || p.jid),
        admin: p.admin || null,
      }))
    );
    return { ...md, owner: md.owner ? await toPN(sock, md.owner, md.ownerPn) : null, participants };
  }
  return {
    async get(jid) {
      const hit = cache.get(jid);
      if (hit && Date.now() - hit.at < GROUP_TTL) return hit.md;
      try {
        const md = await normalise(await sock.groupMetadata(jid));
        cache.set(jid, { at: Date.now(), md });
        return md;
      } catch (e) {
        log.warn && log.warn(`[group] could not read ${jid}: ${e.message}`);
        return hit ? hit.md : { id: jid, subject: '', owner: null, desc: '', announce: false, restrict: false, participants: [], unavailable: true };
      }
    },
    invalidate: (jid) => cache.delete(jid),
  };
}

function createContextFactory({ sock, store, config, deloop, media, groups, startedAt, restart, log = console }) {
  return async function build(msg) {
    const key = msg.key;
    const from = key.remoteJid;
    if (!/@(g\.us|s\.whatsapp\.net|lid)$/.test(from)) return null;
    const isGroup = from.endsWith('@g.us');
    const botJid = normJid(sock.user && sock.user.id);
    const fromMe = !!key.fromMe;

    const rawSender = fromMe ? botJid : isGroup ? key.participant : from;
    const sender = await toPN(sock, rawSender, isGroup ? key.participantAlt : key.remoteJidAlt);

    const body = textOf(msg.message).trim();
    const info = contextInfoOf(msg.message);
    const mentioned = await Promise.all(((info && info.mentionedJid) || []).map((j) => toPN(sock, j)));

    let quoted = null;
    let quotedRaw = null;
    if (info && info.quotedMessage && info.remoteJid !== 'status@broadcast') {
      const qm = info.quotedMessage;
      const qType = typeOf(qm);
      const inner = unwrap(qm)[qType];
      quotedRaw = { key: { remoteJid: from, id: info.stanzaId, participant: info.participant, fromMe: false }, message: qm };
      quoted = {
        key: quotedRaw.key,
        id: info.stanzaId,
        message: qm,
        sender: await toPN(sock, info.participant || from),
        type: qType,
        text: textOf(qm),
        mimetype: inner && inner.mimetype,
        fileName: inner && inner.fileName,
      };
    } else if (info && info.quotedMessage) {
      // A reply to a status: keep the content so !savestatus can use it.
      const qm = info.quotedMessage;
      quotedRaw = { key: { remoteJid: 'status@broadcast', id: info.stanzaId, participant: info.participant, fromMe: false }, message: qm };
      quoted = { key: quotedRaw.key, id: info.stanzaId, message: qm, sender: await toPN(sock, info.participant), type: typeOf(qm), text: textOf(qm) };
    }

    const groupMetadata = isGroup ? await groups.get(from) : null;
    const people = (groupMetadata && groupMetadata.participants) || [];
    const adminIds = new Set(people.filter((p) => p.admin).map((p) => normJid(p.id)));

    const isOwner = fromMe || jidNumber(sender) === String(config.ownerNumber);
    const isSudo = !isOwner && !!(await store.get('sudo', sender, false));
    const isAdmin = isGroup && adminIds.has(normJid(sender));
    const isBotAdmin = isGroup && adminIds.has(botJid);

    // Command parsing
    let command = null;
    let text = '';
    if (body.startsWith(config.prefix)) {
      const rest = body.slice(config.prefix.length).trim();
      const name = (rest.split(/\s+/)[0] || '').toLowerCase();
      if (name) {
        command = name;
        text = rest.slice(rest.split(/\s+/)[0].length).trim();
      }
    }

    const send = (content, opts) => sock.sendMessage(from, content, { quoted: msg, ...opts });
    const ctx = {
      sock, msg, from, sender, pushName: msg.pushName || '',
      isGroup, isAdmin, isBotAdmin, isOwner, isSudo, groupMetadata,
      prefix: config.prefix, command, args: text.split(/\s+/).filter(Boolean), text,
      body, mentioned, quoted,
      reply: (t, opts) => send({ text: String(t) }, opts),
      send,
      react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key } }),
      getMedia: async () => {
        const own = await media.download(msg);
        if (own) return own;
        return quotedRaw ? media.download(quotedRaw) : null;
      },
      store,
      commands: deloop.commands,
      config, startedAt, restart,
      updateCommands: () => deloop.update(),
    };
    return ctx;
  };
}

module.exports = { createContextFactory, createGroupCache, MEDIA };
