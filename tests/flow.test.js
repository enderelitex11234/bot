// End-to-end command flow tests (mocked Discord, real SQLite in a temp folder).
const test = require('node:test');
const assert = require('node:assert/strict');
const { IDS, setupEnv, makeWorld } = require('./mock-discord');
const tmpDir = setupEnv();
// Run inside the temp folder so tests never read your real .env or write backups into your project.
process.chdir(tmpDir);
const { commands, handle, handleShopComponent, handleComponent } = require('../src/commands');
const db = require('../src/db');
const w = makeWorld();
const { ADMIN, USER, RESELLER, RESELLER_ROLE } = IDS;
const run = async (name, opts, who, roles) => { const i = w.command(name, opts, who, roles); await handle(i, w.client); return i; };
const reply = i => w.text(i.replies[0] || '');
test.after(() => { assert.deepEqual(w.violations, [], 'a payload would be rejected by the real Discord API'); });

test('registry: within Discord limit, unique names, valid names/descriptions', () => {
  assert.ok(commands.length <= 100);
  assert.equal(new Set(commands.map(c => c.name)).size, commands.length);
  for (const c of commands) { assert.match(c.name, /^[\w-]{1,32}$/); assert.ok(c.description.length >= 1 && c.description.length <= 100, c.name); }
  for (const name of ['commands', 'product-list', 'wallet', 'balance', 'system-status', 'support', 'feedback', 'admin-reseller-set', 'admin-wallet-credit']) assert.ok(commands.some(c => c.name === name), `missing /${name}`);
});

test('non-admins cannot use any admin command, including through aliases', async () => {
  for (const c of commands.filter(c => /^admin-/.test(c.name) || ['dm', 'dmall', 'delivery', 'announce', 'say', 'purge', 'warn', 'lock', 'maintenance', 'database-backup', 'database-status'].includes(c.name))) {
    const i = await run(c.name, { user: USER, message: 'x', channel: 'c', amount: 1, action: 'on', product: 'x' }, USER);
    assert.match(reply(i), /not authorized/i, `/${c.name} was not blocked for a normal user`);
  }
});

test('admin can create products with reseller price and stock; /shop lists them', async () => {
  let i = await run('admin-product-add', { name: 'Hypixel Unban', price: 500, reseller_price: 400, description: 'Unban', category: 'Hypixel' }, ADMIN);
  assert.match(reply(i), /Product created/);
  await run('admin-product-add', { name: 'Donut Cape', price: 300, description: 'cape', category: 'Capes' }, ADMIN);
  await run('admin-product-add', { name: 'DonutSMP Money', price: 200, description: 'in-game money', category: 'DonutSMP', reseller_price: 150 }, ADMIN);
  for (const v of ['A-1', 'A-2', 'A-3', 'A-4']) await run('admin-stock-add', { product_id: 1, value: v }, ADMIN);
  await run('admin-stock-add', { product_id: 2, value: 'CAPE-1' }, ADMIN);
  i = await run('shop');
  assert.match(reply(i), /Hypixel Unban/); assert.match(reply(i), /৳500/);
  assert.ok(!reply(i).includes('৳400'), 'retail /shop must not leak reseller price');
});

test('shop buttons: purchase / hypixel / donut / capes work', async () => {
  const run1 = async id => { const b = w.button(`vortex_shop:${id}`); await handleShopComponent(b); return reply(b); };
  assert.match(await run1('purchase'), /\/buy/);
  const hyp = await run1('hypixel'); assert.match(hyp, /Hypixel Unban/); assert.ok(!/Donut Cape/.test(hyp));
  const cape = await run1('capes'); assert.match(cape, /Donut Cape/); assert.ok(!/Hypixel Unban/.test(cape));
  assert.match(await run1('donut'), /DonutSMP Money/);
  assert.match(await run1('does-not-exist'), /no longer available/);
});

test('reseller price button: hidden from normal users, shown to role holders and admins', async () => {
  let b = w.button('vortex_shop:reseller', USER); await handleShopComponent(b);
  assert.match(reply(b), /only visible to members with the reseller role/);
  b = w.button('vortex_shop:reseller', RESELLER, [RESELLER_ROLE]); await handleShopComponent(b);
  assert.match(reply(b), /৳400/); assert.match(reply(b), /Hypixel Unban/);
  b = w.button('vortex_shop:reseller', ADMIN); await handleShopComponent(b);
  assert.match(reply(b), /৳400/);
});

