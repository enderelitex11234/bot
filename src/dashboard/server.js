// Local web dashboard for the Vortexia bot. Zero extra dependencies (node:http only).
// Security model: binds to 127.0.0.1 by default, password login, HttpOnly SameSite=Strict session cookie,
// CSRF token on every write, Host/Origin checks, strict CSP, login rate limit. Stock secrets are never sent to the browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const services = require('../services');
const { audit } = require('../security');
const embedBuilder = require('../embed-builder');
const { db } = services;

const PUBLIC = path.join(__dirname, 'public');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] };
const SESSION_MS = 8 * 60 * 60 * 1000;
const ACTOR = 'dashboard';
const SNOWFLAKE = /^\d{15,25}$/;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = msg => new HttpError(400, msg);
const intIn = (v, name, { min = 0, max = 1e9, optional = false } = {}) => {
  if ((v === undefined || v === null || v === '') && optional) return null;
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
};
const str = (v, name, { min = 0, max = 2000, optional = false } = {}) => {
  if ((v === undefined || v === null) && optional) return '';
  if (typeof v !== 'string') throw bad(`${name} is required.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw bad(`${name} must be ${min}-${max} characters.`);
  return t;
};
const noPing = s => String(s || '').replace(/@everyone/g, '@ everyone').replace(/@here/g, '@ here');

function createDashboard({ getClient, password, host = '127.0.0.1', port = 3000 }) {
  const pwHash = crypto.createHash('sha256').update(String(password)).digest();
  const sessions = new Map();           // token -> { csrf, expires }
  const attempts = new Map();           // ip -> { count, resetAt }
  const files = {};
  for (const [, [name]] of Object.entries(STATIC)) if (!files[name]) files[name] = fs.readFileSync(path.join(PUBLIC, name));
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);

  const client = () => (typeof getClient === 'function' ? getClient() : null);
  async function dm(userId, content) {
    try { const c = client(); if (!c) return false; const u = await c.users.fetch(userId); await u.send({ content: noPing(content).slice(0, 1900), allowedMentions: { parse: [] } }); return true; } catch { return false; }
  }

  // ---------- route handlers ----------
  const routes = [];
  const route = (method, pattern, fn, { auth = true } = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn, auth });

  route('GET', '/api/me', ctx => ({ authed: Boolean(ctx.session), csrf: ctx.session?.csrf || null, storeName: config.storeName }), { auth: false });
  route('POST', '/api/login', ctx => {
    const ip = ctx.ip; const now = Date.now(); const a = attempts.get(ip);
    if (a && a.resetAt > now && a.count >= 5) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const given = crypto.createHash('sha256').update(String(ctx.body.password ?? '')).digest();
    if (!crypto.timingSafeEqual(given, pwHash)) {
      attempts.set(ip, { count: (a && a.resetAt > now ? a.count : 0) + 1, resetAt: a && a.resetAt > now ? a.resetAt : now + 15 * 60 * 1000 });
      throw new HttpError(401, 'Wrong password.');
    }
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex'); const csrf = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { csrf, expires: now + SESSION_MS });
    ctx.setCookie(token);
    audit(db, ACTOR, 'DASHBOARD_LOGIN', ip, '', 'SUCCESS');
    return { ok: true, csrf };
  }, { auth: false });
  route('POST', '/api/logout', ctx => { sessions.delete(ctx.token); ctx.clearCookie(); return { ok: true }; });

  route('GET', '/api/overview', () => {
    const one = (sql, ...a) => db.prepare(sql).get(...a).n;
    const c = client();
    const lowStockProducts = db.prepare("SELECT p.id, p.name, COUNT(s.id) AS available FROM products p LEFT JOIN product_stock s ON s.product_id=p.id AND s.status='AVAILABLE' WHERE p.active=1 GROUP BY p.id HAVING available <= ? ORDER BY available, p.id LIMIT 10").all(config.lowStockThreshold);
    return {
      bot: { ready: Boolean(c?.isReady?.() ?? c?.user), tag: c?.user?.tag || null, ping: Math.max(0, Math.round(c?.ws?.ping ?? 0)), guilds: c?.guilds?.cache?.size ?? 0, uptimeSec: Math.floor(process.uptime()) },
      maintenance: db.prepare("SELECT value FROM bot_settings WHERE key='maintenance'").get()?.value === 'on',
      stats: {
        orders: one('SELECT COUNT(*) n FROM orders'), delivered: one("SELECT COUNT(*) n FROM orders WHERE status='DELIVERED'"),
        revenue: one("SELECT COALESCE(SUM(total_price),0) n FROM orders WHERE status='DELIVERED'"),
        pendingPayments: one("SELECT COUNT(*) n FROM payments WHERE status='PENDING_VERIFICATION'"), unpaidOrders: one("SELECT COUNT(*) n FROM orders WHERE status='PENDING_PAYMENT'"),
        paidAwaitingDelivery: one("SELECT COUNT(*) n FROM orders WHERE status='PAID'"),
        products: one('SELECT COUNT(*) n FROM products WHERE active=1'), availableStock: one("SELECT COUNT(*) n FROM product_stock WHERE status='AVAILABLE'"),
        pendingWithdrawals: one("SELECT COUNT(*) n FROM reseller_withdrawals WHERE status='PENDING'"), resellers: one("SELECT COUNT(*) n FROM resellers WHERE status='APPROVED'")
      },
      lowStockProducts, lowStockThreshold: config.lowStockThreshold,
      recentOrders: db.prepare('SELECT id, discord_id, status, total_price, created_at FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 8').all()
    };
  });

  // products
  const productRows = () => db.prepare("SELECT p.id, p.name, p.description, p.retail_price, p.reseller_price, p.active, c.name AS category, (SELECT COUNT(*) FROM product_stock s WHERE s.product_id=p.id AND s.status='AVAILABLE') AS available, (SELECT COUNT(*) FROM product_stock s WHERE s.product_id=p.id AND s.status='RESERVED') AS reserved FROM products p LEFT JOIN categories c ON c.id=p.category_id ORDER BY p.id DESC").all();
  const categoryId = name => {
    const n = String(name || '').trim().slice(0, 60); if (!n) return null;
    db.prepare('INSERT INTO categories(name) VALUES(?) ON CONFLICT(name) DO NOTHING').run(n);
    return db.prepare('SELECT id FROM categories WHERE name=?').get(n).id;
  };
  route('GET', '/api/products', () => ({ products: productRows() }));
  route('POST', '/api/products', ctx => {
    const b = ctx.body; const name = str(b.name, 'Name', { min: 1, max: 100 });
    const price = intIn(b.retail_price, 'Price', { max: 1e8 }); const rp = intIn(b.reseller_price, 'Reseller price', { max: 1e8, optional: true });
    const id = db.transaction(() => {
      const r = db.prepare('INSERT INTO products(name,description,category_id,retail_price,reseller_price) VALUES(?,?,?,?,?)').run(name, str(b.description, 'Description', { max: 1000, optional: true }), categoryId(b.category), price, rp);
      audit(db, ACTOR, 'PRODUCT_ADD', r.lastInsertRowid, 'Dashboard', 'SUCCESS'); return Number(r.lastInsertRowid);
    })();
    return { ok: true, id };
  });
  route('POST', '/api/products/:id', ctx => {
    const id = intIn(ctx.params.id, 'id', { min: 1 }); const b = ctx.body;
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(id); if (!p) throw new HttpError(404, 'Product not found.');
    const next = {
      name: 'name' in b ? str(b.name, 'Name', { min: 1, max: 100 }) : p.name,
      description: 'description' in b ? str(b.description, 'Description', { max: 1000, optional: true }) : p.description,
      retail_price: 'retail_price' in b ? intIn(b.retail_price, 'Price', { max: 1e8 }) : p.retail_price,
      reseller_price: 'reseller_price' in b ? intIn(b.reseller_price, 'Reseller price', { max: 1e8, optional: true }) : p.reseller_price,
      active: 'active' in b ? (b.active ? 1 : 0) : p.active,
      category_id: 'category' in b ? categoryId(b.category) : p.category_id
    };
    db.prepare("UPDATE products SET name=?,description=?,retail_price=?,reseller_price=?,active=?,category_id=?,updated_at=datetime('now') WHERE id=?").run(next.name, next.description, next.retail_price, next.reseller_price, next.active, next.category_id, id);
    audit(db, ACTOR, 'PRODUCT_UPDATE', id, Object.keys(b).join(','), 'SUCCESS');
    return { ok: true };
  });

  // stock (secret values are never returned)
  route('GET', '/api/stock', () => {
    const products = productRows().filter(p => p.active);
    return { products: products.map(p => ({ id: p.id, name: p.name, available: p.available, reserved: p.reserved,
      delivered: db.prepare("SELECT COUNT(*) n FROM product_stock WHERE product_id=? AND status='DELIVERED'").get(p.id).n,
      items: db.prepare("SELECT id, created_at FROM product_stock WHERE product_id=? AND status='AVAILABLE' ORDER BY id LIMIT 50").all(p.id) })) };
  });
  route('POST', '/api/stock/:productId', ctx => {
    const pid = intIn(ctx.params.productId, 'productId', { min: 1 });
    if (!db.prepare('SELECT 1 FROM products WHERE id=? AND active=1').get(pid)) throw new HttpError(404, 'Active product not found.');
    const lines = String(ctx.body.values ?? '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!lines.length) throw bad('Paste at least one stock item (one per line).');
    if (lines.length > 500) throw bad('Maximum 500 items per upload.');
    if (lines.some(l => l.length > 2000)) throw bad('A stock item is longer than 2000 characters.');
    db.transaction(() => { const ins = db.prepare('INSERT INTO product_stock(product_id,secret_value) VALUES(?,?)'); for (const l of lines) ins.run(pid, l); audit(db, ACTOR, 'STOCK_ADD_BULK', pid, `${lines.length} items (values not logged)`, 'SUCCESS'); })();
    return { ok: true, added: lines.length };
  });
  route('POST', '/api/stock/item/:id/remove', ctx => {
    const id = intIn(ctx.params.id, 'id', { min: 1 });
    const r = db.prepare("UPDATE product_stock SET status='REMOVED' WHERE id=? AND status='AVAILABLE'").run(id);
    if (!r.changes) throw new HttpError(404, 'That item is not AVAILABLE.');
    audit(db, ACTOR, 'STOCK_REMOVE', id, 'Dashboard', 'SUCCESS'); return { ok: true };
  });

  // orders & payments
  route('GET', '/api/orders', ctx => {
    const status = ctx.query.get('status'); const where = status ? 'WHERE o.status=?' : '';
    const rows = db.prepare(`SELECT o.id, o.discord_id, o.status, o.total_price, o.created_at, (SELECT group_concat(product_name || ' x' || quantity, ', ') FROM order_items WHERE order_id=o.id) AS items FROM orders o ${where} ORDER BY o.created_at DESC, o.rowid DESC LIMIT 150`).all(...(status ? [status] : []));
    return { orders: rows };
  });
  route('GET', '/api/orders/:id', ctx => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(ctx.params.id); if (!order) throw new HttpError(404, 'Order not found.');
    return { order, items: db.prepare('SELECT product_id, product_name, quantity, unit_price FROM order_items WHERE order_id=?').all(order.id),
      payments: db.prepare('SELECT id, method, transaction_id, status, verification_reason, created_at, verified_at FROM payments WHERE order_id=? ORDER BY id DESC').all(order.id),
      delivery: db.prepare('SELECT status, created_at FROM deliveries WHERE order_id=?').get(order.id) || null };
  });
  route('POST', '/api/orders/:id/cancel', async ctx => {
    const r = services.cancelOrder(ctx.params.id, ACTOR, { reason: str(ctx.body.reason, 'Reason', { max: 200, optional: true }) || 'Cancelled from dashboard', allowVerification: true });
    await dm(r.order.discord_id, `Your order ${r.order.id} was cancelled by the store.${ctx.body.reason ? ` Reason: ${ctx.body.reason}` : ''}`);
    return { ok: true, freed: r.freed };
  });
  route('POST', '/api/orders/:id/deliver', async ctx => {
    const c = client(); if (!c) throw new HttpError(503, 'Bot is not connected to Discord yet.');
    await services.deliverOrder(c, ctx.params.id, ACTOR); return { ok: true };
  });
  route('GET', '/api/payments', ctx => {
    const status = ctx.query.get('status') || 'PENDING_VERIFICATION';
    return { payments: db.prepare('SELECT p.id, p.order_id, p.method, p.transaction_id, p.status, p.submitted_by, p.verification_reason, p.created_at, o.total_price, o.status AS order_status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.status=? ORDER BY p.id DESC LIMIT 150').all(status) };
  });
  route('POST', '/api/payments/:id/approve', async ctx => {
    const order = services.approvePayment(intIn(ctx.params.id, 'id', { min: 1 }), ACTOR, str(ctx.body.reason, 'Verification note', { min: 3, max: 500 }));
    await dm(order.discord_id, `Payment verified for order ${order.id}. Your order is paid and awaiting delivery.`);
    return { ok: true, orderId: order.id };
  });
  route('POST', '/api/payments/:id/reject', async ctx => {
    const reason = str(ctx.body.reason, 'Reason', { min: 3, max: 300 });
    const order = services.rejectPayment(intIn(ctx.params.id, 'id', { min: 1 }), ACTOR, reason);
    if (order) await dm(order.discord_id, `Your payment for order ${order.id} could not be verified. Reason: ${reason}\nYou can submit the correct transaction again with /payment-submit.`);
    return { ok: true };
  });

  // resellers, wallets, withdrawals
  route('GET', '/api/resellers', () => ({ resellers: db.prepare("SELECT r.discord_id, r.status, r.created_at, COALESCE(w.balance,0) AS balance, (SELECT COALESCE(SUM(amount),0) FROM reseller_withdrawals WHERE discord_id=r.discord_id AND status='PENDING') AS pending FROM resellers r LEFT JOIN wallets w ON w.discord_id=r.discord_id ORDER BY r.created_at DESC").all() }));
  route('POST', '/api/resellers', ctx => {
    const id = str(ctx.body.discord_id, 'Discord ID', { min: 15, max: 25 }); if (!SNOWFLAKE.test(id)) throw bad('Discord ID must be numeric (enable Developer Mode, right-click user, Copy User ID).');
    services.setReseller(id, ctx.body.status === 'SUSPENDED' ? 'SUSPENDED' : 'APPROVED', ACTOR); return { ok: true };
  });
  route('POST', '/api/resellers/:id/credit', ctx => ({ ok: true, balance: services.creditWallet(ctx.params.id, intIn(ctx.body.amount, 'Amount', { min: 1, max: 1e7 }), ACTOR, str(ctx.body.note, 'Note', { max: 100, optional: true })) }));
  route('GET', '/api/withdrawals', ctx => {
    const status = ctx.query.get('status');
    return { withdrawals: db.prepare(`SELECT id, discord_id, amount, method, payout_details, status, review_note, created_at, reviewed_at FROM reseller_withdrawals ${status ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT 100`).all(...(status ? [status] : [])) };
  });
  route('POST', '/api/withdrawals/:id', async ctx => {
    const id = intIn(ctx.params.id, 'id', { min: 1 }); const decision = String(ctx.body.decision || ''); const note = str(ctx.body.note, 'Note', { max: 300, optional: true });
    const req = services.reviewWithdrawal(id, decision, note, ACTOR);
    await dm(req.discord_id, `Your withdrawal request #${id} for ৳${req.amount} was marked ${decision.toLowerCase()}.${note ? ` Staff note: ${note}` : ''}`);
    return { ok: true };
  });

  // coupons
  route('GET', '/api/coupons', () => ({ coupons: db.prepare('SELECT code, kind, amount, max_uses, uses, expires_at, active FROM coupons ORDER BY rowid DESC').all() }));
  route('POST', '/api/coupons', ctx => {
    const code = str(ctx.body.code, 'Code', { min: 3, max: 64 }).toUpperCase(); if (!/^[A-Z0-9_-]{3,64}$/.test(code)) throw bad('Code may only use letters, numbers, _ and -.');
    const kind = ctx.body.kind === 'PERCENT' ? 'PERCENT' : 'FIXED'; const amount = intIn(ctx.body.amount, 'Amount', { min: 1, max: 1e6 });
    if (kind === 'PERCENT' && amount > 100) throw bad('Percent coupons must be 1-100.');
    const maxUses = intIn(ctx.body.max_uses, 'Max uses', { min: 1, max: 1e6, optional: true });
    try { db.prepare('INSERT INTO coupons(code,kind,amount,max_uses) VALUES(?,?,?,?)').run(code, kind, amount, maxUses); } catch { throw bad('That coupon code already exists.'); }
    audit(db, ACTOR, 'COUPON_CREATE', code, `${kind} ${amount}`, 'SUCCESS'); return { ok: true };
  });
  route('POST', '/api/coupons/:code/toggle', ctx => {
    const r = db.prepare('UPDATE coupons SET active=1-active WHERE code=?').run(ctx.params.code); if (!r.changes) throw new HttpError(404, 'Coupon not found.');
    audit(db, ACTOR, 'COUPON_TOGGLE', ctx.params.code, '', 'SUCCESS'); return { ok: true };
  });

  // audit + settings
  route('GET', '/api/audit', ctx => {
    const action = ctx.query.get('action'); const limit = Math.min(300, Math.max(1, Number(ctx.query.get('limit')) || 100));
    return { logs: db.prepare(`SELECT id, actor_id, action, target, reason, result, created_at FROM audit_logs ${action ? 'WHERE action=?' : ''} ORDER BY id DESC LIMIT ?`).all(...(action ? [action] : []), limit) };
  });
  route('GET', '/api/settings', () => ({ maintenance: db.prepare("SELECT value FROM bot_settings WHERE key='maintenance'").get()?.value === 'on', lowStockThreshold: config.lowStockThreshold, orderExpiryMinutes: config.orderExpiryMinutes, storeName: config.storeName }));
  route('POST', '/api/settings/maintenance', ctx => {
    const on = ctx.body.on ? 'on' : 'off';
    db.prepare("INSERT INTO bot_settings(key,value,updated_at) VALUES('maintenance',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").run(on);
    audit(db, ACTOR, 'MAINTENANCE', on, 'Dashboard', 'SUCCESS'); return { ok: true, maintenance: on === 'on' };
  });

  // embed sender
  route('GET', '/api/channels', async () => {
    const c = client(); const out = [];
    for (const g of c?.guilds?.cache?.values?.() || []) {
      for (const ch of g?.channels?.cache?.values?.() || []) if ([0, 5].includes(ch.type) && ch.isTextBased?.()) out.push({ id: ch.id, name: ch.name, guild: g.name, guildId: g.id });
    }
    out.sort((a, b) => a.guild.localeCompare(b.guild) || a.name.localeCompare(b.name));
    return { channels: out, botReady: Boolean(c) };
  });
  route('POST', '/api/embed/send', async ctx => {
    const b = ctx.body; const c = client(); if (!c) throw new HttpError(503, 'Bot is not connected to Discord yet.');
    const channelId = str(b.channelId, 'Channel', { min: 15, max: 25 }); if (!SNOWFLAKE.test(channelId)) throw bad('Choose a channel.');
    const content = noPing(str(b.content, 'Message', { max: 1900, optional: true }));
    const spec = embedBuilder.blank(channelId, '');
    spec.title = str(b.title, 'Title', { max: 256, optional: true }); spec.description = str(b.description, 'Description', { max: 3500, optional: true });
    const color = str(b.color || '#FF6A00', 'Color', { max: 7 }); if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw bad('Color must look like #FF6A00.'); spec.color = color;
    const url = (v, n) => { try { return embedBuilder.validUrl(String(v || '').trim()); } catch { throw bad(`${n} must be a valid HTTPS URL.`); } };
    spec.image = url(b.image, 'Image'); spec.thumbnail = url(b.thumbnail, 'Thumbnail'); spec.titleUrl = url(b.titleUrl, 'Title URL');
    spec.author = str(b.author, 'Author', { max: 256, optional: true }); spec.authorIcon = url(b.authorIcon, 'Author icon');
    spec.footer = str(b.footer, 'Footer', { max: 2048, optional: true }); spec.timestamp = Boolean(b.timestamp);
    const fields = Array.isArray(b.fields) ? b.fields : []; if (fields.length > 10) throw bad('Maximum 10 fields.');
    spec.fields = fields.map((f, i) => ({ name: str(f?.name, `Field ${i + 1} name`, { min: 1, max: 256 }), value: str(f?.value, `Field ${i + 1} value`, { min: 1, max: 1024 }), inline: Boolean(f?.inline) }));
    const links = Array.isArray(b.links) ? b.links : []; if (links.length > 5) throw bad('Maximum 5 link buttons.');
    spec.links = links.map((l, i) => ({ label: str(l?.label, `Button ${i + 1} label`, { min: 1, max: 80 }), url: url(l?.url, `Button ${i + 1} URL`) || (() => { throw bad(`Button ${i + 1} needs a URL.`); })() }));
    const hasEmbed = Boolean(spec.title || spec.description || spec.fields.length || spec.image);
    if (!hasEmbed && !content) throw bad('Add a title, description, field, image or message text.');
    let channel; try { channel = await c.channels.fetch(channelId); } catch { throw bad('The bot cannot see that channel.'); }
    if (!channel || !channel.isTextBased?.() || !channel.guildId) throw bad('Choose a server text channel.');
    const payload = { allowedMentions: { parse: [] } };
    if (content) payload.content = content;
    if (hasEmbed) payload.embeds = [embedBuilder.getEmbed(spec)];
    if (spec.links.length) payload.components = [new ActionRowBuilder().addComponents(spec.links.map(l => new ButtonBuilder().setLabel(l.label).setStyle(ButtonStyle.Link).setURL(l.url)))];
    try { await channel.send(payload); } catch (e) { throw bad(`Discord refused the message: ${String(e.message || e).slice(0, 160)}`); }
    audit(db, ACTOR, 'DASHBOARD_EMBED_SEND', channelId, `fields=${spec.fields.length}; links=${spec.links.length}; content omitted`, 'SUCCESS');
    return { ok: true };
  });

  // ---------- http plumbing ----------
  const securityHeaders = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'
  };
  function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, { ...securityHeaders, 'Content-Type': type, ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', d => { size += d.length; if (size > 1024 * 1024) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(d); });
      req.on('end', () => { if (!chunks.length) return resolve({}); try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); } catch { reject(bad('Invalid JSON.')); } });
      req.on('error', reject);
    });
  }
  const cookieToken = req => (/(?:^|;\s*)vx_session=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1] || null;
  function hostAllowed(req) {
    if (!loopback) return true;
    const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return ['localhost', '127.0.0.1', '[::1]'].includes(h);
  }

  async function handler(req, res) {
    try {
      if (!hostAllowed(req)) return send(res, 403, 'Forbidden host header', 'text/plain');
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && STATIC[url.pathname]) { const [name, type] = STATIC[url.pathname]; return send(res, 200, files[name], type); }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found', 'text/plain');
      const token = cookieToken(req); let session = token ? sessions.get(token) : null;
      if (session && session.expires < Date.now()) { sessions.delete(token); session = null; }
      const found = routes.map(r => ({ r, m: r.re.exec(url.pathname) })).find(x => x.m && x.r.method === req.method);
      if (!found) return send(res, url.pathname.startsWith('/api/') && routes.some(r => r.re.test(url.pathname)) ? 405 : 404, { error: 'Not found' });
      if (found.r.auth && !session) return send(res, 401, { error: 'Please log in.' });
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch { /* bad origin */ } if (!ok) return send(res, 403, { error: 'Bad origin.' }); }
        if (found.r.auth && req.headers['x-csrf-token'] !== session.csrf) return send(res, 403, { error: 'Bad CSRF token. Reload the page.' });
      }
      const extra = [];
      const ctx = { params: { ...found.m.groups }, query: url.searchParams, body: req.method === 'GET' ? {} : await readBody(req), session, token, ip: req.socket.remoteAddress || 'unknown',
        setCookie: t => extra.push(`vx_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`), clearCookie: () => extra.push('vx_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0') };
      for (const k of Object.keys(ctx.params)) { try { ctx.params[k] = decodeURIComponent(ctx.params[k]); } catch { throw bad('Bad URL.'); } }
      const out = await found.r.fn(ctx);
      return send(res, 200, out, undefined, extra.length ? { 'Set-Cookie': extra } : {});
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (/constraint|SQLITE/i.test(String(err?.code || err?.message))) return send(res, 400, { error: 'The database rejected that change (duplicate or invalid value).' });
      if (err?.message && !/^(TypeError|ReferenceError|RangeError)/.test(err.name || '')) return send(res, 400, { error: String(err.message).slice(0, 300) });
      console.error('[dashboard-error]', err?.stack || err); return send(res, 500, { error: 'Internal error.' });
    }
  }

  const server = http.createServer(handler);
  const sweep = setInterval(() => { const n = Date.now(); for (const [t, s] of sessions) if (s.expires < n) sessions.delete(t); for (const [k, a] of attempts) if (a.resetAt < n) attempts.delete(k); }, 10 * 60 * 1000); sweep.unref();
  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }),
    close: () => new Promise(resolve => { clearInterval(sweep); server.close(() => resolve()); server.closeAllConnections?.(); })
  };
}

