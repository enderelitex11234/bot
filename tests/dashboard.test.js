// Dashboard tests: real HTTP server on a random port, mocked Discord, temp SQLite.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { IDS, setupEnv, makeWorld } = require('./mock-discord');
const tmpDir = setupEnv();
process.chdir(tmpDir);
const { createDashboard } = require('../src/dashboard/server');
const services = require('../src/services');
const { db } = services;
const w = makeWorld();
const PASSWORD = 'correct horse battery';
let dash, port, cookie = '', csrf = '';

function call(method, path, { body, headers = {}, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { Host: `localhost:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers };
    if (auth && cookie) h.Cookie = cookie;
    if (auth && csrf && method !== 'GET' && !('X-CSRF-Token' in h)) h['X-CSRF-Token'] = csrf;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, res => {
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

test.before(async () => {
  dash = createDashboard({ getClient: () => w.client, password: PASSWORD, host: '127.0.0.1', port: 0 });
  port = (await dash.listen()).port;
});
test.after(async () => { await dash.close(); assert.deepEqual(w.violations, []); });

test('serves the app shell with a strict CSP and nothing else', async () => {
  const idx = await call('GET', '/', { auth: false });
  assert.equal(idx.status, 200); assert.match(idx.text, /app\.js/);
  assert.match(idx.headers['content-security-policy'], /script-src 'self'/); assert.equal(idx.headers['x-frame-options'], 'DENY');
  assert.equal((await call('GET', '/app.js', { auth: false })).status, 200);
  assert.equal((await call('GET', '/app.css', { auth: false })).status, 200);
  assert.equal((await call('GET', '/../../.env', { auth: false })).status, 404);
  assert.equal((await call('GET', '/package.json', { auth: false })).status, 404);
});

test('API is locked until login; bad Host header is refused (DNS rebinding)', async () => {
  assert.equal((await call('GET', '/api/overview', { auth: false })).status, 401);
  assert.equal((await call('GET', '/api/me', { auth: false })).json.authed, false);
  assert.equal((await call('GET', '/', { auth: false, headers: { Host: 'evil.example.com' } })).status, 403);
});

test('login: wrong password rejected, rate limited, right password gives HttpOnly SameSite cookie', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/login', { body: { password: 'nope' }, auth: false })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { password: PASSWORD }, auth: false })).status, 429, 'locked out after 5 failures');
});

test('login works for a fresh client address', async () => {
  // new dashboard instance = fresh rate-limit state (same password)
  await dash.close();
  dash = createDashboard({ getClient: () => w.client, password: PASSWORD, host: '127.0.0.1', port: 0 }); port = (await dash.listen()).port;
  const r = await call('POST', '/api/login', { body: { password: PASSWORD }, auth: false });
  assert.equal(r.status, 200); assert.ok(r.json.csrf);
  const sc = [].concat(r.headers['set-cookie']).join(';');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0]; csrf = r.json.csrf;
  assert.equal((await call('GET', '/api/me')).json.authed, true);
});

test('writes need the CSRF token and a same-origin Origin', async () => {
  assert.equal((await call('POST', '/api/settings/maintenance', { body: { on: false }, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await call('POST', '/api/settings/maintenance', { body: { on: false }, headers: { Origin: 'http://evil.example.com' } })).status, 403);
  assert.equal((await call('POST', '/api/settings/maintenance', { body: { on: false }, headers: { Origin: `http://localhost:${port}` } })).status, 200);
});

test('products: create, validate, edit, hide', async () => {
  assert.equal((await call('POST', '/api/products', { body: { name: '', retail_price: 10 } })).status, 400);
  assert.equal((await call('POST', '/api/products', { body: { name: 'X', retail_price: -5 } })).status, 400);
  assert.equal((await call('POST', '/api/products', { body: { name: 'Hypixel Rank', retail_price: '500', reseller_price: '400', category: 'Hypixel', description: 'rank' } })).json.id, 1);
  assert.equal((await call('POST', '/api/products', { body: { name: 'Cape', retail_price: 300, category: 'Capes' } })).json.id, 2);
  assert.equal((await call('POST', '/api/products/1', { body: { retail_price: 550 } })).status, 200);
  const list = (await call('GET', '/api/products')).json.products;
  assert.equal(list.find(p => p.id === 1).retail_price, 550); assert.equal(list.find(p => p.id === 1).category, 'Hypixel');
  assert.equal((await call('POST', '/api/products/99', { body: { retail_price: 1 } })).status, 404);
});

test('stock: bulk add, never leaks secret values, remove', async () => {
  const add = await call('POST', '/api/stock/1', { body: { values: 'SECRET-ONE\nSECRET-TWO\n\n  SECRET-THREE  ' } });
  assert.equal(add.json.added, 3);
  assert.equal((await call('POST', '/api/stock/1', { body: { values: '   ' } })).status, 400);
  const stock = await call('GET', '/api/stock'); assert.ok(!stock.text.includes('SECRET'), 'stock endpoint leaked a secret');
  const item = stock.json.products.find(p => p.id === 1).items[0];
  assert.equal((await call('POST', `/api/stock/item/${item.id}/remove`, { body: {} })).status, 200);
  assert.equal((await call('POST', `/api/stock/item/${item.id}/remove`, { body: {} })).status, 404);
  assert.equal(db.prepare("SELECT secret_value v FROM product_stock WHERE id=?").get(item.id).v, 'SECRET-ONE');
  assert.ok(!(await call('GET', '/api/audit')).text.includes('SECRET'), 'audit log must not contain secret values');
});

test('order lifecycle from the dashboard: approve, deliver, reject, cancel', async () => {
  const mk = (q = 1) => services.createOrder(IDS.USER, 1, q).orderId;
  const o1 = mk(2); const pid = services.submitPayment(IDS.USER, o1, 'bKash', 'DASH-TXN-1');
  assert.equal((await call('GET', '/api/payments')).json.payments.length, 1);
  assert.equal((await call('POST', `/api/payments/${pid}/approve`, { body: { reason: '' } })).status, 400, 'a verification note is required');
  assert.equal((await call('POST', `/api/payments/${pid}/approve`, { body: { reason: 'checked statement' } })).status, 200);
  assert.equal((await call('POST', `/api/orders/${o1}/deliver`, { body: {} })).status, 200);
  const dm = w.users[IDS.USER].sent.map(m => (typeof m === 'string' ? m : m.content)).join('\n');
  assert.ok(dm.includes('SECRET-TWO') && dm.includes('SECRET-THREE'));
  const detail = (await call('GET', `/api/orders/${o1}`)).json; assert.equal(detail.order.status, 'DELIVERED'); assert.equal(detail.delivery.status, 'SENT');
});

test('reject sends order back, cancel frees stock, stale orders expire', async () => {
  await call('POST', '/api/stock/1', { body: { values: 'S-A\nS-B\nS-C' } });
  const avail = () => db.prepare("SELECT COUNT(*) n FROM product_stock WHERE product_id=1 AND status='AVAILABLE'").get().n;
  const start = avail();
  const o = services.createOrder(IDS.USER, 1, 2).orderId; assert.equal(avail(), start - 2);
  const pid = services.submitPayment(IDS.USER, o, 'Nagad', 'FAKE-DASH-2');
  assert.equal((await call('POST', `/api/payments/${pid}/reject`, { body: { reason: 'no such transaction' } })).status, 200);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(o).status, 'PENDING_PAYMENT');
  assert.equal((await call('POST', `/api/orders/${o}/cancel`, { body: {} })).json.freed, 2); assert.equal(avail(), start);
  assert.equal((await call('POST', `/api/orders/${o}/cancel`, { body: {} })).status, 400, 'cannot cancel twice');
  assert.equal((await call('GET', '/api/orders?status=CANCELLED')).json.orders.length, 1);
  assert.equal((await call('GET', '/api/orders/NOPE')).status, 404);
});

