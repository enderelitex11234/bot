const crypto = require('node:crypto');
const db = require('./db');
const { audit } = require('./security');

function createOrder(userId, productId, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new Error('Quantity must be between 1 and 10.');
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO users(discord_id) VALUES(?)').run(userId);
    const product = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(productId);
    if (!product) throw new Error('Product not found or unavailable.');
    const stock = db.prepare("SELECT COUNT(*) AS n FROM product_stock WHERE product_id=? AND status='AVAILABLE'").get(productId).n;
    if (stock < quantity) throw new Error(`Not enough stock. Available: ${stock}.`);
    const orderId = `VX-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const total = product.retail_price * quantity;
    db.prepare('INSERT INTO orders(id, discord_id, status, total_price) VALUES(?,?,?,?)')
      .run(orderId, userId, 'PENDING_PAYMENT', total);
    db.prepare('INSERT INTO order_items(order_id, product_id, product_name, quantity, unit_price) VALUES(?,?,?,?,?)')
      .run(orderId, product.id, product.name, quantity, product.retail_price);
    const reserve = db.prepare("UPDATE product_stock SET status='RESERVED', reserved_order_id=? WHERE id IN (SELECT id FROM product_stock WHERE product_id=? AND status='AVAILABLE' ORDER BY id LIMIT ?)");
    reserve.run(orderId, productId, quantity);
    return { orderId, product, quantity, total };
  });
  return tx();
}
function submitPayment(userId, orderId, method, transactionId) {
  const tx = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND discord_id=?').get(orderId, userId);
    if (!order) throw new Error('Order not found for your account.');
    if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PENDING_VERIFICATION') throw new Error(`Order cannot accept payment in status ${order.status}.`);
    const cleanTx = transactionId.trim();
    if (cleanTx.length < 4 || cleanTx.length > 100) throw new Error('Transaction ID must be between 4 and 100 characters.');
    const exists = db.prepare('SELECT 1 FROM transaction_ids WHERE transaction_id=?').get(cleanTx);
    if (exists) throw new Error('This transaction ID has already been submitted.');
    const info = db.prepare("INSERT INTO payments(order_id, method, transaction_id, status, submitted_by) VALUES(?,?,?,?,?)")
      .run(orderId, method, cleanTx, 'PENDING_VERIFICATION', userId);
    db.prepare('INSERT INTO transaction_ids(transaction_id, payment_id) VALUES(?,?)').run(cleanTx, info.lastInsertRowid);
    db.prepare("UPDATE orders SET status='PENDING_VERIFICATION', updated_at=datetime('now') WHERE id=?").run(orderId);
    return Number(info.lastInsertRowid);
  });
  return tx();
}
function approvePayment(paymentId, adminId, reason='Verified independently by administrator') {
  const tx = db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
    if (!payment) throw new Error('Payment not found.');
    if (payment.status !== 'PENDING_VERIFICATION') throw new Error('Payment is not pending verification.');
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(payment.order_id);
    if (!order || order.status !== 'PENDING_VERIFICATION') throw new Error('Order is not awaiting verification.');
    db.prepare("UPDATE payments SET status='APPROVED', verified_by=?, verification_reason=?, verified_at=datetime('now') WHERE id=?")
      .run(adminId, reason, paymentId);
    db.prepare("UPDATE orders SET status='PAID', updated_at=datetime('now') WHERE id=?").run(order.id);
    audit(db, adminId, 'PAYMENT_APPROVE', order.id, reason, 'SUCCESS');
    return order;
  });
  return tx();
}
async function deliverOrder(client, orderId, adminId) {
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND status='PAID'").get(orderId);
  if (!order) throw new Error('Order must be PAID before delivery.');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
  const selected = [];
  const reserveTx = db.transaction(() => {
    for (const item of items) {
      const rows = db.prepare("SELECT id, secret_value FROM product_stock WHERE reserved_order_id=? AND product_id=? AND status='RESERVED' ORDER BY id LIMIT ?")
        .all(orderId, item.product_id, item.quantity);
      if (rows.length !== item.quantity) throw new Error('Reserved stock is missing. Order remains paid; contact an administrator.');
      selected.push(...rows);
    }
    db.prepare("UPDATE orders SET status='PROCESSING', updated_at=datetime('now') WHERE id=? AND status='PAID'").run(orderId);
  });
  reserveTx();
  try {
    const user = await client.users.fetch(order.discord_id);
    const header = `**${require('./config').storeName} — Order ${orderId}**`;
    const lines = selected.map((x,i)=>`${i+1}. ${x.secret_value}`);
    const chunks = []; let cur = header;
    for (const line of lines) {
      const piece = line.length > 1800 ? line.slice(0,1800) : line;
      if ((cur + '\n\n' + piece).length > 1900) { chunks.push(cur); cur = piece; } else cur += (cur === header && chunks.length === 0 ? '\n\n' : '\n') + piece;
    }
    chunks.push(cur);
    for (const c of chunks) await user.send({ content: c, allowedMentions: { parse: [] } });
  } catch (err) {
    db.prepare("UPDATE orders SET status='PAID', updated_at=datetime('now') WHERE id=? AND status='PROCESSING'").run(orderId);
    throw new Error('Could not deliver by DM. Order remains paid for authorized recovery.');
  }
  const finish = db.transaction(() => {
    for (const item of selected) {
      const changed = db.prepare("UPDATE product_stock SET status='DELIVERED', delivered_at=datetime('now') WHERE id=? AND status='RESERVED' AND reserved_order_id=?").run(item.id, orderId);
      if (changed.changes !== 1) throw new Error('Inventory state changed unexpectedly; investigate before retrying.');
    }
    db.prepare("INSERT INTO deliveries(order_id, stock_id, delivered_to, status) VALUES(?,?,?,'SENT')").run(orderId, selected[0].id, order.discord_id);
    db.prepare("UPDATE orders SET status='DELIVERED', updated_at=datetime('now') WHERE id=?").run(orderId);
    audit(db, adminId, 'ORDER_DELIVER', orderId, 'DM delivery succeeded', 'SUCCESS');
  });
  finish();
}


function rejectPayment(paymentId, adminId, reason = 'Rejected by administrator') {
  const tx = db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
    if (!payment) throw new Error('Payment not found.');
    if (payment.status !== 'PENDING_VERIFICATION') throw new Error('Payment is not pending verification.');
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(payment.order_id);
    db.prepare("UPDATE payments SET status='REJECTED', verified_by=?, verification_reason=?, verified_at=datetime('now') WHERE id=?").run(String(adminId), reason, paymentId);
    // Order goes back to PENDING_PAYMENT so the customer can submit a correct transaction. Stock stays reserved.
    if (order && order.status === 'PENDING_VERIFICATION') db.prepare("UPDATE orders SET status='PENDING_PAYMENT', updated_at=datetime('now') WHERE id=?").run(order.id);
    audit(db, adminId, 'PAYMENT_REJECT', payment.order_id, reason, 'SUCCESS');
    return order;
  });
  return tx();
}
// Cancels an unpaid order and returns its reserved stock to AVAILABLE.
function cancelOrder(orderId, actorId, { reason = 'Cancelled', allowVerification = false, ownerId = null } = {}) {
  const tx = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!order || (ownerId && order.discord_id !== ownerId)) throw new Error('Order not found for your account.');
    const ok = order.status === 'PENDING_PAYMENT' || (allowVerification && order.status === 'PENDING_VERIFICATION');
    if (!ok) throw new Error(`An order in status ${order.status} cannot be cancelled here.`);
    db.prepare("UPDATE orders SET status='CANCELLED', updated_at=datetime('now') WHERE id=?").run(orderId);
    const freed = db.prepare("UPDATE product_stock SET status='AVAILABLE', reserved_order_id=NULL WHERE reserved_order_id=? AND status='RESERVED'").run(orderId).changes;
    db.prepare("UPDATE payments SET status='REJECTED', verified_by=?, verification_reason=?, verified_at=datetime('now') WHERE order_id=? AND status='PENDING_VERIFICATION'").run(String(actorId), reason, orderId);
    audit(db, actorId, 'ORDER_CANCEL', orderId, reason, 'SUCCESS');
    return { order, freed };
  });
  return tx();
}
// Releases stock held by unpaid orders older than `minutes`. Returns the cancelled orders.
function expireStaleOrders(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return [];
  const rows = db.prepare("SELECT id, discord_id FROM orders WHERE status='PENDING_PAYMENT' AND created_at <= datetime('now', ?)").all(`-${Math.floor(minutes)} minutes`);
  const done = [];
  for (const r of rows) { try { cancelOrder(r.id, 'system', { reason: `Auto-cancelled: unpaid after ${minutes} minutes` }); done.push(r); } catch { /* changed meanwhile */ } }
  return done;
}
function setReseller(userId, status, actorId) {
  if (!['APPROVED', 'SUSPENDED'].includes(status)) throw new Error('Invalid reseller status.');
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO users(discord_id) VALUES(?)').run(userId);
    db.prepare('INSERT INTO resellers(discord_id,status) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET status=excluded.status').run(userId, status);
    db.prepare('INSERT OR IGNORE INTO wallets(discord_id) VALUES(?)').run(userId);
    audit(db, actorId, 'RESELLER_SET', userId, status, 'SUCCESS');
  })();
}
function creditWallet(userId, amount, actorId, note = '') {
  if (!Number.isInteger(amount) || amount < 1) throw new Error('Amount must be a positive whole number.');
  return db.transaction(() => {
    const reseller = db.prepare('SELECT status FROM resellers WHERE discord_id=?').get(userId);
    if (!reseller || reseller.status !== 'APPROVED') throw new Error('That user is not an approved reseller.');
    db.prepare('INSERT OR IGNORE INTO wallets(discord_id) VALUES(?)').run(userId);
    db.prepare('UPDATE wallets SET balance=balance+? WHERE discord_id=?').run(amount, userId);
    db.prepare('INSERT INTO wallet_transactions(discord_id,amount,kind,reference,actor_id) VALUES(?,?,?,?,?)').run(userId, amount, 'CREDIT', `credit:${crypto.randomUUID()}`, String(actorId));
    audit(db, actorId, 'WALLET_CREDIT', userId, `${amount}; ${note}`, 'SUCCESS');
    return db.prepare('SELECT balance FROM wallets WHERE discord_id=?').get(userId).balance;
  })();
}
function reviewWithdrawal(id, decision, note, actorId) {
  return db.transaction(() => {
    const request = db.prepare('SELECT * FROM reseller_withdrawals WHERE id=?').get(id);
    if (!request) throw new Error('Withdrawal request not found.');
    if (!['APPROVED', 'REJECTED', 'PAID'].includes(decision)) throw new Error('Invalid decision.');
    if (decision === 'PAID') {
      if (request.status !== 'APPROVED') throw new Error('Only an approved request can be marked paid. Approve it first and send the payout manually.');
    } else if (request.status !== 'PENDING') throw new Error('Only pending requests can be approved or rejected.');
    if (decision === 'APPROVED') {
      const wallet = db.prepare('SELECT balance FROM wallets WHERE discord_id=?').get(request.discord_id);
      if (!wallet || wallet.balance < request.amount) throw new Error('Wallet balance is no longer sufficient; reject this request or review it manually.');
      db.prepare('UPDATE wallets SET balance=balance-? WHERE discord_id=?').run(request.amount, request.discord_id);
      db.prepare('INSERT INTO wallet_transactions(discord_id,amount,kind,reference,actor_id) VALUES(?,?,?,?,?)').run(request.discord_id, -request.amount, 'WITHDRAWAL', `withdrawal:${id}`, String(actorId));
    }
    db.prepare("UPDATE reseller_withdrawals SET status=?,reviewed_by=?,review_note=?,reviewed_at=datetime('now') WHERE id=?").run(decision, String(actorId), note || '', id);
    audit(db, actorId, 'RESELLER_WITHDRAW_REVIEW', String(id), `${decision}; ${note || ''}`, 'SUCCESS');
    return request;
  })();
}
module.exports = { db, createOrder, submitPayment, approvePayment, rejectPayment, cancelOrder, expireStaleOrders, deliverOrder, setReseller, creditWallet, reviewWithdrawal };