test('shop never overflows Discord limits with many/long products', async () => {
  for (let n = 1; n <= 25; n++) await run('admin-product-add', { name: `Bulk Product ${n}`, price: 10 + n, description: 'x'.repeat(300), category: 'Bulk' }, ADMIN);
  for (const name of ['shop', 'search', 'product-list']) { const i = await run(name, { query: 'Bulk' }); assert.ok(i.replies.length === 1, name); }
  assert.match(reply(await run('shop')), /and \d+ more/);
});

test('full order flow: buy -> pay -> approve -> deliver', async () => {
  let i = await run('buy', { product_id: 1, quantity: 2 });
  const orderId = reply(i).match(/VX-[A-Z0-9]+-[A-F0-9]+/)[0];
  assert.match(reply(i), /৳1000/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_stock WHERE product_id=1 AND status='RESERVED'").get().n, 2);
  assert.match(reply(await run('payment-methods')), /01700000000/);
  i = await run('payment-submit', { order_id: orderId, method: 'bKash', transaction_id: 'TXN-UNIQUE-1' });
  assert.match(reply(i), /Payment submitted/);
  const paymentId = db.prepare('SELECT id FROM payments WHERE order_id=?').get(orderId).id;
  assert.match(reply(await run('payment-submit', { order_id: orderId, method: 'bKash', transaction_id: 'txn-unique-1' })), /already been submitted/);
  assert.match(reply(await run('admin-orders', {}, ADMIN)), new RegExp(orderId));
  assert.match(reply(await run('admin-approve', { payment_id: paymentId, reason: 'checked' }, USER)), /not authorized/);
  assert.match(reply(await run('admin-approve', { payment_id: paymentId, reason: 'checked' }, ADMIN)), /approved/i);
  assert.match(reply(await run('admin-deliver', { order_id: orderId }, ADMIN)), /Delivery completed/);
  const dmText = w.users[USER].sent.map(m => (typeof m === 'string' ? m : m.content || '')).join('\n');
  assert.ok(dmText.includes('A-1') && dmText.includes('A-2'), 'customer should receive both secrets by DM');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(orderId).status, 'DELIVERED');
  assert.match(reply(await run('track-order', { order_id: orderId })), /DELIVERED/);
  assert.match(reply(await run('order-status', { order_id: orderId })), /DELIVERED/, 'alias works');
  assert.match(reply(await run('admin-stats', {}, ADMIN)), /Delivered/);
});

test('buy rejects when stock is insufficient and when maintenance is on', async () => {
  assert.match(reply(await run('buy', { product_id: 1, quantity: 5 })), /Not enough stock/);
  await run('maintenance', { action: 'on' }, ADMIN);
  assert.match(reply(await run('buy', { product_id: 1, quantity: 1 })), /maintenance/);
  const b = w.button('vortex_shop:hypixel'); await handleShopComponent(b); assert.match(reply(b), /maintenance/);
  await run('maintenance', { action: 'off' }, ADMIN);
});

test('coupons: create, redeem once per order, total reduced', async () => {
  await run('admin-coupon-create', { code: 'SAVE10', kind: 'PERCENT', amount: 10 }, ADMIN);
  const orderId = reply(await run('buy', { product_id: 2, quantity: 1 })).match(/VX-[A-Z0-9]+-[A-F0-9]+/)[0];
  assert.match(reply(await run('redeem', { code: 'save10', order_id: orderId })), /New order total: \*\*৳270\*\*/);
  assert.match(reply(await run('redeem', { code: 'SAVE10', order_id: orderId })), /already applied/);
});