test('resellers, wallet credit and withdrawals', async () => {
  assert.equal((await call('POST', '/api/resellers', { body: { discord_id: 'abc', status: 'APPROVED' } })).status, 400);
  assert.equal((await call('POST', '/api/resellers', { body: { discord_id: IDS.RESELLER, status: 'APPROVED' } })).status, 200);
  assert.equal((await call('POST', `/api/resellers/${IDS.RESELLER}/credit`, { body: { amount: 1000 } })).json.balance, 1000);
  assert.equal((await call('POST', `/api/resellers/${IDS.RESELLER}/credit`, { body: { amount: -5 } })).status, 400);
  db.prepare("INSERT INTO reseller_withdrawals(discord_id,amount,method,payout_details) VALUES(?,?,?,?)").run(IDS.RESELLER, 400, 'bKash', '01700000000');
  assert.equal((await call('GET', '/api/withdrawals?status=PENDING')).json.withdrawals.length, 1);
  assert.equal((await call('POST', '/api/withdrawals/1', { body: { decision: 'APPROVED', note: 'ok' } })).status, 200);
  assert.equal(db.prepare('SELECT balance FROM wallets WHERE discord_id=?').get(IDS.RESELLER).balance, 600);
  assert.equal((await call('POST', '/api/withdrawals/1', { body: { decision: 'APPROVED' } })).status, 400, 'cannot approve twice');
  assert.equal((await call('POST', '/api/withdrawals/1', { body: { decision: 'PAID' } })).status, 200);
  assert.equal((await call('GET', '/api/resellers')).json.resellers[0].balance, 600);
});

