const config = require('./config');
function isAdmin(interaction) {
  if (config.adminUserIds.includes(interaction.user.id)) return true;
  const memberRoles = interaction.member?.roles?.cache;
  return Boolean(memberRoles && config.adminRoleIds.some(id => memberRoles.has(id)));
}
function audit(db, actor, action, target, reason, result) {
  db.prepare('INSERT INTO audit_logs(actor_id, action, target, reason, result) VALUES(?,?,?,?,?)')
    .run(String(actor), action, String(target), String(reason || ''), String(result));
}
module.exports = { isAdmin, audit };
