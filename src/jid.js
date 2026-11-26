'use strict';
// "2557...:12@s.whatsapp.net" -> "2557...@s.whatsapp.net"
const normJid = (jid = '') => {
  const [user, server] = String(jid).split('@');
  return `${user.split(':')[0]}@${server || 's.whatsapp.net'}`;
};
const jidNumber = (jid = '') => String(jid).split('@')[0].split(':')[0];
const isLid = (jid) => String(jid || '').endsWith('@lid');

// WhatsApp now hides numbers behind "@lid" ids. Commands compare phone numbers, so
// every JID handed to them is converted back to a phone JID whenever it can be.
async function toPN(sock, jid, alt) {
  if (!jid) return jid;
  if (!isLid(jid)) return normJid(jid);
  if (alt && !isLid(alt)) return normJid(alt);
  const map = sock.signalRepository && sock.signalRepository.lidMapping;
  if (map && map.getPNForLID) {
    try {
      const pn = await map.getPNForLID(normJid(jid));
      if (pn) return normJid(pn);
    } catch {}
  }
  return normJid(jid);
}

module.exports = { normJid, jidNumber, isLid, toPN };
