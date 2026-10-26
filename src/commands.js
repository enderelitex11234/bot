const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const config = require('./config');
const { db, createOrder, submitPayment, approvePayment, rejectPayment, cancelOrder, deliverOrder, setReseller, creditWallet, reviewWithdrawal } = require('./services');
const { isAdmin, audit } = require('./security');
const embedBuilder = require('./embed-builder');

const commands = [
  new SlashCommandBuilder().setName('shop').setDescription('Browse available Vortexia Store products'),
  new SlashCommandBuilder().setName('categories').setDescription('List product categories'),
  new SlashCommandBuilder().setName('search').setDescription('Search products').addStringOption(o=>o.setName('query').setDescription('Name or keyword').setRequired(true)),
  new SlashCommandBuilder().setName('product').setDescription('View a product').addIntegerOption(o=>o.setName('id').setDescription('Product ID').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('buy').setDescription('Create an order').addIntegerOption(o=>o.setName('product_id').setDescription('Product ID').setRequired(true).setMinValue(1)).addIntegerOption(o=>o.setName('quantity').setDescription('Quantity').setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName('my-orders').setDescription('View your recent orders'),
  new SlashCommandBuilder().setName('track-order').setDescription('Track your order').addStringOption(o=>o.setName('order_id').setDescription('Order reference').setRequired(true)),
  new SlashCommandBuilder().setName('payment-methods').setDescription('View configured payment instructions'),
  new SlashCommandBuilder().setName('payment-submit').setDescription('Submit a payment transaction for review').addStringOption(o=>o.setName('order_id').setDescription('Order reference').setRequired(true)).addStringOption(o=>o.setName('method').setDescription('Payment method').setRequired(true).addChoices({name:'bKash',value:'bKash'},{name:'Nagad',value:'Nagad'},{name:'Rocket',value:'Rocket'})).addStringOption(o=>o.setName('transaction_id').setDescription('Transaction reference').setRequired(true)),
  new SlashCommandBuilder().setName('help').setDescription('Show shop commands'),
  new SlashCommandBuilder().setName('admin-product-add').setDescription('Add a product (admin only)').addStringOption(o=>o.setName('name').setDescription('Product name').setRequired(true)).addIntegerOption(o=>o.setName('price').setDescription('Price in BDT integer taka').setRequired(true).setMinValue(0)).addStringOption(o=>o.setName('description').setDescription('Description').setRequired(false)).addStringOption(o=>o.setName('category').setDescription('Category name').setRequired(false)).addIntegerOption(o=>o.setName('reseller_price').setDescription('Reseller price in BDT (optional)').setRequired(false).setMinValue(0)),
  new SlashCommandBuilder().setName('admin-stock-add').setDescription('Add one private stock item (admin only)').addIntegerOption(o=>o.setName('product_id').setDescription('Product ID').setRequired(true).setMinValue(1)).addStringOption(o=>o.setName('value').setDescription('Secret delivery value').setRequired(true)),
  new SlashCommandBuilder().setName('admin-orders').setDescription('List pending payment verifications (admin only)'),
  new SlashCommandBuilder().setName('admin-approve').setDescription('Approve a payment after independent verification (admin only)').addIntegerOption(o=>o.setName('payment_id').setDescription('Payment ID').setRequired(true).setMinValue(1)).addStringOption(o=>o.setName('reason').setDescription('Verification notes').setRequired(true)),
  new SlashCommandBuilder().setName('admin-deliver').setDescription('Deliver a PAID order by DM from reserved stock (admin only)').addStringOption(o=>o.setName('order_id').setDescription('Order reference').setRequired(true)),
  new SlashCommandBuilder().setName('delivery').setDescription('Send a product or license directly to a user by DM (admin only)').addUserOption(o=>o.setName('user').setDescription('Customer who should receive the product').setRequired(true)).addStringOption(o=>o.setName('product').setDescription('Product name and delivery details').setRequired(true).setMaxLength(1800)),
  new SlashCommandBuilder().setName('admin-stats').setDescription('Show basic store statistics (admin only)'),
  new SlashCommandBuilder().setName('admin-backup').setDescription('Create a SQLite backup (admin only)'),
  new SlashCommandBuilder().setName('admin-coupon-create').setDescription('Create a coupon (admin only)').addStringOption(o=>o.setName('code').setDescription('Coupon code, letters/numbers/_/-').setRequired(true).setMaxLength(64)).addStringOption(o=>o.setName('kind').setDescription('Discount type').setRequired(true).addChoices({name:'fixed BDT',value:'FIXED'},{name:'percent',value:'PERCENT'})).addIntegerOption(o=>o.setName('amount').setDescription('BDT amount or percentage (1-100 for percent)').setRequired(true).setMinValue(1).setMaxValue(1000000)).addIntegerOption(o=>o.setName('max_uses').setDescription('Maximum redemptions; omit for unlimited').setMinValue(1).setMaxValue(1000000)),
  new SlashCommandBuilder().setName('dm').setDescription('Send a direct message to a user (admin only)').addUserOption(o=>o.setName('user').setDescription('Recipient').setRequired(true)).addStringOption(o=>o.setName('message').setDescription('Message to send').setRequired(true).setMaxLength(1800)),
  new SlashCommandBuilder().setName('dmall').setDescription('Send a rate-limited DM to server members (admin only)').addStringOption(o=>o.setName('message').setDescription('Message to send').setRequired(true).setMaxLength(1500)).addIntegerOption(o=>o.setName('limit').setDescription('Maximum cached members to contact (1-25)').setMinValue(1).setMaxValue(25)),
  new SlashCommandBuilder().setName('ping').setDescription('Show bot latency'),
  new SlashCommandBuilder().setName('redeem').setDescription('Redeem a coupon against your pending order').addStringOption(o=>o.setName('code').setDescription('Coupon code').setRequired(true).setMaxLength(64)).addStringOption(o=>o.setName('order_id').setDescription('Your pending order ID').setRequired(true).setMaxLength(80)),
  new SlashCommandBuilder().setName('uptime').setDescription('Show bot uptime'),
  new SlashCommandBuilder().setName('botinfo').setDescription('Show bot information'),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Show this server information'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Show a member profile').addUserOption(o=>o.setName('user').setDescription('Member to inspect').setRequired(false)),
  new SlashCommandBuilder().setName('avatar').setDescription('Show a user avatar').addUserOption(o=>o.setName('user').setDescription('User').setRequired(false)),
  new SlashCommandBuilder().setName('announce').setDescription('Post an announcement to a channel (admin only)').addChannelOption(o=>o.setName('channel').setDescription('Destination text channel').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true)).addStringOption(o=>o.setName('message').setDescription('Announcement text').setRequired(true).setMaxLength(1800)),
  new SlashCommandBuilder().setName('embed').setDescription('Open the interactive Vortexia Embed Builder (admin only)').addChannelOption(o=>o.setName('channel').setDescription('Destination text channel').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true)),
  new SlashCommandBuilder().setName('say').setDescription('Post a message to a channel (admin only)').addChannelOption(o=>o.setName('channel').setDescription('Destination text channel').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true)).addStringOption(o=>o.setName('message').setDescription('Message content').setRequired(true).setMaxLength(1800)),
  new SlashCommandBuilder().setName('purge').setDescription('Delete recent messages (admin only)').addIntegerOption(o=>o.setName('amount').setDescription('Number of messages, 1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName('warn').setDescription('Record a moderation warning (admin only)').addUserOption(o=>o.setName('user').setDescription('Member to warn').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('lock').setDescription('Lock or unlock this channel (admin only)').addStringOption(o=>o.setName('action').setDescription('Lock or unlock').setRequired(true).addChoices({name:'lock',value:'lock'},{name:'unlock',value:'unlock'})),
  new SlashCommandBuilder().setName('stock').setDescription('Show available stock for products').addIntegerOption(o=>o.setName('product_id').setDescription('Product ID (optional)').setMinValue(1)),
  new SlashCommandBuilder().setName('admin-stock-list').setDescription('Show detailed stock inventory (admin only)'),
  new SlashCommandBuilder().setName('admin-stock-update').setDescription('Add or remove an available stock item (admin only)').addIntegerOption(o=>o.setName('product_id').setDescription('Product ID').setRequired(true).setMinValue(1)).addStringOption(o=>o.setName('action').setDescription('Stock action').setRequired(true).addChoices({name:'Add item',value:'add'},{name:'Remove available item',value:'remove'})).addStringOption(o=>o.setName('value').setDescription('Secret delivery value (required for Add)').setRequired(false).setMaxLength(2000)).addIntegerOption(o=>o.setName('stock_id').setDescription('Stock item ID (required for Remove)').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder().setName('payment-status').setDescription('Check payment status for your order').addStringOption(o=>o.setName('order_id').setDescription('Order ID').setRequired(true).setMaxLength(80)),
  new SlashCommandBuilder().setName('order-info').setDescription('View an order you own, or any order as admin').addStringOption(o=>o.setName('order_id').setDescription('Order ID').setRequired(true).setMaxLength(80)),
  new SlashCommandBuilder().setName('maintenance').setDescription('Enable or disable shop maintenance (admin only)').addStringOption(o=>o.setName('action').setDescription('Mode').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'})),
  new SlashCommandBuilder().setName('reseller-transactions').setDescription('View your recent reseller wallet transaction history'),
  new SlashCommandBuilder().setName('reseller-withdraw').setDescription('Submit a reseller wallet withdrawal request').addIntegerOption(o=>o.setName('amount').setDescription('Amount in BDT').setRequired(true).setMinValue(1).setMaxValue(10000000)).addStringOption(o=>o.setName('method').setDescription('Payout method').setRequired(true).addChoices({name:'bKash',value:'bKash'},{name:'Nagad',value:'Nagad'},{name:'Rocket',value:'Rocket'},{name:'LTC',value:'LTC'})).addStringOption(o=>o.setName('payout_details').setDescription('Your payout number or wallet address (private)').setRequired(true).setMinLength(5).setMaxLength(180)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the top resellers by recorded positive wallet transactions'),
  new SlashCommandBuilder().setName('admin-withdrawals').setDescription('List pending reseller withdrawal requests (admin only)'),
  new SlashCommandBuilder().setName('admin-withdrawal-review').setDescription('Review a withdrawal request (admin only)').addIntegerOption(o=>o.setName('request_id').setDescription('Withdrawal request ID').setRequired(true).setMinValue(1)).addStringOption(o=>o.setName('decision').setDescription('Approve or reject request').setRequired(true).addChoices({name:'approve',value:'APPROVED'},{name:'reject',value:'REJECTED'},{name:'mark paid',value:'PAID'})).addStringOption(o=>o.setName('note').setDescription('Optional staff note').setMaxLength(300)),
  new SlashCommandBuilder().setName('cancel-order').setDescription('Cancel your unpaid order and release its stock').addStringOption(o=>o.setName('order_id').setDescription('Order reference').setRequired(true).setMaxLength(80)),
  new SlashCommandBuilder().setName('admin-reject').setDescription('Reject a submitted payment (admin only)').addIntegerOption(o=>o.setName('payment_id').setDescription('Payment ID').setRequired(true).setMinValue(1)).addStringOption(o=>o.setName('reason').setDescription('Reason shown to the customer').setRequired(true).setMaxLength(300)),
  new SlashCommandBuilder().setName('admin-reseller-set').setDescription('Approve or suspend a reseller (admin only)').addUserOption(o=>o.setName('user').setDescription('Reseller').setRequired(true)).addStringOption(o=>o.setName('status').setDescription('New status').setRequired(true).addChoices({name:'approve',value:'APPROVED'},{name:'suspend',value:'SUSPENDED'})),
  new SlashCommandBuilder().setName('admin-wallet-credit').setDescription('Add balance to a reseller wallet (admin only)').addUserOption(o=>o.setName('user').setDescription('Reseller').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('BDT amount to add').setRequired(true).setMinValue(1).setMaxValue(10000000)).addStringOption(o=>o.setName('note').setDescription('Reference note').setMaxLength(100)),
  new SlashCommandBuilder().setName('dm-optout').setDescription('Opt out of server-wide bot DMs').addBooleanOption(o=>o.setName('opt_out').setDescription('True to opt out, false to allow these messages').setRequired(true)),
].map(c => c.toJSON());

// Discord permits at most 100 top-level CHAT_INPUT commands per application.
// These compatibility aliases reuse the existing, tested command schemas and handlers.
const aliasTarget = {
  'commands':'help','product-list':'shop','product-info':'product','product-search':'search','product-categories':'categories',
  'product-stock':'stock','product-price':'product','featured-products':'shop','new-products':'shop','popular-products':'shop',
  'order-history':'my-orders','order-status':'track-order','payment-info':'payment-methods','payment-help':'payment-methods',
  'reseller-info':'reseller-transactions','reseller-balance':'reseller-transactions','reseller-sales':'reseller-transactions',
  'wallet':'reseller-transactions','balance':'reseller-transactions','transactions':'reseller-transactions',
  'withdraw-status':'reseller-transactions','withdraw-history':'reseller-transactions',
  'database-backup':'admin-backup','database-status':'admin-stats','bot-diagnostics':'botinfo','system-status':'botinfo'
};
for (const [alias, target] of Object.entries(aliasTarget)) {
  const base = commands.find(c => c.name === target);
  if (!base) throw new Error(`Alias ${alias} points to missing command ${target}`);
  const isAdminTarget = target.startsWith('admin-');
  commands.push({ ...base, name: alias, description: isAdminTarget ? `Alias of /${target} (admin only)` : `Alias of /${target}` });
}
commands.push(new SlashCommandBuilder().setName('support').setDescription('Get VORTEXIA STORE support guidance').toJSON());
commands.push(new SlashCommandBuilder().setName('feedback').setDescription('Send private feedback to store admins').addStringOption(o=>o.setName('message').setDescription('Your feedback (no passwords or payment secrets)').setRequired(true).setMinLength(5).setMaxLength(800)).toJSON());
if (commands.length > 100) throw new Error(`Discord slash-command limit exceeded: ${commands.length}/100`);
if (new Set(commands.map(c => c.name)).size !== commands.length) throw new Error('Duplicate slash command names detected');

function money(amount) { return `৳${amount}`; }
function productEmbed(p, stock) {
  return new EmbedBuilder().setColor(0x6d4aff).setTitle(`${p.name} (#${p.id})`).setDescription(p.description || 'No description provided.')
    .addFields({name:'Price',value:money(p.retail_price),inline:true},{name:'Available stock',value:String(stock),inline:true})
    .setFooter({text:config.storeName});
}
const startedAt = Date.now();
function isMaintained() { return db.prepare("SELECT value FROM bot_settings WHERE key='maintenance'").get()?.value === 'on'; }
function canAdmin(interaction) { return isAdmin(interaction) || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)); }
function safeText(s, max=1800) { return String(s || '').replace(/@everyone/g, '@ everyone').replace(/@here/g, '@ here').slice(0,max); }
function countStock(productId) { return db.prepare("SELECT COUNT(*) AS n FROM product_stock WHERE product_id=? AND status='AVAILABLE'").get(productId).n; }
function duration(ms) { const sec=Math.floor(ms/1000); return `${Math.floor(sec/86400)}d ${Math.floor(sec%86400/3600)}h ${Math.floor(sec%3600/60)}m ${sec%60}s`; }
function recordWarning(guildId, userId, moderatorId, reason) { return db.prepare('INSERT INTO moderation_warnings(guild_id,user_id,moderator_id,reason) VALUES(?,?,?,?)').run(guildId,userId,moderatorId,reason); }

function stockLabel(n) { return n > 0 ? (n <= config.lowStockThreshold ? `🟠 LOW STOCK · ${n}` : `🟢 IN STOCK · ${n}`) : '🔴 OUT OF STOCK'; }
function productBlock(p, reseller=false) {
  const price = reseller
    ? (p.reseller_price !== null && p.reseller_price !== undefined ? `${money(p.reseller_price)} (retail ${money(p.retail_price)})` : `${money(p.retail_price)} (no reseller price set)`)
    : money(p.retail_price);
  return `**▰ ${safeText(p.name,80)}**\n> ${safeText(p.description || 'Premium digital product', 130)}\n> **Price:** ${price}  •  **ID:** \`#${p.id}\`\n> ${stockLabel(countStock(p.id))}`;
}
// Builds a shop embed that always fits Discord's 4096-character description limit.
function shopEmbed(rows, { title, client, reseller=false }) {
  const header = '**Premium digital products. Secure checkout. Fast delivery.**\n━━━━━━━━━━━━━━━━━━━━\n';
  const howTo = '\n\n**How to order**\nSelect **Purchase** below, then use `/buy` with the product ID. Pay only through the listed official methods.';
  const budget = 4000 - header.length - howTo.length - 90;
  const blocks = []; let used = 0;
  for (const p of rows) { const b = productBlock(p, reseller); if (used + b.length + 2 > budget) break; blocks.push(b); used += b.length + 2; }
  let body = rows.length ? blocks.join('\n\n') : '*No products found. Please check back later.*';
  if (rows.length > blocks.length) body += `\n\n*…and ${rows.length - blocks.length} more. Use \`/search\` to narrow the list.*`;
  const e = new EmbedBuilder().setColor(0x101014).setAuthor({name:'VORTEXIA STORE  •  DIGITAL MARKETPLACE'}).setTitle(title)
    .setDescription(header + body + howTo).setTimestamp();
  const footer = { text: 'VORTEXIA STORE • Trusted Digital Goods' };
  const icon = client?.user?.displayAvatarURL?.();
  if (icon) footer.iconURL = icon;
  return e.setFooter(footer);
}
function shopButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vortex_shop:purchase').setLabel('🛒 Purchase').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('vortex_shop:hypixel').setLabel('⚔️ Hypixel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vortex_shop:donut').setLabel('🍩 DonutSMP').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vortex_shop:capes').setLabel('🖼️ Capes').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vortex_shop:reseller').setLabel('💱 Reseller Price').setStyle(ButtonStyle.Secondary)
  );
}
const SHOP_FILTERS = { hypixel:{label:'Hypixel', term:'hypixel'}, donut:{label:'DonutSMP', term:'donut'}, capes:{label:'Capes', term:'cape'} };
function productsMatching(term) {
  const q = `%${term}%`;
  return db.prepare('SELECT p.* FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.active=1 AND (p.name LIKE ? OR p.description LIKE ? OR c.name LIKE ?) ORDER BY p.id DESC LIMIT 50').all(q,q,q);
}
async function handleShopComponent(interaction) {
  const action = String(interaction.customId || '').split(':')[1];
  if (isMaintained() && !canAdmin(interaction)) return interaction.reply({content:'The shop is currently under maintenance. Please try again later.',flags:MessageFlags.Ephemeral});
  if (action === 'purchase') {
    return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle('🛒 How to purchase')
      .setDescription('1. Pick a product ID from `/shop`.\n2. Run `/buy product_id:<ID> quantity:<1-10>` to create your order.\n3. Run `/payment-methods`, pay using an official number, then submit with `/payment-submit`.\n4. Staff verify your payment manually; delivery arrives by DM once approved. Keep your DMs open.\n\nTrack anything with `/my-orders` or `/payment-status`.')],flags:MessageFlags.Ephemeral});
  }
  if (SHOP_FILTERS[action]) {
    const f = SHOP_FILTERS[action];
    return interaction.reply({embeds:[shopEmbed(productsMatching(f.term), {title:`${f.label} — PRODUCTS`, client:interaction.client})], components:[shopButtons()], flags:MessageFlags.Ephemeral});
  }
  if (action === 'reseller') {
    if (!config.resellerRoleId) return interaction.reply({content:'Reseller pricing is not configured yet. An admin must set RESELLER_ROLE_ID.',flags:MessageFlags.Ephemeral});
    const hasRole = Boolean(interaction.member?.roles?.cache?.has?.(config.resellerRoleId));
    if (!hasRole && !canAdmin(interaction)) return interaction.reply({content:'Reseller prices are only visible to members with the reseller role.',flags:MessageFlags.Ephemeral});
    const rows = db.prepare('SELECT * FROM products WHERE active=1 AND reseller_price IS NOT NULL ORDER BY id DESC LIMIT 50').all();
    return interaction.reply({embeds:[shopEmbed(rows, {title:'💱 RESELLER PRICES', client:interaction.client, reseller:true})], components:[shopButtons()], flags:MessageFlags.Ephemeral});
  }
  return interaction.reply({content:'This button is no longer available. Please use /shop again.',flags:MessageFlags.Ephemeral});
}
async function handle(interaction, client) {
  const requestedName = interaction.commandName;
  const name = aliasTarget[requestedName] || requestedName;
  if (requestedName === 'support') return interaction.reply({content:'VORTEXIA STORE support: contact a store administrator through the server support channel. Automated ticket creation is not configured in this build.', flags:MessageFlags.Ephemeral});
  if (requestedName === 'feedback') { const message = safeText(interaction.options.getString('message').trim(), 800); if (message.length < 5) return interaction.reply({content:'Feedback must be at least 5 characters.', flags:MessageFlags.Ephemeral}); audit(db, interaction.user.id, 'USER_FEEDBACK', interaction.guildId || 'DM', message, 'RECEIVED'); if (config.adminLogChannelId) { const ch = await client.channels.fetch(config.adminLogChannelId).catch(()=>null); if (ch) await ch.send({content:`New feedback from ${interaction.user.tag} (${interaction.user.id}):\n${message}`}).catch(()=>{}); } return interaction.reply({content:'Your feedback was recorded. This does not create a support ticket.', flags:MessageFlags.Ephemeral}); }
  if (name === 'embed') return embedBuilder.start(interaction);
  const adminOnly = name.startsWith('admin-') || ['delivery','dm','dmall','announce','embed','say','purge','warn','lock','maintenance'].includes(name);
  if (adminOnly && !canAdmin(interaction)) {
    return interaction.reply({content:'You are not authorized to use this command.', flags:MessageFlags.Ephemeral});
  }
  if (name === 'dm-optout') {
    const optedOut = interaction.options.getBoolean('opt_out');
    db.prepare('INSERT INTO dm_preferences(discord_id,opted_out,updated_at) VALUES(?,?,datetime(\'now\')) ON CONFLICT(discord_id) DO UPDATE SET opted_out=excluded.opted_out,updated_at=datetime(\'now\')').run(interaction.user.id, optedOut ? 1 : 0);
    return interaction.reply({content: optedOut ? 'You opted out of server-wide bot DMs.' : 'You opted in to server-wide bot DMs.',flags:MessageFlags.Ephemeral});
  }
  if (name === 'ping') return interaction.reply({content:`🏓 Pong! API latency: ${Math.max(0,Math.round(client.ws.ping))}ms`,flags:MessageFlags.Ephemeral});
  if (name === 'uptime') return interaction.reply({content:`Bot uptime: ${duration(Date.now()-startedAt)}`,flags:MessageFlags.Ephemeral});
  if (name === 'botinfo') {
    const embed = new EmbedBuilder().setColor(0x6d4aff).setTitle(`${config.storeName} — Bot Info`).setThumbnail(client.user.displayAvatarURL()).addFields({name:'Bot',value:client.user.tag,inline:true},{name:'Discord.js',value:require('discord.js').version,inline:true},{name:'Uptime',value:duration(Date.now()-startedAt),inline:true},{name:'Servers',value:String(client.guilds.cache.size),inline:true},{name:'Commands',value:String(commands.length),inline:true},{name:'Database',value:'SQLite',inline:true});
    return interaction.reply({embeds:[embed],flags:MessageFlags.Ephemeral});
  }
  if (name === 'serverinfo') {
    if (!interaction.guild) return interaction.reply({content:'Use this command in a server.',flags:MessageFlags.Ephemeral});
    const g=interaction.guild; const embed=new EmbedBuilder().setColor(0x6d4aff).setTitle(g.name).setThumbnail(g.iconURL()).addFields({name:'Server ID',value:g.id,inline:true},{name:'Members (cached)',value:String(g.memberCount ?? g.members.cache.size),inline:true},{name:'Channels',value:String(g.channels.cache.size),inline:true},{name:'Created',value:`<t:${Math.floor(g.createdTimestamp/1000)}:D>`,inline:true},{name:'Owner ID',value:g.ownerId,inline:true});
    return interaction.reply({embeds:[embed],flags:MessageFlags.Ephemeral});
  }
  if (name === 'userinfo' || name === 'avatar') {
    const user=interaction.options.getUser('user') || interaction.user;
    if (name === 'avatar') return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle(`${user.tag}'s Avatar`).setImage(user.displayAvatarURL({size:1024}))],flags:MessageFlags.Ephemeral});
    const member=interaction.guild ? await interaction.guild.members.fetch(user.id).catch(()=>null) : null;
    const embed=new EmbedBuilder().setColor(0x6d4aff).setTitle(user.tag).setThumbnail(user.displayAvatarURL()).addFields({name:'User ID',value:user.id,inline:true},{name:'Account created',value:`<t:${Math.floor(user.createdTimestamp/1000)}:D>`,inline:true},{name:'Joined server',value:member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp/1000)}:D>` : 'Not available',inline:true},{name:'Bot account',value:user.bot?'Yes':'No',inline:true});
    return interaction.reply({embeds:[embed],flags:MessageFlags.Ephemeral});
  }
  if (name === 'dm') {
    const user=interaction.options.getUser('user'); const message=safeText(interaction.options.getString('message'));
    if (user.bot) return interaction.reply({content:'DM to bot accounts is disabled.',flags:MessageFlags.Ephemeral});
    try { await user.send(message); audit(db,interaction.user.id,'ADMIN_DM',user.id,'Manual DM','SUCCESS'); return interaction.reply({content:`DM sent to ${user.tag}.`,flags:MessageFlags.Ephemeral}); }
    catch { audit(db,interaction.user.id,'ADMIN_DM',user.id,'Manual DM','FAILED'); return interaction.reply({content:'Could not send DM. The user may have DMs disabled.',flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'delivery') {
    const user=interaction.options.getUser('user');
    const product=safeText(interaction.options.getString('product'),1800).trim();
    if (user.bot) return interaction.reply({content:'Product delivery to bot accounts is disabled.',flags:MessageFlags.Ephemeral});
    if (!product) return interaction.reply({content:'Product details cannot be empty.',flags:MessageFlags.Ephemeral});
    const embed=new EmbedBuilder().setColor(0x6d4aff).setTitle(`${config.storeName} — Product Delivery`).setDescription(product).setFooter({text:'Keep your digital product details private.'}).setTimestamp();
    try {
      await user.send({embeds:[embed],allowedMentions:{parse:[]}});
      audit(db,interaction.user.id,'MANUAL_PRODUCT_DELIVERY',user.id,'Product details redacted from audit log','SUCCESS');
      return interaction.reply({content:`Product details sent successfully to ${user.tag} by DM. This manual delivery does not change an order status; use /admin-deliver for a paid order fulfilled from reserved stock.`,flags:MessageFlags.Ephemeral});
    } catch {
      audit(db,interaction.user.id,'MANUAL_PRODUCT_DELIVERY',user.id,'Product details redacted from audit log','FAILED');
      return interaction.reply({content:'Could not deliver the product by DM. The user may have DMs disabled or blocked the bot. No order status was changed.',flags:MessageFlags.Ephemeral});
    }
  }
  if (name === 'dmall') {
    if (!interaction.guild) return interaction.reply({content:'Use this command inside your server.',flags:MessageFlags.Ephemeral});
    const now=Date.now(), rateKey=`dmall:${interaction.guild.id}`;
    const last=Number(db.prepare('SELECT value FROM bot_settings WHERE key=?').get(rateKey)?.value || 0);
    if (now-last < 10*60*1000) return interaction.reply({content:`Server-wide DM is rate-limited. Try again in ${Math.ceil((10*60*1000-(now-last))/60000)} minute(s).`,flags:MessageFlags.Ephemeral});
    db.prepare('INSERT INTO bot_settings(key,value,updated_at) VALUES(?,?,datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime(\'now\')').run(rateKey,String(now));
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const message=safeText(interaction.options.getString('message'),1500); const limit=interaction.options.getInteger('limit')||25;
    try { await interaction.guild.members.fetch({time:15000}); } catch { /* Server Members Intent off or timeout: fall back to cached members */ }
    let members=[...interaction.guild.members.cache.values()].filter(m=>!m.user.bot && m.id!==interaction.user.id).slice(0,limit);
    let sent=0, skipped=0, failed=0;
    for (const member of members) {
      const pref=db.prepare('SELECT opted_out FROM dm_preferences WHERE discord_id=?').get(member.id);
      if (pref?.opted_out) { skipped++; continue; }
      try { await member.send(message); sent++; } catch { failed++; }
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    audit(db,interaction.user.id,'DMALL',interaction.guild.id,`limit=${limit}; sent=${sent}; skipped=${skipped}; failed=${failed}`,'COMPLETED');
    return interaction.editReply(`DM batch complete. Sent: ${sent}; opted out: ${skipped}; failed/DMs closed: ${failed}. Only cached members were considered (maximum ${limit}); one run per server per 10 minutes.`);
  }
  if (name === 'announce' || name === 'say') {
    const channel=interaction.options.getChannel('channel'); const message=safeText(interaction.options.getString('message'));
    try { await channel.send({content:message,allowedMentions:{parse:[]}}); audit(db,interaction.user.id,name.toUpperCase(),channel.id,'Channel message','SUCCESS'); return interaction.reply({content:`Message posted in ${channel}.`,flags:MessageFlags.Ephemeral}); }
    catch { return interaction.reply({content:'Could not post there. Check bot permissions.',flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'purge') {
    if (!interaction.guild || !interaction.channel?.bulkDelete) return interaction.reply({content:'This command requires a server text channel.',flags:MessageFlags.Ephemeral});
    const amount=interaction.options.getInteger('amount');
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    try { const deleted=await interaction.channel.bulkDelete(amount,true); audit(db,interaction.user.id,'PURGE',interaction.channel.id,`requested=${amount}; deleted=${deleted.size}`,'SUCCESS'); return interaction.editReply({content:`Deleted ${deleted.size} recent message(s). Messages older than 14 days are skipped by Discord.`}); }
    catch { return interaction.editReply({content:'Could not delete messages. Check the bot has Manage Messages permission.'}); }
  }
  if (name === 'warn') {
    if (!interaction.guild) return interaction.reply({content:'Use this command inside a server.',flags:MessageFlags.Ephemeral});
    const user=interaction.options.getUser('user'); const reason=safeText(interaction.options.getString('reason'),500);
    if (user.bot || user.id===interaction.user.id) return interaction.reply({content:'Cannot warn a bot or yourself.',flags:MessageFlags.Ephemeral});
    const result=recordWarning(interaction.guild.id,user.id,interaction.user.id,reason); audit(db,interaction.user.id,'WARN',user.id,reason,'SUCCESS');
    await user.send(`You received a warning in **${interaction.guild.name}**. Reason: ${reason}`).catch(()=>{});
    return interaction.reply({content:`Warning #${result.lastInsertRowid} recorded for ${user.tag}.`,flags:MessageFlags.Ephemeral});
  }
  if (name === 'lock') {
    if (!interaction.guild || !interaction.channel?.permissionOverwrites) return interaction.reply({content:'Use this command in a server channel.',flags:MessageFlags.Ephemeral});
    const action=interaction.options.getString('action');
    try { await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {'SendMessages': action==='lock' ? false : null, 'AddReactions': action==='lock' ? false : null}); audit(db,interaction.user.id,'CHANNEL_'+action.toUpperCase(),interaction.channel.id,'Admin command','SUCCESS'); return interaction.reply({content:`Channel ${action==='lock'?'locked':'unlocked'}.`,flags:MessageFlags.Ephemeral}); }
    catch { return interaction.reply({content:'Could not change channel permissions. Check Manage Channels permission.',flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'maintenance') {
    const action=interaction.options.getString('action');
    db.prepare("INSERT INTO bot_settings(key,value,updated_at) VALUES('maintenance',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").run(action);
    audit(db,interaction.user.id,'MAINTENANCE',action,'Admin command','SUCCESS');
    return interaction.reply({content:`Shop maintenance is now ${action==='on'?'ON':'OFF'}. ${action==='on'?'New /buy orders will be blocked.':'New orders are enabled.'}`,flags:MessageFlags.Ephemeral});
  }
  if (name === 'stock') {
    const id=interaction.options.getInteger('product_id');
    if (id) { const p=db.prepare('SELECT id,name FROM products WHERE id=? AND active=1').get(id); if(!p) return interaction.reply({content:'Product not found.',flags:MessageFlags.Ephemeral}); return interaction.reply({content:`**${p.name} (#${p.id})** available stock: **${countStock(id)}**`,flags:MessageFlags.Ephemeral}); }
    const rows=db.prepare("SELECT p.id,p.name,COUNT(s.id) AS stock FROM products p LEFT JOIN product_stock s ON s.product_id=p.id AND s.status='AVAILABLE' WHERE p.active=1 GROUP BY p.id ORDER BY p.id DESC LIMIT 25").all();
    return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle('Available Stock').setDescription(rows.length?rows.map(p=>`**#${p.id} ${p.name}** — ${p.stock}`).join('\n'):'No active products.')],flags:MessageFlags.Ephemeral});
  }
  if (name === 'admin-stock-list') {
    const rows = db.prepare(`SELECT p.id,p.name, SUM(CASE WHEN s.status='AVAILABLE' THEN 1 ELSE 0 END) available, SUM(CASE WHEN s.status='RESERVED' THEN 1 ELSE 0 END) reserved, SUM(CASE WHEN s.status='DELIVERED' THEN 1 ELSE 0 END) delivered FROM products p LEFT JOIN product_stock s ON s.product_id=p.id WHERE p.active=1 GROUP BY p.id ORDER BY p.id DESC LIMIT 25`).all();
    const embed = new EmbedBuilder().setColor(0x6d4aff).setTitle('📦 VORTEXIA • INVENTORY CONTROL').setDescription(rows.length ? rows.map(p=>{ const ids=db.prepare("SELECT id FROM product_stock WHERE product_id=? AND status='AVAILABLE' ORDER BY id LIMIT 10").all(p.id).map(x=>x.id).join(', ') || 'none'; return `**#${p.id} · ${safeText(p.name,80)}**\n🟢 Available: **${p.available||0}**  ·  🟡 Reserved: **${p.reserved||0}**  ·  ⚫ Delivered: **${p.delivered||0}**\nAvailable stock IDs: \`${ids}\``; }).join('\n\n') : 'No active products in inventory.').setFooter({text:'Use /admin-stock-update to add or remove available stock.'}).setTimestamp();
    return interaction.reply({embeds:[embed],flags:MessageFlags.Ephemeral});
  }
  if (name === 'admin-stock-update') {
    const productId=interaction.options.getInteger('product_id'); const action=interaction.options.getString('action'); const value=interaction.options.getString('value'); const stockId=interaction.options.getInteger('stock_id');
    const product=db.prepare('SELECT id,name FROM products WHERE id=? AND active=1').get(productId);
    if(!product) return interaction.reply({content:'Active product not found.',flags:MessageFlags.Ephemeral});
    if(action==='add') {
      if(!value || !value.trim()) return interaction.reply({content:'For Add item, provide the secret delivery value in the value field.',flags:MessageFlags.Ephemeral});
      db.prepare('INSERT INTO product_stock(product_id,secret_value) VALUES(?,?)').run(productId,value.trim());
      audit(db,interaction.user.id,'STOCK_UPDATE_ADD',productId,'One stock item added','SUCCESS');
      return interaction.reply({content:`Added 1 item to **${product.name}** (#${productId}). Current available stock: **${countStock(productId)}**. Secret value was not shown or logged.`,flags:MessageFlags.Ephemeral});
    }
    if(!stockId) return interaction.reply({content:'For Remove available item, provide the stock_id from your inventory records.',flags:MessageFlags.Ephemeral});
    const result=db.prepare("UPDATE product_stock SET status='REMOVED' WHERE id=? AND product_id=? AND status='AVAILABLE'").run(stockId,productId);
    if(!result.changes) return interaction.reply({content:'That stock item was not found as AVAILABLE for this product. No change made.',flags:MessageFlags.Ephemeral});
    audit(db,interaction.user.id,'STOCK_UPDATE_REMOVE',stockId,`Product ${productId}`,'SUCCESS');
    return interaction.reply({content:`Removed stock item #${stockId} from **${product.name}**. Current available stock: **${countStock(productId)}**.`,flags:MessageFlags.Ephemeral});
  }
  if (name === 'payment-status' || name === 'order-info') {
    const id=interaction.options.getString('order_id').trim();
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if(!order || (order.discord_id!==interaction.user.id && !canAdmin(interaction))) return interaction.reply({content:'Order not found for your account.',flags:MessageFlags.Ephemeral});
    const payment=db.prepare('SELECT id,method,status,created_at,verified_at FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1').get(id);
    if(name==='payment-status') return interaction.reply({content:`Order \`${id}\` status: **${order.status}**\nPayment: **${payment?.status||'NOT SUBMITTED'}**${payment?` (${payment.method}, #${payment.id})`:''}`,flags:MessageFlags.Ephemeral});
    const items=db.prepare('SELECT product_name,quantity,unit_price FROM order_items WHERE order_id=?').all(id);
    const embed=new EmbedBuilder().setColor(0x6d4aff).setTitle(`Order ${id}`).addFields({name:'Status',value:order.status,inline:true},{name:'Total',value:money(order.total_price),inline:true},{name:'Created',value:order.created_at,inline:true},{name:'Items',value:items.map(i=>`${i.product_name} × ${i.quantity} — ${money(i.unit_price)} each`).join('\n').slice(0,1000)||'No items'});
    if(payment) embed.addFields({name:'Latest payment',value:`#${payment.id} • ${payment.method} • ${payment.status}`});
    return interaction.reply({embeds:[embed],flags:MessageFlags.Ephemeral});
  }
  if (name === 'admin-coupon-create') {
    const code=interaction.options.getString('code').trim().toUpperCase(); const kind=interaction.options.getString('kind'); const amount=interaction.options.getInteger('amount'); const maxUses=interaction.options.getInteger('max_uses');
    if(!/^[A-Z0-9_-]{3,64}$/.test(code)) return interaction.reply({content:'Coupon code must be 3-64 characters using only letters, numbers, underscores, or hyphens.',flags:MessageFlags.Ephemeral});
    if(kind==='PERCENT' && amount>100) return interaction.reply({content:'Percentage coupons must be between 1 and 100.',flags:MessageFlags.Ephemeral});
    try { db.prepare('INSERT INTO coupons(code,kind,amount,max_uses) VALUES(?,?,?,?)').run(code,kind,amount,maxUses??null); audit(db,interaction.user.id,'COUPON_CREATE',code,`${kind} ${amount}; max uses ${maxUses??'unlimited'}`,'SUCCESS'); return interaction.reply({content:`Coupon **${code}** created (${kind==='PERCENT'?`${amount}%`:money(amount)} discount; max uses: ${maxUses??'unlimited'}).`,flags:MessageFlags.Ephemeral}); }
    catch { return interaction.reply({content:'Could not create coupon. The code may already exist.',flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'redeem') {
    const code=interaction.options.getString('code').trim(); const orderId=interaction.options.getString('order_id').trim();
    if(!/^[A-Za-z0-9_-]{3,64}$/.test(code)) return interaction.reply({content:'Invalid coupon code format.',flags:MessageFlags.Ephemeral});
    try {
      const tx=db.transaction(()=>{
        const order=db.prepare('SELECT * FROM orders WHERE id=? AND discord_id=?').get(orderId,interaction.user.id);
        if(!order) throw new Error('Order not found for your account.');
        if(order.status!=='PENDING_PAYMENT') throw new Error('Coupon can only be applied before payment is submitted. Create a new pending order if needed.');
        const coupon=db.prepare('SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND active=1').get(code);
        if(!coupon) throw new Error('Coupon is invalid or inactive.');
        if(coupon.expires_at && Date.parse(coupon.expires_at+'Z') < Date.now()) throw new Error('Coupon has expired.');
        if(coupon.max_uses!==null && coupon.uses>=coupon.max_uses) throw new Error('Coupon usage limit has been reached.');
        if(db.prepare('SELECT 1 FROM coupon_redemptions WHERE code=? AND discord_id=? AND order_id=?').get(coupon.code,interaction.user.id,orderId)) throw new Error('This coupon was already applied to this order.');
        const discount=coupon.kind==='PERCENT'?Math.floor(order.total_price*Math.min(coupon.amount,100)/100):Math.min(order.total_price,coupon.amount);
        if(discount<=0) throw new Error('This coupon does not reduce the order total.');
        db.prepare('UPDATE orders SET total_price=?,updated_at=datetime(\'now\') WHERE id=?').run(order.total_price-discount,orderId);
        db.prepare('INSERT INTO coupon_redemptions(code,discord_id,order_id) VALUES(?,?,?)').run(coupon.code,interaction.user.id,orderId);
        db.prepare('UPDATE coupons SET uses=uses+1 WHERE code=?').run(coupon.code);
        audit(db,interaction.user.id,'COUPON_REDEEM',orderId,`code=${coupon.code}; discount=${discount}`,'SUCCESS');
        return {discount,total:order.total_price-discount};
      });
      const result=tx(); return interaction.reply({content:`Coupon applied to order \`${orderId}\`. Discount: **${money(result.discount)}**. New order total: **${money(result.total)}**. If you already submitted payment, do not pay the old amount; contact an admin to review the payment.`,flags:MessageFlags.Ephemeral});
    } catch(e) { return interaction.reply({content:e.message,flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'reseller-transactions') {
    const reseller=db.prepare('SELECT status FROM resellers WHERE discord_id=?').get(interaction.user.id);
    if(!reseller || reseller.status!=='APPROVED') return interaction.reply({content:'This command is available to approved resellers only.',flags:MessageFlags.Ephemeral});
    const wallet=db.prepare('SELECT balance FROM wallets WHERE discord_id=?').get(interaction.user.id);
    const rows=db.prepare('SELECT amount,kind,reference,created_at FROM wallet_transactions WHERE discord_id=? ORDER BY id DESC LIMIT 15').all(interaction.user.id);
    const pending=db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM reseller_withdrawals WHERE discord_id=? AND status='PENDING'").get(interaction.user.id).amount;
    const embed=new EmbedBuilder().setColor(0x6d4aff).setTitle('Reseller Transaction History').setDescription(rows.length?rows.map(t=>`**${t.amount>=0?'+':''}${money(t.amount)}** · ${safeText(t.kind,60)} · \`${safeText(t.reference,60)}\` · <t:${Math.floor(Date.parse(t.created_at+'Z')/1000)}:R>`).join('\n'):'No wallet transactions recorded yet.').addFields({name:'Wallet balance',value:money(wallet?.balance||0),inline:true},{name:'Pending withdrawal requests',value:money(pending),inline:true});
    return interaction.reply({embeds:[embed],flags:MessageFlags.Ephemeral});
  }
  if (name === 'reseller-withdraw') {
    const reseller=db.prepare('SELECT status FROM resellers WHERE discord_id=?').get(interaction.user.id);
    if(!reseller || reseller.status!=='APPROVED') return interaction.reply({content:'Only approved resellers can request withdrawals.',flags:MessageFlags.Ephemeral});
    const amount=interaction.options.getInteger('amount'); const method=interaction.options.getString('method');
    const payout=safeText(interaction.options.getString('payout_details').trim(),180);
    if(payout.length<5 || /@everyone|@here/.test(payout)) return interaction.reply({content:'Please enter valid payout details.',flags:MessageFlags.Ephemeral});
    try {
      const tx=db.transaction(()=>{
        const wallet=db.prepare('SELECT balance FROM wallets WHERE discord_id=?').get(interaction.user.id);
        if(!wallet || wallet.balance<amount) throw new Error('Insufficient wallet balance.');
        const pending=db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM reseller_withdrawals WHERE discord_id=? AND status='PENDING'").get(interaction.user.id).amount;
        if(wallet.balance-pending<amount) throw new Error(`Only ${money(Math.max(0,wallet.balance-pending))} is available after pending requests.`);
        const result=db.prepare('INSERT INTO reseller_withdrawals(discord_id,amount,method,payout_details) VALUES(?,?,?,?)').run(interaction.user.id,amount,method,payout);
        audit(db,interaction.user.id,'RESELLER_WITHDRAW_REQUEST',String(result.lastInsertRowid),`${amount} ${method}`,'PENDING');
        return result.lastInsertRowid;
      });
      const requestId=tx();
      return interaction.reply({content:`Withdrawal request **#${requestId}** submitted for **${money(amount)}** via **${method}**. Status: PENDING. Your payout details are stored privately for staff review. This is a request, not a completed payment.`,flags:MessageFlags.Ephemeral});
    } catch(e) { return interaction.reply({content:e.message||'Could not submit withdrawal request.',flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'leaderboard') {
    const rows=db.prepare(`SELECT r.discord_id, COALESCE(SUM(CASE WHEN wt.amount>0 THEN wt.amount ELSE 0 END),0) AS volume, COUNT(wt.id) AS tx_count FROM resellers r LEFT JOIN wallet_transactions wt ON wt.discord_id=r.discord_id WHERE r.status='APPROVED' GROUP BY r.discord_id ORDER BY volume DESC, tx_count DESC LIMIT 10`).all();
    if(!rows.length) return interaction.reply({content:'No approved resellers are listed yet.',flags:MessageFlags.Ephemeral});
    const lines=rows.map((r,i)=>`**${i+1}.** <@${r.discord_id}> — **${money(r.volume)}** recorded positive transactions (${r.tx_count} tx)`).join('\n');
    return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle('🏆 Top Resellers').setDescription(lines).setFooter({text:'Ranked by recorded positive wallet transaction volume; this is not independently verified sales revenue.'})]});
  }
  if (name === 'admin-withdrawals') {
    const rows=db.prepare("SELECT id,discord_id,amount,method,payout_details,status,created_at FROM reseller_withdrawals WHERE status='PENDING' ORDER BY id ASC LIMIT 20").all();
    const embed=new EmbedBuilder().setColor(0x6d4aff).setTitle('Pending Reseller Withdrawals').setDescription(rows.length?rows.map(r=>`**#${r.id}** · <@${r.discord_id}> · ${money(r.amount)} · ${r.method} · payout: ||${safeText(r.payout_details,100)}|| · <t:${Math.floor(Date.parse(r.created_at+'Z')/1000)}:R>`).join('\n'):'No pending withdrawal requests.').setFooter({text:'Use /admin-withdrawal-review to approve or reject a request.'});
    return interaction.reply({embeds:[embed],flags:MessageFlags.Ephemeral});
  }
  if (name === 'admin-withdrawal-review') {
    const id=interaction.options.getInteger('request_id'); const decision=interaction.options.getString('decision'); const note=safeText(interaction.options.getString('note')||'',300);
    try {
      const request=reviewWithdrawal(id,decision,note,interaction.user.id);
      await client.users.send(request.discord_id,`Your Vortexia Store withdrawal request #${id} for ${money(request.amount)} was marked ${decision.toLowerCase().replace('_',' ')}.${note?` Staff note: ${note}`:''} ${decision==='APPROVED'?'Wallet balance deducted. Please send the payout manually, then mark the request paid.':decision==='PAID'?'Thank you. This status means staff marked the payout as sent.':'You may submit a new request if eligible.'}`).catch(()=>{});
      return interaction.reply({content:`Withdrawal request #${id} marked ${decision}. ${decision==='APPROVED'?'Wallet balance deducted. Send the payout manually, then use mark paid.':''}`,flags:MessageFlags.Ephemeral});
    } catch(e) { return interaction.reply({content:e.message||'Could not review withdrawal request.',flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'admin-reseller-set') {
    const user=interaction.options.getUser('user'); const status=interaction.options.getString('status');
    if (user.bot) return interaction.reply({content:'Bot accounts cannot be resellers.',flags:MessageFlags.Ephemeral});
    setReseller(user.id,status,interaction.user.id);
    return interaction.reply({content:`${user.tag} is now **${status}** as a reseller. A wallet was created if needed. Add balance with /admin-wallet-credit.`,flags:MessageFlags.Ephemeral});
  }
  if (name === 'admin-wallet-credit') {
    const user=interaction.options.getUser('user'); const amount=interaction.options.getInteger('amount'); const note=safeText(interaction.options.getString('note')||'',100);
    try { const balance=creditWallet(user.id,amount,interaction.user.id,note); return interaction.reply({content:`Credited ${money(amount)} to ${user.tag}. New balance: **${money(balance)}**.`,flags:MessageFlags.Ephemeral}); }
    catch(e) { return interaction.reply({content:/not an approved reseller/.test(e.message)?'That user is not an approved reseller. Use /admin-reseller-set first.':e.message,flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'cancel-order') {
    const id=interaction.options.getString('order_id').trim();
    try { const r=cancelOrder(id,interaction.user.id,{reason:'Cancelled by customer',ownerId:interaction.user.id}); return interaction.reply({content:`Order \`${id}\` cancelled. ${r.freed} reserved item(s) were released.`,flags:MessageFlags.Ephemeral}); }
    catch(e) { return interaction.reply({content:/PENDING_VERIFICATION/.test(e.message)?'Your payment is already under review. Ask an admin to cancel this order.':e.message,flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'admin-reject') {
    try {
      const reason=safeText(interaction.options.getString('reason'),300);
      const order=rejectPayment(interaction.options.getInteger('payment_id'),interaction.user.id,reason);
      const user=order ? await client.users.fetch(order.discord_id).catch(()=>null) : null;
      if (user) await user.send({content:`Your payment for order ${order.id} could not be verified. Reason: ${reason}\nYou can submit the correct transaction again with /payment-submit.`,allowedMentions:{parse:[]}}).catch(()=>null);
      return interaction.reply({content:`Payment rejected. Order ${order?.id} is back to PENDING_PAYMENT so the customer can resubmit (or cancel it to release the stock).`,flags:MessageFlags.Ephemeral});
    } catch(e) { return interaction.reply({content:e.message,flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'help') {
    const embed=new EmbedBuilder().setColor(0x6d4aff).setTitle(`${config.storeName} — Commands`).setDescription(`Available commands (${commands.filter(c=>!aliasTarget[c.name]).length}):\n${commands.filter(c=>!aliasTarget[c.name]).map(c => `\`/${c.name}\``).join(', ')}`);
    return interaction.reply({embeds:[embed],flags:MessageFlags.Ephemeral});
  }
  if (name === 'shop' || name === 'categories' || name === 'search') {
    if (isMaintained() && !canAdmin(interaction)) return interaction.reply({content:'The shop is currently under maintenance. Please try again later.',flags:MessageFlags.Ephemeral});
    let rows;
    if (name === 'categories') {
      rows = db.prepare('SELECT id,name FROM categories ORDER BY name').all();
      return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle('Product Categories').setDescription(rows.length ? rows.map(x=>`**${x.id}.** ${x.name}`).join('\n') : 'No categories yet.')], flags:MessageFlags.Ephemeral});
    }
    if (name === 'search') {
      const q = `%${interaction.options.getString('query').slice(0,80)}%`;
      rows = db.prepare('SELECT * FROM products WHERE active=1 AND (name LIKE ? OR description LIKE ?) ORDER BY id DESC LIMIT 20').all(q,q);
    } else rows = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id DESC LIMIT 20').all();
    return interaction.reply({embeds:[shopEmbed(rows, {title: name==='search' ? '🔎 SEARCH RESULTS' : '🛍️ VORTEXIA STORE — OFFICIAL SHOP', client:interaction.client})], components:[shopButtons()], flags:MessageFlags.Ephemeral});
  }
  if (name === 'product') {
    const id = interaction.options.getInteger('id');
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
    if (!p) return interaction.reply({content:'Product not found.',flags:MessageFlags.Ephemeral});
    const n = db.prepare("SELECT COUNT(*) n FROM product_stock WHERE product_id=? AND status='AVAILABLE'").get(id).n;
    return interaction.reply({embeds:[productEmbed(p,n)],flags:MessageFlags.Ephemeral});
  }
  if (name === 'buy') {
    if (isMaintained() && !canAdmin(interaction)) return interaction.reply({content:'The shop is currently under maintenance. New orders are disabled.',flags:MessageFlags.Ephemeral});
    try {
      const result = createOrder(interaction.user.id, interaction.options.getInteger('product_id'), interaction.options.getInteger('quantity') || 1);
      return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle('Order Created').setDescription(`Order: \`${result.orderId}\`\nProduct: **${result.product.name}** × ${result.quantity}\nTotal: **${money(result.total)}**\nStatus: \`PENDING_PAYMENT\`\n\nUse \`/payment-methods\` then submit your transaction with \`/payment-submit\`.`)],flags:MessageFlags.Ephemeral});
    } catch (e) { return interaction.reply({content:e.message,flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'my-orders') {
    const rows = db.prepare('SELECT id,status,total_price,created_at FROM orders WHERE discord_id=? ORDER BY created_at DESC LIMIT 10').all(interaction.user.id);
    return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle('Your Orders').setDescription(rows.length ? rows.map(o=>`\`${o.id}\` — ${o.status} — ${money(o.total_price)}`).join('\n') : 'No orders found.')],flags:MessageFlags.Ephemeral});
  }
  if (name === 'track-order') {
    const id = interaction.options.getString('order_id').trim();
    const o = db.prepare('SELECT * FROM orders WHERE id=? AND discord_id=?').get(id,interaction.user.id);
    return interaction.reply({content:o ? `Order \`${o.id}\`: **${o.status}** | Total: ${money(o.total_price)}` : 'Order not found for your account.',flags:MessageFlags.Ephemeral});
  }
  if (name === 'payment-methods') {
    const lines = Object.entries(config.paymentMethods).map(([method,number])=>`${number ? `**${method}:** ${number}` : `**${method}:** Not configured`}`).join('\n');
    return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle('Payment Methods').setDescription(`${lines}\n\nOnly submit a transaction after completing payment. Payment submissions require independent verification.`)],flags:MessageFlags.Ephemeral});
  }
  if (name === 'payment-submit') {
    try {
      const id = submitPayment(interaction.user.id, interaction.options.getString('order_id').trim(), interaction.options.getString('method'), interaction.options.getString('transaction_id'));
      if (config.adminLogChannelId) {
        const ch = await client.channels.fetch(config.adminLogChannelId).catch(()=>null);
        if (ch) await ch.send({content:`Payment #${id} submitted for verification. Order: ${safeText(interaction.options.getString('order_id'),80)}. Submitted by: <@${interaction.user.id}>. Do not approve without independent verification.`,allowedMentions:{parse:[]}}).catch(()=>{});
      }
      return interaction.reply({content:`Payment submitted for manual verification. Payment ID: ${id}. Your order will not be delivered until an authorized administrator verifies payment.`,flags:MessageFlags.Ephemeral});
    } catch (e) { return interaction.reply({content:e.message,flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'admin-product-add') {
    const productName = interaction.options.getString('name').trim().slice(0,100);
    const price = interaction.options.getInteger('price');
    const description = (interaction.options.getString('description')||'').slice(0,1000);
    const category = (interaction.options.getString('category')||'').trim().slice(0,60);
    const resellerPrice = interaction.options.getInteger('reseller_price') ?? null;
    if (!productName) return interaction.reply({content:'Product name cannot be empty.',flags:MessageFlags.Ephemeral});
    const tx = db.transaction(() => {
      let categoryId = null;
      if (category) {
        db.prepare('INSERT INTO categories(name) VALUES(?) ON CONFLICT(name) DO NOTHING').run(category);
        categoryId = db.prepare('SELECT id FROM categories WHERE name=?').get(category).id;
      }
      const r = db.prepare('INSERT INTO products(name,description,category_id,retail_price,reseller_price) VALUES(?,?,?,?,?)').run(productName,description,categoryId,price,resellerPrice);
      audit(db, interaction.user.id, 'PRODUCT_ADD', r.lastInsertRowid, 'Admin command', 'SUCCESS');
      return r.lastInsertRowid;
    });
    const id = tx();
    return interaction.reply({content:`Product created. ID: ${id}${resellerPrice!==null?` (reseller price ${money(resellerPrice)})`:''}. Add inventory with \`/admin-stock-add\`.`,flags:MessageFlags.Ephemeral});
  }
  if (name === 'admin-stock-add') {
    const productId = interaction.options.getInteger('product_id');
    const value = interaction.options.getString('value');
    if (value.length > 2000 || !value.trim()) return interaction.reply({content:'Stock value is empty or too long.',flags:MessageFlags.Ephemeral});
    const p = db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(productId);
    if (!p) return interaction.reply({content:'Active product not found.',flags:MessageFlags.Ephemeral});
    db.prepare('INSERT INTO product_stock(product_id,secret_value) VALUES(?,?)').run(productId,value);
    audit(db, interaction.user.id, 'STOCK_ADD', productId, 'Single stock item added', 'SUCCESS');
    return interaction.reply({content:'Stock item added. Its value was not displayed or logged.',flags:MessageFlags.Ephemeral});
  }
  if (name === 'admin-orders') {
    const rows = db.prepare("SELECT p.id,p.order_id,p.method,p.transaction_id,o.total_price FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.status='PENDING_VERIFICATION' ORDER BY p.id LIMIT 20").all();
    return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle('Pending Payment Verification').setDescription(rows.length ? rows.map(p=>`Payment #${p.id} | Order \`${p.order_id}\` | ${p.method} | ${money(p.total_price)} | TX: \`${p.transaction_id}\``).join('\n') : 'No pending payments.')],flags:MessageFlags.Ephemeral});
  }
  if (name === 'admin-approve') {
    try {
      const paymentId = interaction.options.getInteger('payment_id');
      const reason = interaction.options.getString('reason').slice(0,500);
      const order = approvePayment(paymentId,interaction.user.id,reason);
      const user = await client.users.fetch(order.discord_id).catch(()=>null);
      if (user) await user.send(`Payment verified for order ${order.id}. Your order is paid and awaiting delivery.`).catch(()=>null);
      return interaction.reply({content:`Payment approved for order ${order.id}. It is PAID, not yet delivered. Use /admin-deliver after checking inventory.`,flags:MessageFlags.Ephemeral});
    } catch(e) { return interaction.reply({content:e.message,flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'admin-deliver') {
    try { await deliverOrder(client,interaction.options.getString('order_id').trim(),interaction.user.id); return interaction.reply({content:'Delivery completed and recorded.',flags:MessageFlags.Ephemeral}); }
    catch(e) { return interaction.reply({content:`Delivery not completed: ${e.message}`,flags:MessageFlags.Ephemeral}); }
  }
  if (name === 'admin-stats') {
    const orders = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
    const delivered = db.prepare("SELECT COUNT(*) n FROM orders WHERE status='DELIVERED'").get().n;
    const revenue = db.prepare("SELECT COALESCE(SUM(total_price),0) n FROM orders WHERE status='DELIVERED'").get().n;
    const pending = db.prepare("SELECT COUNT(*) n FROM payments WHERE status='PENDING_VERIFICATION'").get().n;
    return interaction.reply({embeds:[new EmbedBuilder().setColor(0x6d4aff).setTitle('Store Statistics').addFields({name:'Orders',value:String(orders),inline:true},{name:'Delivered',value:String(delivered),inline:true},{name:'Delivered revenue',value:money(revenue),inline:true},{name:'Pending payments',value:String(pending),inline:true})],flags:MessageFlags.Ephemeral});
  }
  if (name === 'admin-backup') {
    const fs = require('node:fs');
    const path = require('node:path');
    const backupDir = path.resolve('./backups');
    fs.mkdirSync(backupDir,{recursive:true});
    const target = path.join(backupDir,`vortexia-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    try { await db.backup(target); audit(db,interaction.user.id,'DB_BACKUP',path.basename(target),'Admin command','SUCCESS'); return interaction.editReply(`Backup created: ${path.basename(target)}. It is stored on the host, not attached here.`); }
    catch { return interaction.editReply('Backup failed. Check host logs.'); }
  }
  return interaction.reply({content:'This command is not implemented.',flags:MessageFlags.Ephemeral});
}
module.exports = {
  commands,
  handle,
  handleComponent: embedBuilder.handle,
  handleShopComponent
};
