const { MongoClient } = require('mongodb');

let _client = null;

async function getCollection(settings, log) {
  if (!_client) {
    log.info('Connecting to MongoDB...');
    _client = new MongoClient(settings.mongoUri, {
      maxPoolSize: 10
    });
    await _client.connect();
    log.info('MongoDB connected');
  }
  const db = _client.db(settings.dbName);
  const col = db.collection(settings.collectionName);
  await col.createIndex({ scrapedAt: -1 });
  return col;
}

async function upsertIfNew(col, doc) {
  const id = String(doc._id);
  const res = await col.updateOne(
    { _id: id },
    { $setOnInsert: doc },
    { upsert: true }
  );
  return { inserted: res.upsertedCount === 1 };
}

async function closeMongo(log) {
  if (_client) {
    log.info('Closing MongoDB...');
    await _client.close();
    _client = null;
  }
}

module.exports = { getCollection, upsertIfNew, closeMongo };
