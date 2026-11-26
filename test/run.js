'use strict';
// Offline tests: fake MongoDB and a fake WhatsApp socket drive the real DARKEN code and the real DELOOP commands.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fromEnv, applySettings } = require('../src/config');
const { createStore } = require('../src/db');
const { Deloop } = require('../src/deloop');
const { createHandler } = require('../src/handler');
const { toPN, normJid } = require('../src/jid');

const DELOOP_DIR = process.env.DELOOP_PATH || path.join(__dirname, '..', '..', 'DELOOP');
let passed = 0;
let failed = 0;
async function t(label, fn) {
  try { await fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failed++; console.log(`  FAIL ${label}: ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

function fakeCollection() {
  const docs = new Map();
  const match = (d, q) => Object.entries(q).every(([k, v]) => d[k] === v);
  return {
    docs,
    findOne: async (q) => (docs.has(q._id) ? structuredClone(docs.get(q._id)) : null),
    find: (q = {}) => ({ toArray: async () => [...docs.values()].filter((d) => match(d, q)).map((d) => structuredClone(d)) }),
    updateOne: async (q, u) => { docs.set(q._id, { ...(docs.get(q._id) || { _id: q._id }), ...u.$set }); },
    findOneAndUpdate: async (q, u) => {
      const cur = docs.get(q._id) || { _id: q._id, ...(u.$setOnInsert || {}) };
      cur.v = (cur.v || 0) + (u.$inc ? u.$inc.v : 0);
      docs.set(q._id, cur);
      return structuredClone(cur);
    },
    deleteOne: async (q) => { docs.delete(q._id); },
    deleteMany: async (q) => { for (const [k, d] of docs) if (match(d, q)) docs.delete(k); },
  };
}

const quiet = { info() {}, warn() {}, error() {} };

(async () => {
  console.log('Config:');
  await t('reads env and validates', () => {
    const env = { MONGO_URI: 'mongodb://x', OWNER_NUMBER: '+255 793 157 892', DELOOP_PATH: '../DELOOP' };
    const { config, runtime } = fromEnv(env);
    ok(config.ownerNumber === '255793157892' && config.prefix === '!' && config.botName === 'DARKEN' && runtime.sessionId === 'darken');
    let err = ''; try { fromEnv({ OWNER_NUMBER: '255793157892' }); } catch (e) { err = e.message; }
    ok(/MONGO_URI/.test(err));
    err = ''; try { fromEnv({ MONGO_URI: 'x', OWNER_NUMBER: '255793157892' }); } catch (e) { err = e.message; }
    ok(/DELOOP_PATH|DELOOP_REPO/.test(err));
    err = ''; try { fromEnv({ MONGO_URI: 'x', OWNER_NUMBER: '123', DELOOP_PATH: 'x' }); } catch (e) { err = e.message; }
    ok(/OWNER_NUMBER/.test(err));
  });
  await t('saved settings override env defaults', () => {
    const c = applySettings({ prefix: '!', botName: 'A', mode: 'public' }, { prefix: '.', mode: 'private', junk: 1 });
    ok(c.prefix === '.' && c.mode === 'private' && c.botName === 'A');
  });

  console.log('Store (MongoDB adapter):');
  await t('get/set/incr/all/export, with caching where promised', async () => {
    const coll = fakeCollection();
    const s = createStore(coll);
    ok((await s.get('stats:g', 'a', 0)) === 0);
    await s.incr('stats:g', 'a'); await s.incr('stats:g', 'a'); await s.incr('stats:g', 'b');
    ok((await s.get('stats:g', 'a')) === 2);
    ok(JSON.stringify(await s.all('stats:g')) === '{"a":2,"b":1}');
    await s.set('settings', 'prefix', '.');
    ok((await s.get('settings', 'prefix')) === '.');
    // cached namespace: served from memory after the first load, and writes go through
    const before = coll.docs.size;
    await s.set('group:1@g.us', 'antilink', { enabled: true });
    ok((await s.all('group:1@g.us')).antilink.enabled === true && coll.docs.size === before + 1);
    coll.docs.get('settings\u0001prefix').v = 'CHANGED-BEHIND-THE-BACK';
    ok((await s.get('settings', 'prefix')) === '.', 'cache was not used');
    const ex = await s.export();
    ok(ex.settings.prefix === 'CHANGED-BEHIND-THE-BACK' && ex['stats:g'].a === 2);
  });
  await t('incr copes with the older driver reply shape', async () => {
    const coll = fakeCollection();
    const orig = coll.findOneAndUpdate;
    coll.findOneAndUpdate = async (...a) => ({ value: await orig(...a) });
    ok((await createStore(coll).incr('x', 'y')) === 1);
  });

  console.log('Session storage (auth adapter):');
  const { useMongoAuthState, sessionExists, deleteSession } = require(path.join(DELOOP_DIR, 'lib', 'mongoauth'));
  const FakeB = {
    initAuthCreds: () => ({ noiseKey: Buffer.from('noise'), registered: false }),
    BufferJSON: {
      replacer: (k, v) => (Buffer.isBuffer(v) || (v && v.type === 'Buffer') ? { type: 'Buffer', data: Buffer.from(v.data || v).toString('base64') } : v),
      reviver: (k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data, 'base64') : v),
    },
    proto: { Message: { AppStateSyncKeyData: { fromObject: (o) => ({ wrapped: o }) } } },
  };
  await t('saves and restores creds and keys, including Buffers', async () => {
    const coll = fakeCollection();
    let a = await useMongoAuthState(coll, 'sess', FakeB);
    ok(!(await sessionExists(coll, 'sess')));
    a.state.creds.me = { id: '255@s.whatsapp.net' };
    await a.saveCreds();
    await a.state.keys.set({ 'pre-key': { 1: { private: Buffer.from('p1') }, 2: { private: Buffer.from('p2') } }, 'app-state-sync-key': { K: { keyData: 1 } } });
    ok(await sessionExists(coll, 'sess'));
    const b = await useMongoAuthState(coll, 'sess', FakeB);
    ok(b.state.creds.me.id === '255@s.whatsapp.net' && Buffer.isBuffer(b.state.creds.noiseKey));
    const got = await b.state.keys.get('pre-key', ['1', '2', '3']);
    ok(got['1'].private.toString() === 'p1' && got['3'] === null);
    ok((await b.state.keys.get('app-state-sync-key', ['K'])).K.wrapped.keyData === 1);
    await b.state.keys.set({ 'pre-key': { 1: null } });
    ok((await b.state.keys.get('pre-key', ['1']))['1'] === null);
  });
  await t('sessions are kept apart and can be deleted', async () => {
    const coll = fakeCollection();
    for (const id of ['one', 'two']) { const a = await useMongoAuthState(coll, id, FakeB); await a.saveCreds(); }
    await deleteSession(coll, 'one');
    ok(!(await sessionExists(coll, 'one')) && (await sessionExists(coll, 'two')));
  });

  console.log('DELOOP loader:');
  if (!fs.existsSync(path.join(DELOOP_DIR, 'commands'))) {
    console.log(`  (DELOOP not found at ${DELOOP_DIR}; set DELOOP_PATH to run the rest)`);
    process.exit(failed ? 1 : 0);
  }
  const deloop = await new Deloop({ path: DELOOP_DIR, log: quiet }).init();
  await t('loads every command, aliases and the hooks', () => {
    ok(new Set(deloop.commands.values()).size >= 140, String(new Set(deloop.commands.values()).size));
    ok(deloop.commands.get('ping') && deloop.commands.get('p') === deloop.commands.get('ping'));
    ok(deloop.hooks.guards && deloop.hooks.events && deloop.hooks.automation && typeof deloop.hooks.tick === 'function');
  });
  await t('survives a broken command file and still loads the rest', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
    fs.cpSync(DELOOP_DIR, tmp, { recursive: true, filter: (s) => !s.includes('node_modules') });
    fs.writeFileSync(path.join(tmp, 'commands', 'general', 'broken.js'), 'module.exports = {{{');
    fs.writeFileSync(path.join(tmp, 'commands', 'general', 'notacommand.js'), 'module.exports = { hello: 1 };');
    const errors = [];
    const d = await new Deloop({ path: tmp, log: { ...quiet, error: (m) => errors.push(m) } }).init();
    ok(d.commands.has('ping') && errors.length === 2 && !d.commands.has('broken'), errors.join(' | '));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await t('git: clones, detects a new commit, reloads, then reports no change', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlgit-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'commands', 'general'), { recursive: true });
    const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo, 'index.js'), 'module.exports = {};');
    const cmd = (n) => `module.exports = { name: '${n}', category: 'general', description: 'x', async run() {} };`;
    fs.writeFileSync(path.join(repo, 'commands', 'general', 'one.js'), cmd('one'));
    g('init', '-b', 'main'); g('add', '.'); g('commit', '-m', 'first');
    const d = new Deloop({ url: `file://${repo}`, branch: 'main', dir: path.join(tmp, 'clone'), log: quiet });
    await d.init();
    ok(d.commands.has('one') && !d.commands.has('two'));
    fs.writeFileSync(path.join(repo, 'commands', 'general', 'two.js'), cmd('two'));
    g('add', '.'); g('commit', '-m', 'second');
    const r = await d.update();
    ok(r.changed && r.count === 2 && d.commands.has('two') && /→/.test(r.summary), JSON.stringify(r));
    const r2 = await d.update();
    ok(!r2.changed && r2.count === 2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await t('git errors never leak the token', async () => {
    const d = new Deloop({ url: 'file:///does/not/exist', token: 'SECRET-TOKEN-123', dir: path.join(os.tmpdir(), `dl-${Date.now()}`), log: quiet });
    let msg = ''; try { await d.sync(); } catch (e) { msg = e.message; }
    ok(msg && !msg.includes('SECRET-TOKEN-123'), msg);
  });

  console.log('JIDs:');
  await t('toPN uses the alt number, then the LID mapping, else keeps the LID', async () => {
    const sock = { signalRepository: { lidMapping: { getPNForLID: async (l) => (l === '5@lid' ? '255700000005:3@s.whatsapp.net' : null) } } };
    ok((await toPN(sock, '9@lid', '255700000009@s.whatsapp.net')) === '255700000009@s.whatsapp.net');
    ok((await toPN(sock, '5@lid')) === '255700000005@s.whatsapp.net');
    ok((await toPN(sock, '7@lid')) === '7@lid');
    ok((await toPN({}, '255700000001:12@s.whatsapp.net')) === '255700000001@s.whatsapp.net');
    ok(normJid('255700000001:12@s.whatsapp.net') === '255700000001@s.whatsapp.net');
  });

  // ---------- pipeline ----------
  const OWNER = '255793157892@s.whatsapp.net';
  const STRANGER = '255711111111@s.whatsapp.net';
  const ADMIN = '255700000010@s.whatsapp.net';
  const BOT = '15551234567:5@s.whatsapp.net';
  const GROUP = '1203@g.us';
  const OWNER_LID = '111222333@lid';

  async function setup({ mode = 'public', botAdmin = true, mapping = true } = {}) {
    const calls = [];
    const store = createStore(fakeCollection());
    const config = { botName: 'DARKEN', prefix: '!', ownerNumber: '255793157892', ownerName: 'Owner', packName: 'DARKEN', author: 'DARKEN', timezone: 'Africa/Dar_es_Salaam', mode, version: '1.0.0' };
    const sock = {
      user: { id: BOT },
      signalRepository: mapping ? { lidMapping: { getPNForLID: async (l) => (l === OWNER_LID ? OWNER : null) } } : undefined,
      sendMessage: async (jid, content, opts) => { calls.push({ jid, content, opts }); return { key: { id: opts.messageId, remoteJid: jid } }; },
      groupMetadata: async () => ({
        id: GROUP, subject: 'Test Group', owner: OWNER_LID, ownerPn: OWNER, desc: 'hello', announce: false, restrict: false,
        participants: [
          { id: OWNER_LID, phoneNumber: OWNER, admin: 'superadmin' },
          { id: ADMIN, admin: 'admin' },
          { id: STRANGER },
          { id: '255722222222@s.whatsapp.net' },
          { id: BOT, admin: botAdmin ? 'admin' : null },
        ],
      }),
      groupParticipantsUpdate: async (jid, list, action) => { calls.push({ jid, participants: list, action }); return list.map(() => ({ status: '200' })); },
      readMessages: async (keys) => calls.push({ read: keys }),
      updateProfileStatus: async () => {},
    };
    const mediaStub = { download: async (raw) => (raw && raw.message && raw.message.imageMessage ? { type: 'image', buffer: Buffer.from('img'), mimetype: 'image/jpeg' } : null) };
    const dl = await new Deloop({ path: DELOOP_DIR, log: quiet }).init();
    dl.hooks.automation.invalidate();
    let restarted = false;
    const handler = createHandler({ sock, store, config, deloop: dl, media: mediaStub, startedAt: Date.now() - 5000, log: { ...quiet, error: (m) => calls.push({ logged: m }) }, restart: () => { restarted = true; } });
    let n = 0;
    const id = () => `MSG${++n}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const now = () => Math.floor(Date.now() / 1000);
    return {
      calls, store, config, handler, sock, deloop: dl, id, wasRestarted: () => restarted,
      dm: (from, text, extra = {}) => ({ key: { remoteJid: from, id: id(), fromMe: false }, message: { conversation: text }, messageTimestamp: now(), pushName: 'Tester', ...extra }),
      grp: (participant, text, extra = {}) => ({ key: { remoteJid: GROUP, id: id(), fromMe: false, participant, ...(extra.key || {}) }, message: extra.message || { conversation: text }, messageTimestamp: now(), pushName: 'Tester' }),
      texts: () => calls.map((c) => (c.content && (c.content.text || c.content.caption)) || '').filter(Boolean).join(' | '),
    };
  }

  console.log('Pipeline: commands and permissions');
  await t('a stranger can use a public command in a DM', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(STRANGER, '!ping'));
    ok(s.calls.some((c) => c.jid === STRANGER && /Pinging/.test(c.content.text || '')) && s.calls.some((c) => c.content && c.content.edit));
  });
  await t('arguments reach the command intact (poll, with | separators)', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(STRANGER, '!poll Best fruit? | Mango | Banana | Pineapple'));
    const p = s.calls.find((c) => c.content && c.content.poll);
    ok(p && p.content.poll.name === 'Best fruit?' && p.content.poll.values.length === 3);
  });
  await t('prefix with extra spaces and upper-case command names work', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(STRANGER, '!  PING'));
    ok(s.calls.length >= 1);
  });
  await t('owner-only command: refused for a stranger, allowed for the owner', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(STRANGER, '!mode private'));
    ok(/owner only/.test(s.texts()) && s.config.mode === 'public');
    const s2 = await setup();
    await s2.handler.onMessage(s2.dm(OWNER, '!mode private'));
    ok(s2.config.mode === 'private' && /Mode set/.test(s2.texts()));
  });
  await t('group-only command in a DM, and admin-only command for a non-admin', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(STRANGER, '!groupinfo'));
    ok(/only works in groups/.test(s.texts()));
    const s2 = await setup();
    await s2.handler.onMessage(s2.grp(STRANGER, '!tagall hi'));
    ok(/Only group admins/.test(s2.texts()));
  });
  await t('a group admin can run an admin command (tagall mentions everyone)', async () => {
    const s = await setup();
    await s.handler.onMessage(s.grp(ADMIN, '!tagall meeting at 5'));
    const c = s.calls.find((x) => x.content && x.content.mentions);
    ok(c && c.content.mentions.length === 5 && /meeting at 5/.test(c.content.text));
  });
  await t('unknown commands and plain chat are ignored silently', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(STRANGER, '!doesnotexist'));
    await s.handler.onMessage(s.dm(STRANGER, 'hello there'));
    ok(s.calls.length === 0);
  });
  await t('a crashing command gives a short error, not a stack trace', async () => {
    const s = await setup();
    s.deloop.commands.set('boom', { name: 'boom', category: 'x', description: 'x', run: async () => { throw new Error('kaboom'); } });
    await s.handler.onMessage(s.dm(STRANGER, '!boom'));
    ok(/Something went wrong: kaboom/.test(s.texts()) && !/at .*\.js/.test(s.texts()));
    ok(s.calls.some((c) => c.logged && /kaboom/.test(c.logged)));
  });
  await t('private mode blocks strangers but not the owner', async () => {
    const s = await setup({ mode: 'private' });
    await s.handler.onMessage(s.dm(STRANGER, '!ping'));
    ok(s.calls.length === 0);
    await s.handler.onMessage(s.dm(OWNER, '!ping'));
    ok(s.calls.length > 0);
  });
  await t('banned users are ignored', async () => {
    const s = await setup();
    await s.store.set('banned', STRANGER, true);
    await s.handler.onMessage(s.dm(STRANGER, '!ping'));
    ok(s.calls.length === 0);
    await s.handler.onMessage(s.dm(OWNER, '!ping'));
    ok(s.calls.length > 0);
  });
  await t('sudo users may run admin commands without being group admins', async () => {
    const s = await setup();
    await s.store.set('sudo', STRANGER, true);
    await s.handler.onMessage(s.grp(STRANGER, '!tagall hi'));
    ok(s.calls.some((c) => c.content && c.content.mentions));
  });
  await t('command usage is counted', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(STRANGER, '!alive'));
    await s.handler.onMessage(s.dm(STRANGER, '!alive'));
    await new Promise((r) => setTimeout(r, 20));
    ok((await s.store.get('usage', STRANGER, 0)) === 2);
  });
  await t('quoted text and mentions are passed to commands', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(STRANGER, '!fancy 1', { message: { extendedTextMessage: { text: '!fancy 1', contextInfo: { stanzaId: 'Q1', participant: OWNER, quotedMessage: { conversation: 'hello' } } } } }));
    ok(/𝐡𝐞𝐥𝐥𝐨/.test(s.texts()));
    const s2 = await setup();
    await s2.handler.onMessage(s2.grp(OWNER, '!kick @255722222222', { message: { extendedTextMessage: { text: '!kick @255722222222', contextInfo: { mentionedJid: ['255722222222@s.whatsapp.net'] } } } }));
    ok(s2.calls.some((c) => c.action === 'remove' && c.participants[0] === '255722222222@s.whatsapp.net'));
  });
  await t('getMedia finds media in the message itself', async () => {
    const s = await setup();
    s.deloop.commands.set('mediatest', { name: 'mediatest', category: 'x', description: 'x', run: async (ctx) => { const m = await ctx.getMedia(); await ctx.reply(m ? `media:${m.type}` : 'none'); } });
    await s.handler.onMessage(s.dm(STRANGER, '', { message: { imageMessage: { caption: '!mediatest' } } }));
    ok(/media:image/.test(s.texts()));
  });
  await t('settings changed from chat take effect at once (!setprefix)', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(OWNER, '!setprefix .'));
    ok(s.config.prefix === '.' && (await s.store.get('settings', 'prefix')) === '.');
    s.calls.length = 0;
    await s.handler.onMessage(s.dm(STRANGER, '!ping'));
    ok(s.calls.length === 0, 'old prefix still works');
    await s.handler.onMessage(s.dm(STRANGER, '.ping'));
    ok(s.calls.length > 0);
  });
  await t('!update reloads DELOOP; !restart calls the restart hook', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(OWNER, '!update'));
    ok(/Updated\. \d+ commands loaded/.test(s.texts()), s.texts());
    await s.handler.onMessage(s.dm(OWNER, '!restart'));
    ok(s.wasRestarted());
  });

  console.log('Pipeline: the bot ignores itself and old messages');
  await t("the bot's own sent messages are never treated as commands", async () => {
    const s = await setup();
    await s.sock.sendMessage(OWNER, { text: '!ping' }, {}); // goes through the wrapped sendMessage
    const sentId = s.calls[0].opts.messageId;
    const before = s.calls.length;
    await s.handler.onMessage({ key: { remoteJid: OWNER, id: sentId, fromMe: true }, message: { conversation: '!ping' }, messageTimestamp: Math.floor(Date.now() / 1000) });
    ok(s.calls.length === before);
  });
  await t("a command typed on the bot's own phone (fromMe) is accepted as the owner", async () => {
    const s = await setup();
    await s.handler.onMessage({ key: { remoteJid: OWNER, id: 'TYPED1', fromMe: true }, message: { conversation: '!mode private' }, messageTimestamp: Math.floor(Date.now() / 1000) });
    ok(s.config.mode === 'private');
  });
  await t('messages older than a minute are skipped', async () => {
    const s = await setup();
    await s.handler.onMessage(s.dm(STRANGER, '!ping', { messageTimestamp: Math.floor(Date.now() / 1000) - 600 }));
    ok(s.calls.length === 0);
    await s.handler.onMessage(s.dm(STRANGER, '!ping', { messageTimestamp: { toNumber: () => Math.floor(Date.now() / 1000) - 600 } }));
    ok(s.calls.length === 0, 'Long timestamps not handled');
  });

  console.log('Pipeline: hidden-number (LID) accounts');
  await t('owner is recognised through participantAlt', async () => {
    const s = await setup({ mapping: false });
    await s.handler.onMessage(s.grp(OWNER_LID, '!mode private', { key: { participantAlt: OWNER } }));
    ok(s.config.mode === 'private');
  });
  await t('owner is recognised through the LID mapping', async () => {
    const s = await setup();
    await s.handler.onMessage(s.grp(OWNER_LID, '!mode private'));
    ok(s.config.mode === 'private');
  });
  await t('an unknown LID is not mistaken for the owner', async () => {
    const s = await setup();
    await s.handler.onMessage(s.grp('999@lid', '!mode private'));
    ok(s.config.mode === 'public' && /owner only/.test(s.texts()));
  });
  await t('group admins listed by LID are matched by phone number', async () => {
    const s = await setup();
    s.deloop.commands.set('whoami', { name: 'whoami', category: 'x', description: 'x', run: async (ctx) => ctx.reply(`admin:${ctx.isAdmin} botadmin:${ctx.isBotAdmin} owner:${ctx.isOwner}`) });
    await s.handler.onMessage(s.grp(OWNER_LID, '!whoami', { key: { participantAlt: OWNER } }));
    ok(/admin:true botadmin:true owner:true/.test(s.texts()), s.texts());
    const s2 = await setup({ botAdmin: false });
    s2.deloop.commands.set('whoami', s.deloop.commands.get('whoami'));
    await s2.handler.onMessage(s2.grp(STRANGER, '!whoami'));
    ok(/admin:false botadmin:false owner:false/.test(s2.texts()), s2.texts());
  });

  console.log('Pipeline: DELOOP hooks');
  await t('guards delete a link from a non-admin and the command is not run', async () => {
    const s = await setup();
    await s.store.set(`group:${GROUP}`, 'antilink', { enabled: true, action: 'delete' });
    await s.handler.onMessage(s.grp(STRANGER, '!ping http://spam.com'));
    ok(s.calls.some((c) => c.content && c.content.delete) && !/Pinging/.test(s.texts()));
  });
  await t('every group message is counted', async () => {
    const s = await setup();
    await s.handler.onMessage(s.grp(STRANGER, 'hello'));
    await s.handler.onMessage(s.grp(STRANGER, 'hello again'));
    ok((await s.store.get(`stats:${GROUP}`, STRANGER, 0)) === 2);
  });
  await t('automation: autoread marks messages read', async () => {
    const s = await setup();
    await s.store.set('settings', 'autoread', { enabled: true });
    s.deloop.hooks.automation.invalidate();
    await s.handler.onMessage(s.dm(STRANGER, 'hi'));
    ok(s.calls.some((c) => c.read));
  });
  await t('automation: antidelete re-posts a message after its revoke notice', async () => {
    const s = await setup();
    await s.store.set('settings', 'antidelete', { enabled: true, mode: 'chat' });
    s.deloop.hooks.automation.invalidate();
    const m = s.grp(STRANGER, 'I will delete this');
    await s.handler.onMessage(m);
    await s.handler.onMessage(s.grp(STRANGER, '', { message: { protocolMessage: { type: 0, key: { remoteJid: GROUP, id: m.key.id, participant: STRANGER } } } }));
    ok(/Deleted message/.test(s.texts()) && /I will delete this/.test(s.texts()), s.texts());
  });
  await t('status updates go to the status hooks, not the command pipeline', async () => {
    const s = await setup();
    await s.store.set('settings', 'autostatus', { enabled: true });
    s.deloop.hooks.automation.invalidate();
    await s.handler.onMessage({ key: { remoteJid: 'status@broadcast', id: 'ST1', participant: STRANGER, fromMe: false }, message: { conversation: '!ping' }, messageTimestamp: Math.floor(Date.now() / 1000) });
    ok(s.calls.some((c) => c.read) && !/Pinging/.test(s.texts()));
  });
  await t('group events: welcome message on join', async () => {
    const s = await setup();
    await s.store.set(`group:${GROUP}`, 'welcome', { enabled: true });
    await s.handler.onParticipants({ id: GROUP, action: 'add', participants: ['255733333333@s.whatsapp.net'] });
    ok(/Welcome @255733333333 to \*Test Group\*/.test(s.texts()), s.texts());
  });
  await t('the minute tick reaches DELOOP (scheduled message goes out)', async () => {
    const s = await setup();
    await s.store.set('schedule', 'abc123', { id: 'abc123', to: GROUP, text: 'scheduled hello', at: Date.now() - 1000, tries: 0 });
    await s.handler.tick();
    ok(/scheduled hello/.test(s.texts()));
  });
  await t('a failing hook is logged and does not stop commands', async () => {
    const s = await setup();
    s.deloop.hooks.automation.onMessage = async () => { throw new Error('hook exploded'); };
    await s.handler.onMessage(s.dm(STRANGER, '!alive'));
    ok(/alive/.test(s.texts()) && s.calls.some((c) => c.logged && /hook exploded/.test(c.logged)));
  });

  console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nAll ${passed} DARKEN checks passed`);
  process.exit(failed ? 1 : 0);
})();
