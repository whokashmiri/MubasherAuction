function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function makeLogger(scope) {
  const pref = `[${scope}]`;
  return {
    info: (msg, meta) => console.log(`${ts()} ${pref} ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`${ts()} ${pref} ${msg}`, meta ?? ''),
    error: (msg, meta) => console.error(`${ts()} ${pref} ${msg}`, meta ?? ''),
    debug: (msg, meta) => console.log(`${ts()} ${pref} ${msg}`, meta ?? '')
  };
}

module.exports = { makeLogger };
