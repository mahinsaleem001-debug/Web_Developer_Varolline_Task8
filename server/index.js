'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
try { process.loadEnvFile && fs.existsSync('.env') && process.loadEnvFile('.env'); } catch (e) { /* optional */ }
const { createApp } = require('./app');
const { Store } = require('./db');

const file = path.resolve(process.env.DATA_FILE || 'data/db.json');
fs.mkdirSync(path.dirname(file), { recursive: true });

// JWT secret: from the environment, else generated once and kept next to the database.
let secret = process.env.JWT_SECRET;
if (!secret) {
  const sf = path.join(path.dirname(file), '.secret');
  if (fs.existsSync(sf)) secret = fs.readFileSync(sf, 'utf8').trim();
  else { secret = crypto.randomBytes(48).toString('hex'); fs.writeFileSync(sf, secret, { mode: 0o600 }); }
}

const port = Number(process.env.PORT) || 3000;
const app = createApp({ store: new Store(file), secret });
const server = app.listen(port, () => {
  console.log('Taskflow Live running at http://localhost:' + port);
});
// Close open live streams on Ctrl+C so the server can stop at once.
['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => { app.hub.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); }));
