const { REST, Routes } = require('discord.js');
const config = require('../src/config');
const { commands } = require('../src/commands');
const rest = new REST({ version: '10' }).setToken(config.token);
if (commands.length > 100) throw new Error(`Discord supports at most 100 top-level slash commands; found ${commands.length}.`);
if (new Set(commands.map(c => c.name)).size !== commands.length) throw new Error('Duplicate slash command names detected before registration.');
(async () => {
  try {
    const route = config.guildId
      ? Routes.applicationGuildCommands(config.clientId, config.guildId)
      : Routes.applicationCommands(config.clientId);
    await rest.put(route, { body: commands });
    console.log(`Registered ${commands.length} slash commands${config.guildId ? ` in server ${config.guildId}` : ' globally'}.`);
    // Old global commands show up next to the server ones (every command appears twice). --clean removes the other scope.
    if (process.argv.includes('--clean')) {
      const other = config.guildId ? Routes.applicationCommands(config.clientId) : null;
      if (other) { await rest.put(other, { body: [] }); console.log('Removed old GLOBAL commands (fixes duplicate commands).'); }
      else console.log('--clean only applies when GUILD_ID is set; nothing removed.');
    }
  } catch (error) {
    console.error('Command registration failed:', error.message);
    process.exitCode = 1;
  }
})();
