'use strict';
// Key/value store used by DELOOP commands (ctx.store), backed by one MongoDB collection.
// Small, read-mostly namespaces are cached in memory (write-through) so busy groups
// do not cost a database round trip per message.
const CACHED = /^(group:|settings$|banned$|sudo$|mute$|stats_since$)/;

function createStore(collection) {
  const cache = new Map(); // ns -> { key: value }
  const id = (ns, k) => `${ns}\u0001${k}`;

  async function load(ns) {
    if (cache.has(ns)) return cache.get(ns);
    const docs = await collection.find({ ns }).toArray();
    const map = Object.fromEntries(docs.map((d) => [d.k, d.v]));
    cache.set(ns, map);
    return map;
  }

  return {
    async get(ns, k, def = null) {
      if (CACHED.test(ns)) {
        const v = (await load(ns))[k];
        return v === undefined ? def : v;
      }
      const doc = await collection.findOne({ _id: id(ns, k) });
      return doc && doc.v !== undefined ? doc.v : def;
    },
    async set(ns, k, v) {
      await collection.updateOne({ _id: id(ns, k) }, { $set: { ns, k, v } }, { upsert: true });
      if (CACHED.test(ns) && cache.has(ns)) cache.get(ns)[k] = v;
    },
    async incr(ns, k, by = 1) {
      const r = await collection.findOneAndUpdate(
        { _id: id(ns, k) },
        { $inc: { v: by }, $setOnInsert: { ns, k } },
        { upsert: true, returnDocument: 'after' }
      );
      const doc = r && r.value !== undefined ? r.value : r; // driver v5 returned {value}, v6+ returns the doc
      return doc ? doc.v : by;
    },
    async all(ns) {
      if (CACHED.test(ns)) return { ...(await load(ns)) };
      const docs = await collection.find({ ns }).toArray();
      return Object.fromEntries(docs.map((d) => [d.k, d.v]));
    },
    // Everything as { namespace: { key: value } } for !autobackup.
    async export() {
      const out = {};
      for (const d of await collection.find({}).toArray()) (out[d.ns] ||= {})[d.k] = d.v;
      return out;
    },
  };
}

module.exports = { createStore };
