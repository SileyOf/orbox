import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import type { ButtonInteraction, Message } from 'discord.js';
import { integration } from '../site.js';
import { inboundAction, inboundText } from './hub.js';
import type { Adapter, BotIO, Card } from './types.js';
import { splitCard } from './types.js';

// Discord：机器人通过网关接收私信和按钮点击。私信里的消息内容不需要额外申请 Message Content 权限。

let client: Client | null = null;

export function render(c: Card) {
  const copies = (c.buttons || []).flat().filter((b) => b.copy);
  const content = `${c.title ? `**${c.title}**\n` : ''}${c.text}${copies.map((b) => `\n\`${b.copy}\``).join('')}`;
  // 每行最多 5 个按钮、每条消息最多 5 行
  const rows = (c.buttons || [])
    .map((row) =>
      row
        .filter((b) => !b.copy && (b.url || (b.action && b.action.length <= 100)))
        .slice(0, 5)
        .map((b) =>
          b.url
            ? new ButtonBuilder().setLabel(b.text.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(b.url)
            : new ButtonBuilder().setLabel(b.text.slice(0, 80)).setStyle(ButtonStyle.Secondary).setCustomId(b.action!),
        ),
    )
    .filter((r) => r.length)
    .slice(0, 5)
    .map((r) => new ActionRowBuilder<ButtonBuilder>().addComponents(r));
  return { content, components: rows };
}

async function sendCard(chatId: string, c: Card) {
  const ch = await client!.channels.fetch(chatId);
  if (!ch?.isSendable()) throw new Error('无法向这个频道发消息');
  for (const part of splitCard(c, 1800)) await ch.send(render(part));
}

function ioFor(chatId: string, interaction?: ButtonInteraction): BotIO {
  return {
    reply: (c) => sendCard(chatId, c),
    file: async (name, data) => {
      const ch = await client!.channels.fetch(chatId);
      if (ch?.isSendable()) await ch.send({ files: [new AttachmentBuilder(data, { name })] });
    },
    note: async (text) => {
      if (interaction && !text.endsWith('…')) await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
    },
  };
}

/** 把机器人拉进服务器的邀请链接（需要和机器人在同一个服务器才能私信） */
export const discordInviteUrl = () =>
  client?.application?.id
    ? `https://discord.com/oauth2/authorize?client_id=${client.application.id}&scope=bot&permissions=${2048 + 32768}`
    : null;

export const discord: Adapter = {
  platform: 'discord',
  label: 'Discord',
  enabled: () => !!integration('discord').token,
  name: () => client?.user?.username ?? null,
  bindHint: (code) => ({ text: `私信机器人 ${client?.user?.username ?? ''}，发送：绑定 ${code}（需要先和机器人在同一个服务器，或把它安装到你的账号）` }),

  async start() {
    const c = new Client({ intents: [GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });
    c.on(Events.MessageCreate, async (msg: Message) => {
      if (msg.author.bot || msg.channel.type !== ChannelType.DM || !msg.content.trim()) return;
      await inboundText('discord', msg.channelId, msg.content, msg.author.username, ioFor(msg.channelId));
    });
    c.on(Events.InteractionCreate, async (i) => {
      if (!i.isButton()) return;
      await i.deferUpdate().catch(() => {});
      await inboundAction('discord', i.channelId, i.customId, ioFor(i.channelId, i));
    });
    c.on(Events.Error, (e) => console.error('[discord]', e.message));
    await c.login(integration('discord').token);
    client = c;
    console.log(`[discord] ${c.user?.tag} 已连接`);
  },

  async stop() {
    const c = client;
    client = null;
    await c?.destroy();
  },

  send: (chatId, c) => sendCard(chatId, c),
  async sendFile(chatId, name, data) {
    const ch = await client!.channels.fetch(chatId);
    if (ch?.isSendable()) await ch.send({ files: [new AttachmentBuilder(data, { name })] });
  },
};
