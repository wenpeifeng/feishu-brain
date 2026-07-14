const fs = require('fs');
const path = require('path');

function loadEnv(filePath = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes
    value = value.replace(/^["'](.*)["']$/, '$1');
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv();
module.exports = { loadEnv };
