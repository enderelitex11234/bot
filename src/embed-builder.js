const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, MessageFlags
} = require('discord.js');
const { db } = require('./services');
const config = require('./config');
const { isAdmin, audit } = require('./security');

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_COLOR = '#FF6A00';
const MAX_FIELDS = 3;
const MAX_LINKS = 2;
const safe = (s, max=1800) => String(s || '').replace(/@everyone/g, '@ everyone').replace(/@here/g, '@ here').slice(0,max);
function blank(channelId, guildId) {
  return { touched: Date.now(), channelId, guildId, title: '', description: '', color: DEFAULT_COLOR, image: '', thumbnail: '', footer: config.storeName, author: '', authorIcon: '', titleUrl: '', timestamp: true, fields: [], links: [], productName: '', productPhoto: '', resellerPrice: '', retailPrice: '', stockStatus: 'IN STOCK', showProfit: true };
}
function getEmbed(s) {
  const e = new EmbedBuilder().setColor(parseInt(s.color.slice(1),16));
  if (s.title) e.setTitle(safe(s.title,256));
  if (s.description) e.setDescription(safe(s.description,3500));
  if (s.titleUrl) e.setURL(s.titleUrl);
  if (s.footer) e.setFooter({text:safe(s.footer,2048)});
  if (s.author) e.setAuthor({name:safe(s.author,256), ...(s.authorIcon ? {iconURL:s.authorIcon} : {})});
  if (s.thumbnail) e.setThumbnail(s.thumbnail);
  if (s.image) e.setImage(s.image);
  if (s.timestamp) e.setTimestamp();
  if (s.fields.length) e.addFields(s.fields.map(f=>({name:safe(f.name,256),value:safe(f.value,1024),inline:Boolean(f.inline)})));
  if (s.productName) {
    const fields = [];
    if (s.resellerPrice !== '') fields.push({name:'Reseller Price',value:`৳${s.resellerPrice}`,inline:true});
    if (s.retailPrice !== '') fields.push({name:'Retail Price',value:`৳${s.retailPrice}`,inline:true});
    if (s.showProfit && s.resellerPrice !== '' && s.retailPrice !== '') { const profit=Number(s.retailPrice)-Number(s.resellerPrice); fields.push({name:'Price Difference',value:`৳${profit.toLocaleString('en-US')}`,inline:true}); }
    fields.push({name:'Stock Status',value:s.stockStatus,inline:true});
    e.addFields({name:'Product',value:safe(s.productName,256),inline:false},...fields);
    if (s.productPhoto) e.setImage(s.productPhoto);
  }
  return e;
}
function button(label, id, style=ButtonStyle.Secondary, emoji) {
  const b = new ButtonBuilder().setCustomId(`eb:${id}`).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}