// Starts the dashboard from config; never throws (a busy port must not take the bot down).
async function startDashboard(getClient) {
  const d = config.dashboard;
  if (!d.enabled) { console.log('[dashboard] disabled (DASHBOARD_ENABLED=false).'); return null; }
  let password = d.password; let generated = false;
  if (!password) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
  const dash = createDashboard({ getClient, password, host: d.host, port: d.port });
  try {
    const addr = await dash.listen();
    const shown = ['127.0.0.1', '::1', '0.0.0.0', '::'].includes(addr.address) ? 'localhost' : addr.address;
    console.log(`[dashboard] Open http://${shown}:${addr.port}  (local only${d.host === '127.0.0.1' ? '' : `, bound to ${d.host}`})`);
    console.log(generated ? `[dashboard] Password for this run: ${password}   (set DASHBOARD_PASSWORD in .env to choose your own)` : '[dashboard] Password: from DASHBOARD_PASSWORD in .env');
    if (!['127.0.0.1', 'localhost', '::1'].includes(d.host)) console.warn('[dashboard] WARNING: not bound to loopback. Anyone who can reach this port can try the password. Prefer 127.0.0.1 or a VPN/reverse proxy with HTTPS.');
    return dash;
  } catch (err) {
    console.error(`[dashboard] Could not start on ${d.host}:${d.port}: ${err.message}. The bot keeps running without the dashboard (change DASHBOARD_PORT).`);
    return null;
  }
}
module.exports = { createDashboard, startDashboard };
