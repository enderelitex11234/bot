const path = require('node:path');
require('dotenv').config();

function csv(value) {
  return (value || '').split(',').map(x => x.trim()).filter(Boolean);
}
function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith('put_your_') || value.startsWith('put_test_')) {
    throw new Error(`Missing or placeholder environment variable: ${name}`);
  }
  return value;
}
const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: process.env.GUILD_ID || '',
  adminUserIds: csv(process.env.ADMIN_USER_IDS),
  adminRoleIds: csv(process.env.ADMIN_ROLE_IDS),
  resellerRoleId: process.env.RESELLER_ROLE_ID || '',
  adminLogChannelId: process.env.ADMIN_LOG_CHANNEL_ID || '',
  storeName: process.env.STORE_NAME || 'VORTEXIA STORE',
  dbPath: path.resolve(process.env.DB_PATH || './data/vortexia.sqlite'),
  lowStockThreshold: Math.max(0, Number.parseInt(process.env.LOW_STOCK_THRESHOLD || '3', 10)),
  orderExpiryMinutes: Math.max(0, Number.parseInt(process.env.ORDER_EXPIRY_MINUTES || '120', 10) || 0),
  dashboard: {
    enabled: !['false', '0', 'off', 'no'].includes(String(process.env.DASHBOARD_ENABLED || 'true').toLowerCase()),
    host: process.env.DASHBOARD_HOST || '127.0.0.1',
    port: Number.isInteger(Number.parseInt(process.env.DASHBOARD_PORT, 10)) ? Number.parseInt(process.env.DASHBOARD_PORT, 10) : 3000,
    password: process.env.DASHBOARD_PASSWORD || ''
  },
  paymentMethods: {
    bKash: process.env.PAYMENT_BKASH_NUMBER || '',
    Nagad: process.env.PAYMENT_NAGAD_NUMBER || '',
    Rocket: process.env.PAYMENT_ROCKET_NUMBER || ''
  }
};
module.exports = config;
