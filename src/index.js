const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const config = require('./config');
const db = require('./db');
const { handle, handleComponent, handleShopComponent } = require('./commands');
const { expireStaleOrders } = require('./services');
const { startDashboard } = require('./dashboard/server');

function createClient(withMembers) {
  // GuildMembers is a privileged intent: enable "Server Members Intent" in the Discord Developer Portal for /dmall.
  const intents = [GatewayIntentBits.Guilds];
  if (withMembers) intents.push(GatewayIntentBits.GuildMembers);
  const client = new Client({ intents });

  client.once(Events.ClientReady, ready => {
    console.log(`[ready] Logged in as ${ready.user.tag}; database ready.${withMembers ? '' : ' (running WITHOUT Server Members Intent: /dmall will only reach cached members)'}`);
  });
  client.on(Events.Error, err => console.error('[client-error]', err?.message || err));
  client.on(Events.Warn, msg => console.warn('[client-warn]', msg));

  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith('vortex_shop:')) { await handleShopComponent(interaction); return; }
      if ((interaction.isButton() && interaction.customId.startsWith('eb:')) || (interaction.isModalSubmit() && interaction.customId.startsWith('ebm:'))) {
        await handleComponent(interaction);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      await handle(interaction, client);
    } catch (err) {
      console.error(`[command-error] ${interaction.commandName || interaction.customId || 'unknown'}: ${err?.stack || err?.message || err}`);
      const payload = { content: 'An unexpected error occurred. Please try again or contact support.', flags:MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch { /* interaction expired or already answered */ }
    }
  });
  return client;
}

let client = createClient(true);

let dashboard = null;
let expiryTimer = null;
async function afterLogin() {
  if (!dashboard) dashboard = await startDashboard(() => client);
  if (!expiryTimer && config.orderExpiryMinutes > 0) {
    const sweep = async () => {
      try {
        for (const o of expireStaleOrders(config.orderExpiryMinutes)) {
          client.users.fetch(o.discord_id).then(u => u.send(`Your order ${o.id} was cancelled because no payment was submitted within ${config.orderExpiryMinutes} minutes. Create a new order any time with /buy.`)).catch(() => {});
        }
      } catch (err) { console.error('[order-expiry]', err?.message || err); }
    };
    expiryTimer = setInterval(sweep, 5 * 60 * 1000); expiryTimer.unref(); sweep();
  }
}

function shutdown() {
  try { dashboard?.server?.close(); } catch { /* not listening */ }
  try { db.close(); } catch { /* already closed */ }
  try { client.destroy(); } catch { /* not connected */ }
  process.exit(0);
}
process.on('unhandledRejection', err => console.error('[unhandled-rejection]', err?.stack || err?.message || 'unknown'));
process.on('uncaughtException', err => console.error('[uncaught-exception]', err?.stack || err?.message || 'unknown'));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function start() {
  try {
    await client.login(config.token);
    await afterLogin();
    return;
  } catch (err) {
    const msg = String(err?.message || err);
    if (/disallowed intents/i.test(msg) || err?.code === 'DisallowedIntents') {
      console.warn('[startup] Server Members Intent is NOT enabled in the Developer Portal (Bot > Privileged Gateway Intents).');
      console.warn('[startup] Starting without it so every other command keeps working. Enable it to let /dmall reach all members.');
      try { client.destroy(); } catch { /* ignore */ }
      client = createClient(false);
      try { await client.login(config.token); await afterLogin(); return; }
      catch (err2) { console.error('[startup] Login failed:', err2?.message || err2); process.exit(1); }
    }
    if (/invalid token|an invalid token/i.test(msg) || err?.code === 'TokenInvalid') {
      console.error('[startup] DISCORD_TOKEN is invalid. Copy a fresh token from Developer Portal > Bot > Reset Token and put it in .env.');
    } else {
      console.error('[startup] Login failed:', msg);
    }
    process.exit(1);
  }
}
start();