test('reseller wallet flow end to end', async () => {
  assert.match(reply(await run('reseller-transactions', {}, RESELLER)), /approved resellers only/);
  assert.match(reply(await run('wallet', {}, RESELLER)), /approved resellers only/, 'alias');
  assert.match(reply(await run('admin-reseller-set', { user: RESELLER, status: 'APPROVED' }, ADMIN)), /APPROVED/);
  assert.match(reply(await run('admin-wallet-credit', { user: RESELLER, amount: 1000, note: 'topup' }, ADMIN)), /New balance: \*\*৳1000\*\*/);
  assert.match(reply(await run('balance', {}, RESELLER)), /৳1000/);
  assert.match(reply(await run('reseller-withdraw', { amount: 5000, method: 'bKash', payout_details: '01700000000' }, RESELLER)), /Insufficient/);
  const r = await run('reseller-withdraw', { amount: 400, method: 'bKash', payout_details: '01700000000' }, RESELLER);
  assert.match(reply(r), /Withdrawal request \*\*#1\*\*/);
  assert.match(reply(await run('admin-withdrawals', {}, ADMIN)), /#1/);
  assert.match(reply(await run('admin-withdrawal-review', { request_id: 1, decision: 'APPROVED', note: 'ok' }, ADMIN)), /Wallet balance deducted/);
  assert.equal(db.prepare('SELECT balance FROM wallets WHERE discord_id=?').get(RESELLER).balance, 600);
  assert.match(reply(await run('admin-withdrawal-review', { request_id: 1, decision: 'PAID' }, ADMIN)), /marked PAID/);
  assert.match(reply(await run('leaderboard')), new RegExp(RESELLER));
  assert.match(reply(await run('admin-reseller-set', { user: RESELLER, status: 'SUSPENDED' }, ADMIN)), /SUSPENDED/);
  assert.match(reply(await run('reseller-withdraw', { amount: 1, method: 'bKash', payout_details: '01700000000' }, RESELLER)), /Only approved resellers/);
});

test('admin utilities: dm, delivery, dmall, announce, say, purge, warn, lock, backup', async () => {
  assert.match(reply(await run('dm', { user: USER, message: 'hi' }, ADMIN)), /DM sent/);
  assert.match(reply(await run('delivery', { user: USER, product: 'key-123' }, ADMIN)), /sent successfully/);
  assert.match(reply(await run('dmall', { message: 'sale' }, ADMIN)), /DM batch complete/);
  assert.match(reply(await run('dmall', { message: 'again' }, ADMIN)), /rate-limited/);
  assert.match(reply(await run('announce', { channel: 'c', message: 'news' }, ADMIN)), /posted/);
  assert.match(reply(await run('say', { channel: 'c', message: 'hello' }, ADMIN)), /posted/);
  assert.match(reply(await run('purge', { amount: 5 }, ADMIN)), /Deleted 5/);
  assert.match(reply(await run('warn', { user: USER, reason: 'spam' }, ADMIN)), /Warning #1/);
  assert.match(reply(await run('lock', { action: 'lock' }, ADMIN)), /locked/);
  const b = await run('admin-backup', {}, ADMIN); assert.match(reply(b), /Backup created/);
  require('node:fs').rmSync(require('node:path').resolve('./backups'), { recursive: true, force: true });
});

test('embed builder: panel is valid for Discord, product price needs private channel', async () => {
  const i = await run('embed', { channel: 'c' }, ADMIN);
  const rows = i.replies[0].components.map(r => r.toJSON());
  assert.ok(rows.every(r => r.components.length <= 5));
  const press = async id => { const b = w.button(`eb:${id}`, ADMIN); await handleComponent(b); return b; };
  let m = await press('title'); assert.ok(m.modal, 'title opens a modal');
  for (const id of ['description', 'color', 'image', 'thumbnail', 'footer', 'author', 'field', 'links', 'titleurl', 'product']) assert.ok((await press(id)).modal, `${id} opens a modal`);
  let s = w.modal('ebm:title', { value: 'Hello' }); await handleComponent(s); assert.equal(s.replies.length, 1); assert.ok(s.usedUpdate, 'modal submit should refresh the existing panel, not post a new one');
  s = w.modal('ebm:product', { name: 'Cape', photo: '', reseller: '100', retail: '150', stock: 'IN STOCK' }); await handleComponent(s);
  let p = await press('publish'); assert.match(reply(p), /Privacy check failed/);
  // Make the destination private: @everyone denied, reseller role allowed -> publish must now succeed.
  const perm = (allow, deny) => ({ allow: { has: k => allow.includes(k) }, deny: { has: k => deny.includes(k) } });
  w.channel.permissionOverwrites.cache.set(IDS.GUILD, perm([], ['ViewChannel']));
  w.channel.permissionOverwrites.cache.set(RESELLER_ROLE, perm(['ViewChannel'], []));
  const before = w.posted.length;
  p = await press('publish'); assert.match(reply(p), /Embed published/);
  assert.equal(w.posted.length, before + 1, 'embed should be posted to the channel');
  const posted = w.posted.at(-1).embeds[0].toJSON();
  assert.ok(posted.fields.some(f => f.name === 'Reseller Price' && f.value === '৳100'));
  assert.ok(posted.fields.some(f => f.name === 'Price Difference' && f.value === '৳50'));
  w.channel.permissionOverwrites.cache.clear();
  for (const id of ['timestamp', 'profit', 'clearfields', 'reset']) { await handle(w.command('embed', { channel: 'c' }, ADMIN), w.client); assert.equal((await press(id)).replies.length, 1); }
  p = await press('close'); assert.match(reply(p), /closed/);
});

test('ping/uptime/botinfo/serverinfo/userinfo/avatar/help/stock', async () => {
  for (const n of ['ping', 'uptime', 'botinfo', 'serverinfo', 'userinfo', 'avatar', 'help', 'stock', 'categories', 'my-orders', 'support', 'system-status', 'commands']) assert.ok((await run(n)).replies.length > 0, n);
  assert.ok(!/product-list/.test(reply(await run('help'))), 'help hides alias commands');
});

test('every registered command replies to the interaction (no silent commands)', async () => {
  for (const c of commands) {
    const opts = { query: 'x', id: 1, product_id: 1, order_id: 'NOPE', method: 'bKash', transaction_id: 'TXN-1234', message: 'hello', code: 'ABC', value: 'v', user: USER, channel: 'c', amount: 1, reason: 'r', action: 'off', status: 'APPROVED', payout_details: '01700000000', request_id: 1, decision: 'REJECTED', opt_out: false, kind: 'FIXED', name: 'p', price: 1, stock_id: 1, payment_id: 1, product: 'x' };
    const i = await run(c.name, opts, ADMIN);
    assert.ok(i.replies.length > 0, `/${c.name} sent no reply`);
  }
});


test('cancel-order releases stock; admin-reject sends the order back to PENDING_PAYMENT', async () => {
  await run('admin-stock-add', { product_id: 2, value: 'CAPE-2' }, ADMIN);
  const before = db.prepare("SELECT COUNT(*) n FROM product_stock WHERE product_id=2 AND status='AVAILABLE'").get().n;
  const oid = reply(await run('buy', { product_id: 2, quantity: 1 })).match(/VX-[A-Z0-9]+-[A-F0-9]+/)[0];
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_stock WHERE product_id=2 AND status='AVAILABLE'").get().n, before - 1);
  assert.match(reply(await run('cancel-order', { order_id: oid }, RESELLER)), /not found/i, 'other users cannot cancel it');
  assert.match(reply(await run('cancel-order', { order_id: oid })), /cancelled/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_stock WHERE product_id=2 AND status='AVAILABLE'").get().n, before, 'stock is back');
  assert.match(reply(await run('cancel-order', { order_id: oid })), /cannot be cancelled/);
  const o2 = reply(await run('buy', { product_id: 2, quantity: 1 })).match(/VX-[A-Z0-9]+-[A-F0-9]+/)[0];
  await run('payment-submit', { order_id: o2, method: 'Nagad', transaction_id: 'FAKE-TXN-9' });
  const pid = db.prepare('SELECT id FROM payments WHERE order_id=?').get(o2).id;
  assert.match(reply(await run('admin-reject', { payment_id: pid, reason: 'not found' }, USER)), /not authorized/);
  assert.match(reply(await run('admin-reject', { payment_id: pid, reason: 'not found' }, ADMIN)), /rejected/i);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(o2).status, 'PENDING_PAYMENT');
  assert.match(reply(await run('payment-submit', { order_id: o2, method: 'Nagad', transaction_id: 'REAL-TXN-10' })), /Payment submitted/);
});

test('unpaid orders expire automatically and free their stock', async () => {
  const { expireStaleOrders } = require('../src/services');
  await run('admin-stock-add', { product_id: 2, value: 'CAPE-EXP' }, ADMIN);
  const oid = reply(await run('buy', { product_id: 2, quantity: 1 })).match(/VX-[A-Z0-9]+-[A-F0-9]+/)[0];
  assert.deepEqual(expireStaleOrders(60), [], 'a fresh order must not expire');
  db.prepare("UPDATE orders SET created_at=datetime('now','-3 hours') WHERE id=?").run(oid);
  assert.deepEqual(expireStaleOrders(60).map(o => o.id), [oid]);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(oid).status, 'CANCELLED');
});

test('large deliveries are split into several DMs under the 2000 character limit', async () => {
  for (let n = 0; n < 6; n++) await run('admin-stock-add', { product_id: 3, value: `LONG-${n}-` + 'k'.repeat(600) }, ADMIN);
  const oid = reply(await run('buy', { product_id: 3, quantity: 6 })).match(/VX-[A-Z0-9]+-[A-F0-9]+/)[0];
  await run('payment-submit', { order_id: oid, method: 'bKash', transaction_id: 'BIGTXN-1' });
  await run('admin-approve', { payment_id: db.prepare('SELECT id FROM payments WHERE order_id=?').get(oid).id, reason: 'ok' }, ADMIN);
  w.users[USER].sent.length = 0;
  assert.match(reply(await run('admin-deliver', { order_id: oid }, ADMIN)), /Delivery completed/);
  const msgs = w.users[USER].sent.map(m => (typeof m === 'string' ? m : m.content));
  assert.ok(msgs.length >= 2 && msgs.every(m => m.length <= 2000), `got ${msgs.length} messages`);
  for (let n = 0; n < 6; n++) assert.ok(msgs.join('\n').includes(`LONG-${n}-`));
});
