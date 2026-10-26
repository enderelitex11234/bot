'use strict';
(() => {
  const app = document.getElementById('app');
  const toasts = document.getElementById('toasts');
  let csrf = null; let storeName = 'Vortexia'; let current = 'overview'; let timer = null;

  // ---------- tiny DOM helper (never uses innerHTML, so data can't inject markup) ----------
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(2)) { if (c == null || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
    return el;
  };
  const money = n => '৳' + Number(n || 0).toLocaleString('en-US');
  const date = s => { if (!s) return ''; const d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleString(); };
  const BAD = new Set(['REJECTED', 'CANCELLED', 'SUSPENDED', 'FAILED', 'REFUNDED']); const GOOD = new Set(['DELIVERED', 'APPROVED', 'PAID', 'SENT']);
  const badge = s => h('span', { class: 'badge ' + (BAD.has(s) ? 'bad' : GOOD.has(s) ? 'ok' : 'warn') }, s);
  const toast = (msg, type) => { const t = h('div', { class: 'toast ' + (type || '') }, msg); toasts.append(t); setTimeout(() => t.remove(), type === 'err' ? 7000 : 3500); };

  async function api(path, body, method) {
    const m = method || (body === undefined ? 'GET' : 'POST');
    const res = await fetch(path, { method: m, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: m === 'GET' ? undefined : JSON.stringify(body || {}) });
    let data = {}; try { data = await res.json(); } catch { /* not json */ }
    if (res.status === 401 && path !== '/api/login') { csrf = null; showLogin(); throw new Error('Session expired. Please log in again.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  async function act(fn, okMsg, after) {
    try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'good'); if (after) await after(); return r; }
    catch (e) { toast(e.message, 'err'); return null; }
  }

  // ---------- dialogs ----------
  function dialog(title, bodyNodes, buttons) {
    return new Promise(resolve => {
      const dlg = h('dialog', {}, h('h3', {}, title), bodyNodes);
      const done = v => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.append(h('div', { class: 'btns' }, buttons(done)));
      dlg.addEventListener('cancel', () => { dlg.remove(); resolve(null); });
      document.body.append(dlg); dlg.showModal();
    });
  }
  function askForm(title, fields, submit = 'Save') {
    const inputs = {};
    const nodes = fields.map(f => {
      let el;
      if (f.type === 'textarea') el = h('textarea', { value: f.value || '', placeholder: f.placeholder || '' });
      else if (f.type === 'select') el = h('select', {}, f.options.map(o => h('option', { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)));
      else el = h('input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '' });
      inputs[f.name] = el; return h('div', {}, h('label', {}, f.label), el);
    });
    return dialog(title, nodes, done => [
      h('button', { onclick: () => done(null) }, 'Cancel'),
      h('button', { class: 'primary', onclick: () => { const out = {}; for (const f of fields) out[f.name] = inputs[f.name].value; done(out); } }, submit)
    ]);
  }
  const confirmBox = (msg, label = 'Confirm') => dialog('Please confirm', [h('p', {}, msg)], done => [h('button', { onclick: () => done(false) }, 'Cancel'), h('button', { class: 'primary', onclick: () => done(true) }, label)]);
  const infoBox = (title, nodes, buttons) => dialog(title, nodes, done => [...(buttons ? buttons(done) : []), h('button', { onclick: () => done(null) }, 'Close')]);

  // ---------- table helper ----------
  function table(cols, rows, { onRow, empty = 'Nothing here yet.' } = {}) {
    if (!rows.length) return h('div', { class: 'empty' }, empty);
    return h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c.title)))),
      h('tbody', {}, rows.map(r => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? ev => { if (!ev.target.closest('button')) onRow(r); } : null },
        cols.map(c => h('td', { class: c.wrap ? 'wrap' : '' }, c.render ? c.render(r) : r[c.key])))))));
  }
  const btn = (label, fn, cls = '') => h('button', { class: 'small ' + cls, onclick: fn }, label);

  // ---------- pages ----------
  const pages = {};
  pages.overview = async root => {
    const d = await api('/api/overview'); const s = d.stats;
    const stat = (v, l) => h('div', { class: 'card stat' }, h('b', {}, v), h('span', {}, l));
    root.append(h('h2', {}, 'Overview'),
      h('div', { class: 'grid' }, stat(d.bot.ready ? 'Online' : 'Offline', d.bot.tag || 'Bot'), stat(d.bot.ping + ' ms', 'Gateway ping'), stat(d.bot.guilds, 'Servers'),
        stat(s.orders, 'Orders'), stat(s.delivered, 'Delivered'), stat(money(s.revenue), 'Delivered revenue'), stat(s.pendingPayments, 'Payments to verify'),
        stat(s.paidAwaitingDelivery, 'Paid, awaiting delivery'), stat(s.unpaidOrders, 'Unpaid orders'), stat(s.availableStock, 'Items in stock'), stat(s.pendingWithdrawals, 'Pending withdrawals'), stat(s.resellers, 'Resellers')),
      h('div', { class: 'card', style: 'margin-top:14px' }, h('div', { class: 'row' },
        h('div', {}, h('h3', {}, 'Shop maintenance'), h('span', { class: 'muted' }, d.maintenance ? 'ON: customers cannot browse or buy.' : 'OFF: shop is open.')),
        h('button', { class: d.maintenance ? 'ok' : 'danger', onclick: () => act(() => api('/api/settings/maintenance', { on: !d.maintenance }), r => 'Maintenance ' + (r.maintenance ? 'ON' : 'OFF'), render) }, d.maintenance ? 'Turn OFF' : 'Turn ON'))),
      h('div', { class: 'card' }, h('h3', {}, `Low stock (${d.lowStockThreshold} or fewer)`),
        table([{ title: 'ID', key: 'id' }, { title: 'Product', key: 'name' }, { title: 'Available', key: 'available' }], d.lowStockProducts, { empty: 'All products are stocked.' })),
      h('div', { class: 'card' }, h('h3', {}, 'Recent orders'),
        table([{ title: 'Order', key: 'id' }, { title: 'Status', render: r => badge(r.status) }, { title: 'Total', render: r => money(r.total_price) }, { title: 'Created', render: r => date(r.created_at) }], d.recentOrders, { empty: 'No orders yet.' })));
  };

  const productForm = (p = {}) => [
    { name: 'name', label: 'Name', value: p.name }, { name: 'retail_price', label: 'Retail price (BDT)', type: 'number', value: p.retail_price },
    { name: 'reseller_price', label: 'Reseller price (BDT, optional)', type: 'number', value: p.reseller_price ?? '' }, { name: 'category', label: 'Category (e.g. Hypixel, DonutSMP, Capes)', value: p.category || '' },
    { name: 'description', label: 'Description', type: 'textarea', value: p.description || '' }];
  pages.products = async root => {
    const { products } = await api('/api/products');
    root.append(h('h2', {}, 'Products'),
      h('div', { class: 'card' }, h('button', { class: 'primary', onclick: async () => { const v = await askForm('Add product', productForm(), 'Create'); if (v) act(() => api('/api/products', v), 'Product created', render); } }, '+ Add product')),
      h('div', { class: 'card' }, table([
        { title: 'ID', key: 'id' }, { title: 'Name', key: 'name', wrap: true }, { title: 'Category', render: r => r.category || '-' }, { title: 'Retail', render: r => money(r.retail_price) },
        { title: 'Reseller', render: r => r.reseller_price == null ? '-' : money(r.reseller_price) }, { title: 'Stock', render: r => `${r.available} (+${r.reserved} reserved)` }, { title: 'Status', render: r => badge(r.active ? 'ACTIVE' : 'HIDDEN') },
        { title: '', render: r => h('div', { class: 'actions' },
          btn('Edit', async () => { const v = await askForm(`Edit #${r.id}`, productForm(r)); if (v) act(() => api('/api/products/' + r.id, v), 'Saved', render); }),
          btn(r.active ? 'Hide' : 'Show', () => act(() => api('/api/products/' + r.id, { active: !r.active }), 'Updated', render))) }], products, { empty: 'No products yet. Add your first one above.' })));
  };

  pages.stock = async root => {
    const { products } = await api('/api/stock');
    root.append(h('h2', {}, 'Stock'), h('p', { class: 'muted' }, 'Secret values are never shown here, only IDs and counts.'));
    if (!products.length) root.append(h('div', { class: 'card empty' }, 'No active products yet.'));
    for (const p of products) root.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', {}, h('h3', {}, `#${p.id} ${p.name}`), h('span', { class: 'muted' }, `${p.available} available · ${p.reserved} reserved · ${p.delivered} delivered`)),
        h('button', { class: 'primary', onclick: async () => { const v = await askForm(`Add stock to #${p.id}`, [{ name: 'values', label: 'One item per line (keys, accounts, links...)', type: 'textarea', placeholder: 'ITEM-1\nITEM-2' }], 'Add'); if (v) act(() => api('/api/stock/' + p.id, v), r => `${r.added} item(s) added`, render); } }, '+ Add stock')),
      p.items.length ? h('div', { class: 'chips', style: 'margin-top:10px' }, p.items.map(i => h('span', { class: 'chip' }, `#${i.id}`, h('button', { title: 'Remove', onclick: async () => { if (await confirmBox(`Remove stock item #${i.id}?`, 'Remove')) act(() => api(`/api/stock/item/${i.id}/remove`, {}), 'Removed', render); } }, '×')))) : null));
  };

  async function orderDetail(id) {
    const d = await api('/api/orders/' + encodeURIComponent(id)); const o = d.order;
    const pending = d.payments.filter(p => p.status === 'PENDING_VERIFICATION');
    await infoBox(`Order ${o.id}`, [
      h('p', {}, badge(o.status), ' ', h('b', {}, money(o.total_price)), h('br'), h('span', { class: 'muted' }, `Customer ID ${o.discord_id} · ${date(o.created_at)}`)),
      table([{ title: 'Item', key: 'product_name', wrap: true }, { title: 'Qty', key: 'quantity' }, { title: 'Unit', render: r => money(r.unit_price) }], d.items),
      h('h3', { style: 'margin-top:12px' }, 'Payments'),
      table([{ title: '#', key: 'id' }, { title: 'Method', key: 'method' }, { title: 'Transaction', key: 'transaction_id', wrap: true }, { title: 'Status', render: r => badge(r.status) }], d.payments, { empty: 'No payment submitted.' }),
      d.delivery ? h('p', { class: 'muted' }, `Delivery ${d.delivery.status} at ${date(d.delivery.created_at)}`) : null], close => [
      ...pending.map(p => h('button', { class: 'ok', onclick: async () => { const v = await askForm(`Approve payment #${p.id}`, [{ name: 'reason', label: 'How did you verify it?', placeholder: 'Matched bKash statement' }], 'Approve'); if (v) { await act(() => api(`/api/payments/${p.id}/approve`, v), 'Payment approved'); close(true); } } }, `Approve #${p.id}`)),
      ...pending.map(p => h('button', { class: 'danger', onclick: async () => { const v = await askForm(`Reject payment #${p.id}`, [{ name: 'reason', label: 'Reason (sent to customer)' }], 'Reject'); if (v) { await act(() => api(`/api/payments/${p.id}/reject`, v), 'Payment rejected'); close(true); } } }, `Reject #${p.id}`)),
      o.status === 'PAID' ? h('button', { class: 'primary', onclick: async () => { await act(() => api(`/api/orders/${encodeURIComponent(o.id)}/deliver`, {}), 'Delivered by DM'); close(true); } }, 'Deliver by DM') : null,
      ['PENDING_PAYMENT', 'PENDING_VERIFICATION'].includes(o.status) ? h('button', { class: 'danger', onclick: async () => { if (await confirmBox('Cancel this order and release its stock?', 'Cancel order')) { await act(() => api(`/api/orders/${encodeURIComponent(o.id)}/cancel`, {}), r => `Cancelled, ${r.freed} item(s) released`); close(true); } } }, 'Cancel order') : null]);
  }
  const STATUSES = ['', 'PENDING_PAYMENT', 'PENDING_VERIFICATION', 'PAID', 'PROCESSING', 'DELIVERED', 'REJECTED', 'CANCELLED'];
  let orderFilter = '';
  pages.orders = async root => {
    const { orders } = await api('/api/orders' + (orderFilter ? '?status=' + orderFilter : ''));
    const sel = h('select', { onchange: e => { orderFilter = e.target.value; render(); } }, STATUSES.map(s => h('option', { value: s, selected: s === orderFilter }, s || 'All statuses')));
    root.append(h('h2', {}, 'Orders'), h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Filter'), sel))),
      h('div', { class: 'card' }, table([{ title: 'Order', key: 'id' }, { title: 'Status', render: r => badge(r.status) }, { title: 'Items', key: 'items', wrap: true }, { title: 'Total', render: r => money(r.total_price) }, { title: 'Customer', key: 'discord_id' }, { title: 'Created', render: r => date(r.created_at) }],
        orders, { empty: 'No orders found.', onRow: async r => { await act(() => orderDetail(r.id)); render(); } })));
  };

  let payFilter = 'PENDING_VERIFICATION';
  pages.payments = async root => {
    const { payments } = await api('/api/payments?status=' + payFilter);
    const sel = h('select', { onchange: e => { payFilter = e.target.value; render(); } }, ['PENDING_VERIFICATION', 'APPROVED', 'REJECTED'].map(s => h('option', { value: s, selected: s === payFilter }, s)));
    root.append(h('h2', {}, 'Payments'), h('p', { class: 'muted' }, 'The bot cannot verify bKash/Nagad/Rocket by itself. Check each transaction in your own wallet app before approving.'), h('div', { class: 'card' }, h('label', {}, 'Status'), sel),
      h('div', { class: 'card' }, table([{ title: '#', key: 'id' }, { title: 'Order', key: 'order_id' }, { title: 'Method', key: 'method' }, { title: 'Transaction ID', key: 'transaction_id', wrap: true }, { title: 'Amount', render: r => money(r.total_price) }, { title: 'Submitted', render: r => date(r.created_at) },
        { title: '', render: r => r.status !== 'PENDING_VERIFICATION' ? badge(r.status) : h('div', { class: 'actions' },
          btn('Approve', async () => { const v = await askForm(`Approve payment #${r.id}`, [{ name: 'reason', label: 'How did you verify it?', placeholder: 'Matched bKash statement' }], 'Approve'); if (v) act(() => api(`/api/payments/${r.id}/approve`, v), 'Payment approved', render); }, 'ok'),
          btn('Reject', async () => { const v = await askForm(`Reject payment #${r.id}`, [{ name: 'reason', label: 'Reason (sent to customer)' }], 'Reject'); if (v) act(() => api(`/api/payments/${r.id}/reject`, v), 'Payment rejected', render); }, 'danger')) }],
        payments, { empty: 'Nothing to review.' })));
  };

  let wdFilter = 'PENDING';
  pages.resellers = async root => {
    const [{ resellers }, { withdrawals }] = await Promise.all([api('/api/resellers'), api('/api/withdrawals' + (wdFilter ? '?status=' + wdFilter : ''))]);
    const idIn = h('input', { placeholder: 'Discord user ID (17-20 digits)' }); const stSel = h('select', {}, ['APPROVED', 'SUSPENDED'].map(s => h('option', { value: s }, s)));
    const wdSel = h('select', { onchange: e => { wdFilter = e.target.value; render(); } }, ['PENDING', 'APPROVED', 'PAID', 'REJECTED', ''].map(s => h('option', { value: s, selected: s === wdFilter }, s || 'All')));
    const review = (r, decision, label, cls) => btn(label, async () => { const v = await askForm(`${label} #${r.id}`, [{ name: 'note', label: 'Note (optional)' }], label); if (v) act(() => api('/api/withdrawals/' + r.id, { decision, note: v.note }), 'Updated', render); }, cls);
    root.append(h('h2', {}, 'Resellers'),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Add / update reseller'), idIn), h('div', {}, h('label', {}, 'Status'), stSel), h('button', { class: 'primary', onclick: () => act(() => api('/api/resellers', { discord_id: idIn.value, status: stSel.value }), 'Saved', render) }, 'Save'))),
      h('div', { class: 'card' }, table([{ title: 'Discord ID', key: 'discord_id' }, { title: 'Status', render: r => badge(r.status) }, { title: 'Balance', render: r => money(r.balance) }, { title: 'Pending withdrawals', render: r => money(r.pending) },
        { title: '', render: r => h('div', { class: 'actions' },
          btn('Add balance', async () => { const v = await askForm('Add wallet balance', [{ name: 'amount', label: 'Amount (BDT)', type: 'number' }, { name: 'note', label: 'Note (optional)' }], 'Credit'); if (v) act(() => api(`/api/resellers/${r.discord_id}/credit`, v), x => 'New balance ' + money(x.balance), render); }),
          btn(r.status === 'APPROVED' ? 'Suspend' : 'Approve', () => act(() => api('/api/resellers', { discord_id: r.discord_id, status: r.status === 'APPROVED' ? 'SUSPENDED' : 'APPROVED' }), 'Updated', render), r.status === 'APPROVED' ? 'danger' : 'ok')) }], resellers, { empty: 'No resellers yet.' })),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', {}, 'Withdrawal requests'), h('div', {}, wdSel)),
        table([{ title: '#', key: 'id' }, { title: 'Reseller', key: 'discord_id' }, { title: 'Amount', render: r => money(r.amount) }, { title: 'Method', key: 'method' }, { title: 'Payout details', key: 'payout_details', wrap: true }, { title: 'Status', render: r => badge(r.status) }, { title: 'Requested', render: r => date(r.created_at) },
          { title: '', render: r => h('div', { class: 'actions' }, r.status === 'PENDING' ? [review(r, 'APPROVED', 'Approve', 'ok'), review(r, 'REJECTED', 'Reject', 'danger')] : null, r.status === 'APPROVED' ? review(r, 'PAID', 'Mark paid', 'ok') : null) }], withdrawals, { empty: 'No requests.' })));
  };

  pages.coupons = async root => {
    const { coupons } = await api('/api/coupons');
    const f = { code: h('input', { placeholder: 'SAVE10' }), kind: h('select', {}, h('option', { value: 'PERCENT' }, 'Percent %'), h('option', { value: 'FIXED' }, 'Fixed BDT')), amount: h('input', { type: 'number', placeholder: '10' }), max: h('input', { type: 'number', placeholder: 'unlimited' }) };
    root.append(h('h2', {}, 'Coupons'), h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Code'), f.code), h('div', {}, h('label', {}, 'Type'), f.kind), h('div', {}, h('label', {}, 'Amount'), f.amount), h('div', {}, h('label', {}, 'Max uses'), f.max),
      h('button', { class: 'primary', onclick: () => act(() => api('/api/coupons', { code: f.code.value, kind: f.kind.value, amount: f.amount.value, max_uses: f.max.value }), 'Coupon created', render) }, 'Create'))),
      h('div', { class: 'card' }, table([{ title: 'Code', key: 'code' }, { title: 'Discount', render: r => r.kind === 'PERCENT' ? r.amount + '%' : money(r.amount) }, { title: 'Used', render: r => `${r.uses}${r.max_uses ? ' / ' + r.max_uses : ''}` }, { title: 'Status', render: r => badge(r.active ? 'ACTIVE' : 'DISABLED') },
        { title: '', render: r => btn(r.active ? 'Disable' : 'Enable', () => act(() => api('/api/coupons/' + encodeURIComponent(r.code) + '/toggle', {}), 'Updated', render)) }], coupons, { empty: 'No coupons yet.' })));
  };

  // ----- embed sender with live preview -----
  const E = { channelId: '', content: '', title: '', description: '', color: '#FF6A00', image: '', thumbnail: '', footer: '', author: '', titleUrl: '', timestamp: true, fields: [], links: [] };
  pages.embed = async root => {
    const { channels } = await api('/api/channels');
    const preview = h('div', { class: 'preview' });
    const paint = () => {
      preview.replaceChildren(); preview.style.borderLeftColor = /^#[0-9a-f]{6}$/i.test(E.color) ? E.color : '#ff6a00';
      if (E.author) preview.append(h('div', { class: 'muted' }, E.author));
      if (E.title) preview.append(h('div', { class: 't' }, E.title));
      if (E.description) preview.append(h('div', { class: 'd' }, E.description));
      if (E.fields.length) preview.append(h('div', { class: 'fs' }, E.fields.map(f => h('div', { class: 'f' }, h('b', {}, f.name), f.value))));
      if (/^https:\/\//.test(E.image)) preview.append(h('img', { src: E.image, alt: '' }));
      if (E.footer || E.timestamp) preview.append(h('div', { class: 'ft' }, [E.footer, E.timestamp ? new Date().toLocaleString() : ''].filter(Boolean).join(' • ')));
      if (E.links.length) preview.append(h('div', { class: 'actions', style: 'margin-top:8px' }, E.links.map(l => h('button', { class: 'small', type: 'button' }, '↗ ' + l.label))));
      if (!preview.childNodes.length) preview.append(h('span', { class: 'muted' }, 'Your embed preview appears here.'));
    };
    const bind = (key, label, type = 'text', ph = '') => { const el = type === 'textarea' ? h('textarea', { value: E[key], placeholder: ph }) : h('input', { type, value: E[key], placeholder: ph }); el.addEventListener('input', () => { E[key] = el.value; paint(); }); return h('div', {}, h('label', {}, label), el); };
    const chSel = h('select', { onchange: e => { E.channelId = e.target.value; } }, h('option', { value: '' }, channels.length ? 'Choose a channel...' : 'Bot has no visible channels yet'), channels.map(c => h('option', { value: c.id, selected: c.id === E.channelId }, `${c.guild} › #${c.name}`)));
    const fieldsBox = h('div'); const linksBox = h('div');
    const drawLists = () => {
      fieldsBox.replaceChildren(...E.fields.map((f, i) => h('div', { class: 'fieldrow' },
        h('input', { placeholder: 'Field name', value: f.name, oninput: e => { f.name = e.target.value; paint(); } }), h('input', { placeholder: 'Field value', value: f.value, oninput: e => { f.value = e.target.value; paint(); } }),
        h('label', { class: 'checkline' }, h('input', { type: 'checkbox', checked: f.inline, onchange: e => { f.inline = e.target.checked; } }), 'inline'), btn('✕', () => { E.fields.splice(i, 1); drawLists(); paint(); }, 'danger'))));
      linksBox.replaceChildren(...E.links.map((l, i) => h('div', { class: 'fieldrow' },
        h('input', { placeholder: 'Button label', value: l.label, oninput: e => { l.label = e.target.value; paint(); } }), h('input', { placeholder: 'https://...', value: l.url, oninput: e => { l.url = e.target.value; } }), h('span'), btn('✕', () => { E.links.splice(i, 1); drawLists(); paint(); }, 'danger'))));
    };
    const send = h('button', { class: 'primary', onclick: async () => { if (!E.channelId) return toast('Choose a channel first.', 'err'); if (await confirmBox('Send this message to the selected channel now?', 'Send')) act(() => api('/api/embed/send', E), 'Sent!'); } }, 'Send to Discord');
    root.append(h('h2', {}, 'Embed sender'), h('div', { class: 'row', style: 'align-items:flex-start' },
      h('div', { class: 'card', style: 'flex:3;min-width:300px' }, h('label', {}, 'Channel'), chSel, bind('content', 'Message text above the embed (optional)'), bind('title', 'Title'), bind('description', 'Description', 'textarea'),
        h('div', { class: 'row' }, bind('color', 'Color (HEX)'), bind('footer', 'Footer')), h('div', { class: 'row' }, bind('image', 'Large image URL (https)'), bind('thumbnail', 'Thumbnail URL (https)')),
        h('div', { class: 'row' }, bind('author', 'Author name'), bind('titleUrl', 'Title link (https)')),
        h('label', { class: 'checkline' }, h('input', { type: 'checkbox', checked: E.timestamp, onchange: e => { E.timestamp = e.target.checked; paint(); } }), 'Show timestamp'),
        h('h3', { style: 'margin-top:14px' }, 'Fields (max 10)'), fieldsBox, btn('+ Field', () => { if (E.fields.length < 10) { E.fields.push({ name: '', value: '', inline: false }); drawLists(); } }),
        h('h3', { style: 'margin-top:14px' }, 'Link buttons (max 5)'), linksBox, btn('+ Button', () => { if (E.links.length < 5) { E.links.push({ label: '', url: '' }); drawLists(); } }),
        h('div', { style: 'margin-top:16px' }, send)),
      h('div', { class: 'card', style: 'flex:2;min-width:260px' }, h('h3', {}, 'Preview'), preview)));
    drawLists(); paint();
  };

  let auditAction = '';
  pages.audit = async root => {
    const { logs } = await api('/api/audit?limit=150' + (auditAction ? '&action=' + encodeURIComponent(auditAction) : ''));
    const inp = h('input', { placeholder: 'Filter by exact action, e.g. PAYMENT_APPROVE', value: auditAction });
    root.append(h('h2', {}, 'Audit log'), h('div', { class: 'card' }, h('div', { class: 'row' }, inp, h('button', { onclick: () => { auditAction = inp.value.trim(); render(); } }, 'Filter'))),
      h('div', { class: 'card' }, table([{ title: 'When', render: r => date(r.created_at) }, { title: 'Who', key: 'actor_id' }, { title: 'Action', key: 'action' }, { title: 'Target', key: 'target', wrap: true }, { title: 'Details', key: 'reason', wrap: true }, { title: 'Result', render: r => badge(r.result) }], logs, { empty: 'No entries.' })));
  };

  // ---------- shell ----------
  const NAV = [['overview', 'Overview'], ['products', 'Products'], ['stock', 'Stock'], ['orders', 'Orders'], ['payments', 'Payments'], ['resellers', 'Resellers'], ['coupons', 'Coupons'], ['embed', 'Embed sender'], ['audit', 'Audit log']];
  async function render() {
    clearInterval(timer);
    const main = document.getElementById('main'); if (!main) return;
    document.querySelectorAll('nav button[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === current));
    const fresh = h('div'); main.replaceChildren(fresh);
    try { await pages[current](fresh); } catch (e) { if (csrf) fresh.append(h('div', { class: 'card' }, h('b', {}, 'Could not load this page. '), e.message)); }
    if (current === 'overview') timer = setInterval(() => { if (!document.querySelector('dialog[open]')) render(); }, 20000);
  }
  function showApp() {
    app.replaceChildren(h('div', { class: 'shell' },
      h('nav', {}, h('h1', {}, h('span', {}, '◆ '), storeName), NAV.map(([k, label]) => h('button', { 'data-page': k, onclick: () => { current = k; render(); } }, label)), h('div', { class: 'spacer' }),
        h('button', { onclick: () => render() }, '↻ Refresh'), h('button', { onclick: async () => { await api('/api/logout', {}).catch(() => {}); csrf = null; showLogin(); } }, 'Log out')),
      h('main', { id: 'main' })));
    render();
  }
  function showLogin(msg) {
    clearInterval(timer);
    const pw = h('input', { type: 'password', placeholder: 'Dashboard password', autofocus: true });
    const go = async () => { try { const r = await api('/api/login', { password: pw.value }); csrf = r.csrf; showApp(); } catch (e) { toast(e.message, 'err'); pw.select(); } };
    pw.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    app.replaceChildren(h('div', { class: 'login' }, h('h2', {}, `◆ ${storeName}`), h('p', { class: 'muted' }, 'Local dashboard. The password is printed in the bot console when it starts (or set DASHBOARD_PASSWORD in .env).'), h('label', {}, 'Password'), pw, h('div', { style: 'margin-top:14px' }, h('button', { class: 'primary', onclick: go }, 'Log in'))));
    if (msg) toast(msg, 'err');
  }
  (async () => { try { const me = await api('/api/me'); storeName = me.storeName || storeName; document.title = storeName + ' Dashboard'; if (me.authed) { csrf = me.csrf; showApp(); } else showLogin(); } catch (e) { showLogin(); } })();
})();
