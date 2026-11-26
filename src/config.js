'use strict';
const pkg = require('../package.json');

function fromEnv(env = process.env) {
  const need = (k) => {
    if (!env[k]) throw new Error(`Missing environment variable ${k}. See .env.example.`);
    return env[k];
  };
  const mongoUri = need('MONGO_URI');
  const owner = need('OWNER_NUMBER').replace(/\D/g, '');
  if (owner.length < 8) throw new Error('OWNER_NUMBER must be a full phone number with country code, digits only.');
  const deloop = {
    path: env.DELOOP_PATH || '',
    repo: env.DELOOP_REPO || '',
    token: env.DELOOP_TOKEN || '',
    branch: env.DELOOP_BRANCH || 'main',
  };
  if (!deloop.path && !(deloop.repo && deloop.token)) {
    throw new Error('Set DELOOP_PATH (local) or both DELOOP_REPO and DELOOP_TOKEN (GitHub). See .env.example.');
  }
  const botName = env.BOT_NAME || 'DARKEN';
  return {
    runtime: {
      mongoUri,
      mongoDb: env.MONGO_DB || 'darken',
      sessionId: env.SESSION_ID || 'darken',
      port: Number(env.PORT) || 3000,
      selfUrl: env.RENDER_EXTERNAL_URL || env.SELF_URL || '',
      logLevel: env.LOG_LEVEL || 'silent',
      deloop,
    },
    config: {
      botName,
      prefix: env.PREFIX || '!',
      ownerNumber: owner,
      ownerName: env.OWNER_NAME || 'Owner',
      packName: env.PACK_NAME || botName,
      author: env.AUTHOR || env.OWNER_NAME || botName,
      timezone: env.TIMEZONE || 'Africa/Dar_es_Salaam',
      mode: 'public',
      version: pkg.version,
      pairUrl: env.PAIR_URL || '',
    },
  };
}

// Settings changed from WhatsApp (!setprefix, !setbotname, !mode) win over env values.
function applySettings(config, settings = {}) {
  for (const k of ['prefix', 'botName', 'mode']) {
    if (typeof settings[k] === 'string' && settings[k]) config[k] = settings[k];
  }
  return config;
}

module.exports = { fromEnv, applySettings };
