'use strict';
/* Test helpers: a temporary data folder, and a way to load a module with the
 * network layer replaced by canned responses, so unit tests never touch the
 * internet. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leads-test-'));
}

/* routes: { 'url-substring': string | object | Error | (url) => any }.
   Clears the module cache for everything under src/ so each call gets
   modules bound to this fake. */
function withFakeHttp(routes) {
  for (const key of Object.keys(require.cache)) if (key.startsWith(SRC)) delete require.cache[key];
  const real = require(path.join(SRC, 'http.js'));
  const calls = [];
  const resolve = url => {
    calls.push(url);
    const hit = Object.keys(routes).find(k => url.includes(k));
    if (!hit) {
      const err = new real.FetchError('No fake response for ' + url, { status: 404, url });
      throw err;
    }
    const v = typeof routes[hit] === 'function' ? routes[hit](url) : routes[hit];
    if (v instanceof Error) throw v;
    return v;
  };
  real.getText = async url => { const v = resolve(url); return typeof v === 'string' ? v : JSON.stringify(v); };
  real.getJson = async url => { const v = resolve(url); return typeof v === 'string' ? JSON.parse(v) : v; };
  return { calls, load: rel => require(path.join(SRC, rel)), FetchError: real.FetchError };
}

function fresh(rel) {
  for (const key of Object.keys(require.cache)) if (key.startsWith(SRC)) delete require.cache[key];
  return require(path.join(SRC, rel));
}

module.exports = { tempDir, withFakeHttp, fresh };
