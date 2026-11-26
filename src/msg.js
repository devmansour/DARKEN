'use strict';
const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage',
];
const MEDIA = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', stickerMessage: 'sticker', documentMessage: 'document' };
const SKIP = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);

function unwrap(message) {
  let m = message || {};
  for (let i = 0; i < 5; i++) {
    const w = WRAPPERS.find((k) => m[k]);
    if (!w) break;
    m = m[w].message || {};
  }
  return m;
}

const typeOf = (message) => Object.keys(unwrap(message)).find((k) => !SKIP.has(k)) || null;

function textOf(message) {
  const m = unwrap(message);
  const t = typeOf(message);
  if (!t) return '';
  if (t === 'conversation') return m.conversation || '';
  const c = m[t];
  return (c && typeof c === 'object' && (c.text || c.caption || c.selectedDisplayText || c.selectedButtonId)) || '';
}

function contextInfoOf(message) {
  const m = unwrap(message);
  for (const v of Object.values(m)) if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  return null;
}

const tsOf = (t) => (t && typeof t === 'object' ? (t.toNumber ? t.toNumber() : Number(t)) : Number(t) || 0);

module.exports = { unwrap, typeOf, textOf, contextInfoOf, tsOf, MEDIA };
