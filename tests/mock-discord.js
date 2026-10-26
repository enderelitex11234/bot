// Lightweight Discord mock used by flow.test.js. It never contacts Discord.
// It also checks outgoing payloads against Discord API limits (max 5 buttons per row, 4096-char embed
// descriptions, valid emoji, ...) because those are exactly the things that fail only on the real API.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const IDS = { ADMIN: '900000000000000001', USER: '700000000000000001', RESELLER: '700000000000000002', RESELLER_ROLE: '800000000000000001', GUILD: '500000000000000001', CHANNEL: '600000000000000001' };

function setupEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vortexia-flow-'));
  Object.assign(process.env, {
    DISCORD_TOKEN: 'test.token.value', CLIENT_ID: '123456789012345678', GUILD_ID: IDS.GUILD,
    DB_PATH: path.join(tmp, 'flow.sqlite'), ADMIN_USER_IDS: IDS.ADMIN, ADMIN_ROLE_IDS: '', ADMIN_LOG_CHANNEL_ID: '',
    RESELLER_ROLE_ID: IDS.RESELLER_ROLE, PAYMENT_BKASH_NUMBER: '01700000000', PAYMENT_NAGAD_NUMBER: '01800000000', PAYMENT_ROCKET_NUMBER: '01900000000',
    STORE_NAME: 'TEST STORE', LOW_STOCK_THRESHOLD: '3'
  });
  return tmp;
}

function validate(p) {
  const errs = [];
  if (!p || typeof p === 'string') return errs;
  for (const e of (p.embeds || []).map(x => (x.toJSON ? x.toJSON() : x))) {
    let total = (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length + (e.author?.name || '').length;
    if ((e.description || '').length > 4096) errs.push(`embed description ${e.description.length} > 4096`);
    if ((e.fields || []).length > 25) errs.push('more than 25 embed fields');
    for (const f of e.fields || []) { total += f.name.length + f.value.length; if (!f.name || !f.value) errs.push('empty embed field'); if (f.value.length > 1024) errs.push('field value > 1024'); }
    if (total > 6000) errs.push(`embed total ${total} > 6000`);
  }
  const rows = (p.components || []).map(r => (r.toJSON ? r.toJSON() : r));
  if (rows.length > 5) errs.push(`${rows.length} action rows (max 5)`);
  rows.forEach((r, i) => {
    if ((r.components || []).length > 5) errs.push(`action row ${i + 1} has ${r.components.length} components (max 5)`);
    for (const c of r.components || []) {
      if (c.emoji?.name && !c.emoji.id && !/\p{Extended_Pictographic}/u.test(c.emoji.name)) errs.push(`invalid button emoji "${c.emoji.name}"`);
      if ((c.label || '').length > 80) errs.push('button label > 80');
    }
  });
  if ((p.content || '').length > 2000) errs.push('content > 2000');
  return errs;
}

function makeWorld() {
  const mkUser = (id, extra = {}) => ({ id, tag: `user${id.slice(-2)}#0`, bot: false, createdTimestamp: 1600000000000, sent: [],
    displayAvatarURL: () => 'https://cdn.example.com/a.png', async send(m) { this.sent.push(m); return {}; }, ...extra });
  const users = { [IDS.ADMIN]: mkUser(IDS.ADMIN), [IDS.USER]: mkUser(IDS.USER), [IDS.RESELLER]: mkUser(IDS.RESELLER) };
  const posted = [];
  const channel = { id: IDS.CHANNEL, name: 'general', guildId: IDS.GUILD, type: 0, send: async m => { posted.push(m); return {}; }, bulkDelete: async n => ({ size: n }),
    isTextBased: () => true, permissionOverwrites: { edit: async () => {}, cache: new Map() }, toString: () => `<#${IDS.CHANNEL}>` };
  const guild = { id: IDS.GUILD, name: 'Test Guild', ownerId: IDS.ADMIN, memberCount: 3, createdTimestamp: 1600000000000, iconURL: () => null,
    channels: { cache: new Map([[IDS.CHANNEL, channel]]), fetch: async () => channel }, roles: { everyone: { id: IDS.GUILD } },
    members: { cache: new Map(), fetch: async function (id) { return id && typeof id === 'object' ? this.cache : { joinedTimestamp: 1600000000000, id }; } } };
  for (const id of [IDS.USER, IDS.RESELLER]) guild.members.cache.set(id, { id, user: users[id], send: m => users[id].send(m) });
  const client = { ws: { ping: 42 }, user: mkUser('123456789012345678', { tag: 'Bot#0' }), guilds: { cache: new Map([[IDS.GUILD, guild]]) }, channels: { fetch: async () => channel },
    users: { fetch: async id => users[id] || mkUser(id), send: async (id, m) => (users[id] || mkUser(id)).send(m) } };
  const violations = [];
  function base(who, roleIds) {
    const roles = { has: r => roleIds.includes(r) };
    const i = { user: users[who], guild, guildId: guild.id, channel, client, member: { roles: { cache: roles } }, memberPermissions: { has: () => false },
      replied: false, deferred: false, replies: [],
      isButton: () => false, isModalSubmit: () => false, isChatInputCommand: () => false };
    const record = p => { violations.push(...validate(p).map(e => `${i.commandName || i.customId}: ${e}`)); i.replies.push(p); };
    i.reply = async p => { if (i.replied || i.deferred) throw new Error('InteractionAlreadyReplied'); i.replied = true; record(p); };
    i.deferReply = async () => { if (i.replied || i.deferred) throw new Error('InteractionAlreadyReplied'); i.deferred = true; };
    i.editReply = async p => { if (!i.replied && !i.deferred) throw new Error('InteractionNotReplied'); record(p); i.replied = true; };
    i.followUp = async p => { if (!i.replied && !i.deferred) throw new Error('InteractionNotReplied'); record(p); };
    i.update = async p => { i.usedUpdate = true; record(p); i.replied = true; };
    i.showModal = async m => { i.modal = m; };
    return i;
  }
  function command(name, opts = {}, who = IDS.USER, roleIds = []) {
    const i = base(who, roleIds); i.commandName = name; i.isChatInputCommand = () => true;
    i.options = { getString: k => opts[k] ?? null, getInteger: k => opts[k] ?? null, getBoolean: k => opts[k] ?? null,
      getUser: k => (opts[k] ? users[opts[k]] || mkUser(opts[k]) : null), getChannel: k => (opts[k] ? channel : null) };
    return i;
  }
  function button(customId, who = IDS.USER, roleIds = []) { const i = base(who, roleIds); i.customId = customId; i.isButton = () => true; return i; }
  function modal(customId, values, who = IDS.ADMIN) {
    const i = base(who, []); i.customId = customId; i.isModalSubmit = () => true; i.isFromMessage = () => true;
    i.fields = { getTextInputValue: k => { if (!(k in values)) throw new Error(`no field ${k}`); return values[k]; } }; return i;
  }
  const text = p => (typeof p === 'string' ? p : (p.content || '') + (p.embeds || []).map(e => { const j = e.toJSON ? e.toJSON() : e; return `${j.title || ''}\n${j.description || ''}\n${(j.fields || []).map(f => `${f.name}: ${f.value}`).join('\n')}`; }).join('\n'));
  return { users, channel, guild, client, posted, violations, command, button, modal, text };
}
module.exports = { IDS, setupEnv, makeWorld, validate };
