'use strict';
const http = require('http');

// Tiny HTTP server: Render needs an open port, and the self-ping keeps a free instance awake.
function startHealth({ port, getStatus, selfUrl, log = console }) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
  });
  server.listen(port, () => log.info(`[health] listening on :${port}`));
  let timer = null;
  if (selfUrl) {
    timer = setInterval(() => fetch(selfUrl).catch(() => {}), 10 * 60000);
    timer.unref();
  }
  return { server, close: () => { if (timer) clearInterval(timer); server.close(); } };
}

module.exports = { startHealth };