test('coupons: create, reject bad input, toggle', async () => {
  assert.equal((await call('POST', '/api/coupons', { body: { code: 'ab', kind: 'PERCENT', amount: 10 } })).status, 400);
  assert.equal((await call('POST', '/api/coupons', { body: { code: 'BIG', kind: 'PERCENT', amount: 150 } })).status, 400);
  assert.equal((await call('POST', '/api/coupons', { body: { code: 'save10', kind: 'PERCENT', amount: 10, max_uses: 5 } })).status, 200);
  assert.equal((await call('POST', '/api/coupons', { body: { code: 'SAVE10', kind: 'FIXED', amount: 5 } })).status, 400, 'duplicate');
  assert.equal((await call('POST', '/api/coupons/SAVE10/toggle', { body: {} })).status, 200);
  assert.equal((await call('GET', '/api/coupons')).json.coupons[0].active, 0);
});

test('embed sender: validation and delivery', async () => {
  const chans = (await call('GET', '/api/channels')).json.channels; assert.equal(chans[0].id, IDS.CHANNEL);
  const base = { channelId: IDS.CHANNEL, title: 'Sale', description: 'Half price @everyone', color: '#00ff99', footer: 'Vortexia', timestamp: true,
    fields: [{ name: 'Code', value: 'SAVE10', inline: true }], links: [{ label: 'Shop', url: 'https://example.com/shop' }] };
  assert.equal((await call('POST', '/api/embed/send', { body: { ...base, channelId: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/embed/send', { body: { channelId: IDS.CHANNEL } })).status, 400, 'empty message');
  assert.equal((await call('POST', '/api/embed/send', { body: { ...base, image: 'http://insecure.example.com/a.png' } })).status, 400);
  assert.equal((await call('POST', '/api/embed/send', { body: { ...base, color: 'red' } })).status, 400);
  assert.equal((await call('POST', '/api/embed/send', { body: { ...base, fields: Array(11).fill({ name: 'a', value: 'b' }) } })).status, 400);
  assert.equal((await call('POST', '/api/embed/send', { body: { ...base, links: [{ label: 'x', url: '' }] } })).status, 400);
  const before = w.posted.length;
  assert.equal((await call('POST', '/api/embed/send', { body: base })).status, 200);
  assert.equal(w.posted.length, before + 1);
  const sent = w.posted.at(-1); const e = sent.embeds[0].toJSON();
  assert.equal(e.title, 'Sale'); assert.ok(!e.description.includes('@everyone'), 'mass mentions are neutralised'); assert.deepEqual(sent.allowedMentions, { parse: [] });
  assert.equal(sent.components[0].toJSON().components[0].url, 'https://example.com/shop');
  assert.equal((await call('POST', '/api/embed/send', { body: { channelId: IDS.CHANNEL, content: 'plain text only' } })).status, 200);
});

test('overview, settings, audit and logout', async () => {
  const ov = (await call('GET', '/api/overview')).json;
  assert.equal(ov.bot.ready, true); assert.ok(ov.stats.delivered >= 1); assert.ok(Array.isArray(ov.recentOrders));
  assert.equal((await call('POST', '/api/settings/maintenance', { body: { on: true } })).json.maintenance, true);
  assert.equal((await call('GET', '/api/settings')).json.maintenance, true);
  assert.equal((await call('POST', '/api/settings/maintenance', { body: { on: false } })).json.maintenance, false);
  const logs = (await call('GET', '/api/audit?limit=300')).json.logs;
  for (const a of ['DASHBOARD_LOGIN', 'PRODUCT_ADD', 'PAYMENT_APPROVE', 'PAYMENT_REJECT', 'ORDER_CANCEL', 'WALLET_CREDIT', 'DASHBOARD_EMBED_SEND']) assert.ok(logs.some(l => l.action === a), `audit missing ${a}`);
  assert.equal((await call('GET', '/api/audit?action=PRODUCT_ADD')).json.logs.every(l => l.action === 'PRODUCT_ADD'), true);
  assert.equal((await call('POST', '/api/logout', { body: {} })).status, 200);
  assert.equal((await call('GET', '/api/overview')).status, 401, 'old session is dead after logout');
  assert.equal((await call('POST', '/api/products', { body: { name: 'x', retail_price: 1 } })).status, 401);
});

test('malformed requests do not crash the server', async () => {
  const r = await call('POST', '/api/login', { auth: false, headers: { 'Content-Type': 'application/json' }, body: undefined });
  assert.ok([401, 429].includes(r.status));
  assert.equal((await call('GET', '/api/nope', { auth: false })).status, 404);
  assert.equal((await call('DELETE', '/api/me', { auth: false })).status, 405);
});