function panel(s) {
  const e = getEmbed(s);
  e.setAuthor({name:'✦ Vortexia | Embed Preview'});
  if (!s.title && !s.description) e.setDescription('Your live preview will appear here. Use the buttons below to build your embed.');
  const rows = [
    new ActionRowBuilder().addComponents(button('Title','title',ButtonStyle.Primary,'✏️'),button('Description','description',ButtonStyle.Primary,'ℹ️'),button('Color','color',ButtonStyle.Primary,'🎨'),button('Author','author',ButtonStyle.Secondary,'👤')),
    new ActionRowBuilder().addComponents(button('Image','image',ButtonStyle.Secondary,'🖼️'),button('Thumbnail','thumbnail',ButtonStyle.Secondary,'🔳'),button('Product & Prices','product',ButtonStyle.Primary,'🛍️'),button('Close','close',ButtonStyle.Danger,'✖️')),
    new ActionRowBuilder().addComponents(button(`Add Field (${s.fields.length}/${MAX_FIELDS})`,'field',ButtonStyle.Secondary,'➕'),button('Title URL','titleurl',ButtonStyle.Secondary,'🔗'),button(`Buttons (${s.links.length}/${MAX_LINKS})`,'links',ButtonStyle.Primary,'🔘'),button('Footer','footer',ButtonStyle.Secondary,'🖌️')),
    new ActionRowBuilder().addComponents(button(s.timestamp?'Timestamp ON':'Timestamp OFF','timestamp',ButtonStyle.Success,'🕒'),button(s.showProfit?'Profit ON':'Profit OFF','profit',ButtonStyle.Secondary,'💰'),button('Clear Fields','clearfields',ButtonStyle.Danger,'🗑️'),button('Publish','publish',ButtonStyle.Success,'✅'),button('Reset','reset',ButtonStyle.Secondary,'🔄'))
  ];
  return {embeds:[e],components:rows};
}
function input(customId,label,required=false,style=TextInputStyle.Short,value='',placeholder='') {
  const t = new TextInputBuilder().setCustomId(customId).setLabel(label).setStyle(style).setRequired(required);
  if (value) t.setValue(String(value).slice(0, style===TextInputStyle.Paragraph?4000:1000));
  if (placeholder) t.setPlaceholder(placeholder.slice(0,100));
  return t;
}
function modal(id,title,inputs) {
  const m = new ModalBuilder().setCustomId(`ebm:${id}`).setTitle(title);
  for (const item of inputs) m.addComponents(new ActionRowBuilder().addComponents(item));
  return m;
}
function validUrl(v) {
  if (!v) return '';
  const u = new URL(v);
  if (u.protocol !== 'https:' || !u.hostname.includes('.')) throw new Error('Use a valid HTTPS URL.');
  return u.toString();
}
function owned(interaction) {
  const s = sessions.get(interaction.user.id);
  if (!s || s.guildId !== interaction.guildId) return null;
  if (Date.now() - (s.touched || 0) > SESSION_TTL_MS) { sessions.delete(interaction.user.id); return null; }
  s.touched = Date.now();
  return s;
}
// Modal submits from a panel button should refresh that panel instead of spawning a new message each time.
function refreshPanel(interaction, s) {
  const payload = panel(s);
  if (typeof interaction.isFromMessage === 'function' && interaction.isFromMessage()) return interaction.update(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}
async function start(interaction) {
  if (!interaction.guild || !(isAdmin(interaction) || interaction.memberPermissions?.has('Administrator'))) return interaction.reply({content:'Admin permission is required to build embeds.',flags:MessageFlags.Ephemeral});
  const channel = interaction.options.getChannel('channel');
  if (!channel || ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type)) return interaction.reply({content:'Choose a text or announcement channel.',flags:MessageFlags.Ephemeral});
  sessions.set(interaction.user.id, blank(channel.id, interaction.guildId));
  return interaction.reply({...panel(sessions.get(interaction.user.id)),flags:MessageFlags.Ephemeral});
}
async function handle(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith('eb:')) {
    const s=owned(interaction);
    if (!s) return interaction.reply({content:'This builder session expired. Run /embed again.',flags:MessageFlags.Ephemeral});
    if (!(isAdmin(interaction) || interaction.memberPermissions?.has('Administrator'))) return interaction.reply({content:'Admin permission required.',flags:MessageFlags.Ephemeral});
    const id=interaction.customId.slice(3);
    if (id==='close') { sessions.delete(interaction.user.id); return interaction.update({content:'Embed builder closed.',embeds:[],components:[]}); }
    if (id==='reset') { sessions.set(interaction.user.id,blank(s.channelId,s.guildId)); return interaction.update(panel(sessions.get(interaction.user.id))); }
    if (id==='timestamp') { s.timestamp=!s.timestamp; return interaction.update(panel(s)); }
    if (id==='profit') { s.showProfit=!s.showProfit; return interaction.update(panel(s)); }
    if (id==='clearfields') { s.fields=[]; return interaction.update(panel(s)); }
    if (id==='publish') {
      if (!s.title && !s.description) return interaction.reply({content:'Add a title or description before publishing.',flags:MessageFlags.Ephemeral});
      try {
        const channel=await interaction.guild.channels.fetch(s.channelId);
        if (!channel || !channel.isTextBased()) throw new Error('channel');
        if (s.productName) {
          const roleId=config.resellerRoleId;
          if (!roleId) return interaction.reply({content:'Set RESELLER_ROLE_ID in .env before publishing product prices.',flags:MessageFlags.Ephemeral});
          const everyone=channel.permissionOverwrites.cache.get(interaction.guild.roles.everyone.id);
          const roleOverwrite=channel.permissionOverwrites.cache.get(roleId);
          if (!everyone || everyone.allow.has('ViewChannel') || !everyone.deny.has('ViewChannel') || !roleOverwrite || !roleOverwrite.allow.has('ViewChannel')) return interaction.reply({content:'Privacy check failed: destination must deny View Channel to @everyone and explicitly allow it for the configured reseller role.',flags:MessageFlags.Ephemeral});
        }
        const components=[];
        if (s.links.length) components.push(new ActionRowBuilder().addComponents(s.links.map(l=>new ButtonBuilder().setLabel(l.label).setStyle(ButtonStyle.Link).setURL(l.url))));
        await channel.send({embeds:[getEmbed(s)],components,allowedMentions:{parse:[]}});
        audit(db,interaction.user.id,'EMBED_BUILDER_PUBLISH',channel.id,`fields=${s.fields.length}; links=${s.links.length}; content omitted`,'SUCCESS');
        sessions.delete(interaction.user.id);
        return interaction.update({content:`✅ Embed published in <#${channel.id}>.`,embeds:[],components:[]});
      } catch { return interaction.reply({content:'Could not publish. Check bot permissions and channel access.',flags:MessageFlags.Ephemeral}); }
    }
    if (id==='field' && s.fields.length>=MAX_FIELDS) return interaction.reply({content:'Maximum 3 fields allowed in this builder.',flags:MessageFlags.Ephemeral});
    if (id==='links' && s.links.length>=MAX_LINKS) return interaction.reply({content:'Maximum 2 link buttons allowed. Reset to start again.',flags:MessageFlags.Ephemeral});
    const defs={title:['Edit Title',[input('value','Title',true,TextInputStyle.Short,s.title)]],description:['Edit Description',[input('value','Description',true,TextInputStyle.Paragraph,s.description)]],color:['Set Embed Color',[input('value','HEX color e.g. #FF6A00',true,TextInputStyle.Short,s.color)]],image:['Set Large Image',[input('value','HTTPS image URL',false,TextInputStyle.Short,s.image)]],thumbnail:['Set Thumbnail',[input('value','HTTPS thumbnail URL',false,TextInputStyle.Short,s.thumbnail)]],footer:['Set Footer',[input('value','Footer text',false,TextInputStyle.Short,s.footer)]],author:['Set Author',[input('name','Author name',false,TextInputStyle.Short,s.author),input('icon','Author icon HTTPS URL',false,TextInputStyle.Short,s.authorIcon)]],titleurl:['Set Title URL',[input('value','HTTPS URL',false,TextInputStyle.Short,s.titleUrl)]],field:['Add Field',[input('name','Field heading',true),input('value','Field content',true,TextInputStyle.Paragraph),input('inline','Inline? type yes or no',false,TextInputStyle.Short,'no')]],links:['Add Link Button',[input('label','Button label',true),input('url','Button URL (HTTPS)',true)]],product:['Product & Prices',[input('name','Product name',true,TextInputStyle.Short,s.productName),input('photo','Product photo HTTPS URL',false,TextInputStyle.Short,s.productPhoto),input('reseller','Reseller price (BDT)',true,TextInputStyle.Short,s.resellerPrice),input('retail','Retail price (BDT)',true,TextInputStyle.Short,s.retailPrice),input('stock','Stock: IN STOCK / LOW STOCK / OUT OF STOCK',true,TextInputStyle.Short,s.stockStatus)]]};
    if (!defs[id]) return interaction.reply({content:'Unknown builder button. Run /embed again.',flags:MessageFlags.Ephemeral});
    return interaction.showModal(modal(id,defs[id][0],defs[id][1]));
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('ebm:')) {
    const s=owned(interaction);
    if (!s) return interaction.reply({content:'This builder session expired. Run /embed again.',flags:MessageFlags.Ephemeral});
    const id=interaction.customId.slice(4); const val=k=>interaction.fields.getTextInputValue(k).trim();
    try {
      if (id==='title') s.title=safe(val('value'),256);
      else if (id==='description') s.description=safe(val('value'),3500);
      else if (id==='color') { const c=val('value'); if(!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error('Enter a HEX color like #FF6A00.'); s.color=c; }
      else if (id==='image' || id==='thumbnail') s[id]=validUrl(val('value'));
      else if (id==='footer') s.footer=safe(val('value'),2048);
      else if (id==='author') { s.author=safe(val('name'),256); s.authorIcon=validUrl(val('icon')); if(s.authorIcon&&!s.author) throw new Error('Author name is required when using an icon.'); }
      else if (id==='titleurl') s.titleUrl=validUrl(val('value'));
      else if (id==='field') { const inline=val('inline').toLowerCase(); if(inline && !['yes','no','true','false'].includes(inline)) throw new Error('Inline must be yes or no.'); s.fields.push({name:safe(val('name'),256),value:safe(val('value'),1024),inline:['yes','true'].includes(inline)}); }
      else if (id==='links') { const label=safe(val('label'),80); const url=validUrl(val('url')); if(!label||!url) throw new Error('Provide both button label and HTTPS URL.'); s.links.push({label,url}); }
      else if (id==='product') {
        const name=safe(val('name'),256); const photo=validUrl(val('photo')); const rp=val('reseller'); const retail=val('retail'); const stock=val('stock').toUpperCase();
        if(!name) throw new Error('Product name is required.');
        if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(rp)||!/^\d{1,9}(?:\.\d{1,2})?$/.test(retail)) throw new Error('Prices must be valid positive BDT amounts.');
        if(!['IN STOCK','LOW STOCK','OUT OF STOCK'].includes(stock)) throw new Error('Stock must be IN STOCK, LOW STOCK, or OUT OF STOCK.');
        s.productName=name; s.productPhoto=photo; s.resellerPrice=String(Number(rp)); s.retailPrice=String(Number(retail)); s.stockStatus=stock;
      }
      return refreshPanel(interaction, s);
    } catch(err) { return interaction.reply({content:err.message || 'Invalid input.',flags:MessageFlags.Ephemeral}); }
  }
  return false;
}
module.exports={start,handle,getEmbed,blank,validUrl,safe};
