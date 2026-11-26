'use strict';
const { unwrap, MEDIA } = require('./msg');

function createMedia({ B, sock, log = console }) {
  // Downloads the media of a raw message. Returns null when it has none or the download fails.
  async function download(raw) {
    if (!raw || !raw.message) return null;
    const m = unwrap(raw.message);
    const type = Object.keys(m).find((k) => MEDIA[k]);
    if (!type) return null;
    const c = m[type];
    try {
      const buffer = await B.downloadMediaMessage(raw, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
      return { type: MEDIA[type], buffer, mimetype: c.mimetype, seconds: c.seconds || 0, fileName: c.fileName };
    } catch (e) {
      log.warn && log.warn(`[media] download failed: ${e.message}`);
      return null;
    }
  }
  return { download };
}

module.exports = { createMedia };
