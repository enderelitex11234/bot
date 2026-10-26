const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('project declares test and startup scripts', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts.start, 'node src/index.js');
  assert.equal(pkg.scripts.test, 'node --test');
});

test('environment example does not contain real credentials', () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(env, /DISCORD_TOKEN=put_your_bot_token_here/);
  assert.doesNotMatch(env, /[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{5,}\./);
});

let sqliteAvailable = true;
try { require.resolve('better-sqlite3'); } catch { sqliteAvailable = false; }

test('SQLite database supports unique transaction IDs and nonnegative wallet constraint', { skip: sqliteAvailable ? false : 'better-sqlite3 is not installed; run npm install first' }, () => {
  const Database = require('better-sqlite3');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vortexia-test-'));
  const db = new Database(path.join(tmp, 'test.sqlite'));
  db.exec(`
    CREATE TABLE transaction_ids (transaction_id TEXT PRIMARY KEY);
    CREATE TABLE wallets (balance INTEGER CHECK(balance >= 0));
  `);
  db.prepare('INSERT INTO transaction_ids VALUES(?)').run('TX-ONE');
  assert.throws(() => db.prepare('INSERT INTO transaction_ids VALUES(?)').run('TX-ONE'));
  assert.throws(() => db.prepare('INSERT INTO wallets VALUES(?)').run(-1));
  db.close();
  fs.rmSync(tmp, {recursive:true,force:true});
});


test('requested command names and safety controls are present in source', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands.js'), 'utf8');
  for (const name of ['dm','dmall','ping','redeem','uptime','botinfo','serverinfo','userinfo','avatar','announce','embed','say','help','purge','warn','lock','stock','payment-status','order-info','maintenance','delivery','dm-optout','admin-coupon-create','reseller-transactions','reseller-withdraw','leaderboard','admin-withdrawals','admin-withdrawal-review']) {
    assert.ok(source.includes(`setName('${name}')`), `missing /${name}`);
  }
  assert.match(source, /opted_out/);
  assert.match(source, /10\*60\*1000/);
  assert.match(source, /PENDING_PAYMENT/);
  assert.match(source, /reseller_withdrawals/);
  assert.match(source, /Only approved resellers can request withdrawals/);
  assert.match(source, /Ranked by recorded positive wallet transaction volume/);
});


test('interactive professional embed builder and component handlers are present', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'embed-builder.js'), 'utf8');
  const commands = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands.js'), 'utf8');
  for (const control of ['Title','Description','Color','Image','Thumbnail','Footer','Author','Add Field','Buttons','Title URL','Timestamp ON','Clear Fields','Publish','Reset','Close']) {
    assert.ok(source.includes(control), `missing builder control ${control}`);
  }
  assert.match(source, /setCustomId\(`eb:/);
  assert.match(source, /setCustomId\(`ebm:/);
  assert.match(source, /u\.protocol !== 'https:'/);
  assert.match(commands, /Open the interactive Vortexia Embed Builder/);
  assert.match(commands, /handleComponent: embedBuilder\.handle/);
});


test('slash command registry stays within Discord limit and includes compatibility commands', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands.js'), 'utf8');
  assert.match(source, /commands\.length > 100/);
  assert.match(source, /Duplicate slash command names detected/);
  // Load the real registry with throwaway env values and a temp database (never touches your real data).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vortexia-core-'));
  const env = { ...process.env, DISCORD_TOKEN: 'test.token.value', CLIENT_ID: '123456789012345678', DB_PATH: path.join(tmp, 'core.sqlite') };
  const out = require('node:child_process').execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/commands').commands.map(c=>c.name)))"], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  const names = JSON.parse(out.trim().split('\n').pop());
  assert.ok(names.length <= 100, `too many commands: ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'duplicate command names');
  for (const name of ['commands','product-list','product-info','product-search','product-categories','product-stock','product-price','featured-products','new-products','popular-products','order-history','order-status','payment-info','payment-help','reseller-info','reseller-balance','reseller-sales','wallet','balance','transactions','withdraw-status','withdraw-history','support','feedback','database-backup','database-status','bot-diagnostics','system-status']) {
    assert.ok(names.includes(name), `missing /${name}`);
  }
  assert.match(source, /Payment submissions require independent verification/);
  assert.match(source, /does not create a support ticket/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
