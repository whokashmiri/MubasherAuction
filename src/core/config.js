const dotenv = require('dotenv');
dotenv.config();

function getEnv(name, def = undefined) {
  const v = process.env[name];
  if (v === undefined || v === null) return def;
  const s = String(v).trim();
  return s.length ? s : def;
}

function getEnvInt(name, def) {
  const v = getEnv(name);
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function getEnvBool(name, def) {
  const v = getEnv(name);
  if (!v) return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v.toLowerCase());
}

function requireEnv(name) {
  const v = getEnv(name);
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function getSettings() {
  return {
    startUrl: getEnv('START_URL', 'https://re.mobasher.sa/?cat=motors'),
    loginUrl: getEnv('LOGIN_URL', 'https://mobasher.sa/ar/login'),

    headless: getEnvBool('HEADLESS', false),

    email: getEnv('MOBASHER_EMAIL', ''),
    password: getEnv('MOBASHER_PASSWORD', ''),

    mongoUri: requireEnv('MONGO_URI'),
    dbName: getEnv('DB_NAME', 'projectForever'),
    collectionName: getEnv('COLLECTION', 'mobasherEndedItems'),

    checkIntervalHours: getEnvInt('CHECK_INTERVAL_HOURS', 24),
    itemConcurrency: getEnvInt('ITEM_CONCURRENCY', 2),

    navTimeoutMs: getEnvInt('NAV_TIMEOUT_MS', 60000),
    opTimeoutMs: getEnvInt('OP_TIMEOUT_MS', 45000)
  };
}

module.exports = { getSettings };
