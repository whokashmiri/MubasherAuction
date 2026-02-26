function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanWait(minMs = 300, maxMs = 1200) {
  await sleep(randInt(minMs, maxMs));
}

function hours(h) {
  return h * 60 * 60 * 1000;
}

module.exports = { sleep, humanWait, randInt, hours };
