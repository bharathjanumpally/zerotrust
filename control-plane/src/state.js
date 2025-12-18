const fs = require('fs');
const path = require('path');

const SANDBOX_PATH = path.join(__dirname, '..', 'sandbox_state.json');
const TWIN_PATH = path.join(__dirname, '..', 'twin_state.json');

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function getSandbox() {
  return readJSON(SANDBOX_PATH, { changes: [], current: {} });
}

function saveSandbox(s) {
  writeJSON(SANDBOX_PATH, s);
}

function getTwin(defaultTwin) {
  const fallback = defaultTwin();
  const loaded = readJSON(TWIN_PATH, fallback);
  // Basic shape validation: if it's empty or missing key fields, use fallback.
  if (!loaded || typeof loaded !== 'object') return fallback;
  if (!loaded.services || !loaded.iam) return fallback;
  return loaded;
}

function saveTwin(twin) {
  writeJSON(TWIN_PATH, twin);
}

module.exports = {
  getSandbox,
  saveSandbox,
  getTwin,
  saveTwin
};
