const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, Events } = require('discord.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

// Channel configuration mapped to your 3 URL paths
const CHANNELS = {
  supervised: {
    slug: 'supervised',
    path: '/supervised',
    name: '#supervised',
    subtitle: 'Moderated Channel • Discord + Web',
    emoji: '🛡️',
    color: '#D8F3DC',
    discordChannelId: process.env.DISCORD_SUPERVISED_ID || ''
  },
  unsupervised: {
    slug: 'unsupervised',
    path: '/unsupervised',
    name: '#unsupervised',
    subtitle: 'Open Channel • Discord + Web',
    emoji: '🚀',
    color: '#FFE5D9',
    discordChannelId: process.env.DISCORD_UNSUPERVISED_ID || ''
  },
  fs: {
    slug: 'fs',
    path: '/fs',
    name: '#free-speech',
    subtitle: 'Unfiltered • Discord + Web',
    emoji: '🗽',
    color: '#E0AAFF',
    discordChannelId: process.env.DISCORD_FS_ID || ''
  }
};

// Reverse lookup from Discord Channel ID -> internal room slug
const discordIdToSlug = {};
Object.values(CHANNELS).forEach((ch) => {
  if (ch.discordChannelId) {
    discordIdToSlug[ch.discordChannelId] = ch.slug;
  }
});

// In-memory history (stores last 100 messages per channel)
const messageHistory = {
  supervised: [],
  unsupervised: [],
  fs: []
};

function saveMessage(room, msg) {
  if (!messageHistory[room]) messageHistory[room] = [];
  messageHistory[room].push(msg);
  if (messageHistory[room].length > 100) {
    messageHistory[room].shift();
  }
}

// Discord Bot Setup
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
let discordReady = false;

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

if (DISCORD_TOKEN) {
  discordClient.once(Events.ClientReady, (c) => {
    discordReady = true;
    console.log(`[Discord Bridge] Connected as ${c.user.tag}`);
    io.emit('bridge_status', { connected: true });
  });

  // DISCORD -> WEB APP
  discordClient.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;

    const roomSlug = discordIdToSlug[message.channel.id];
    if (!roomSlug) return;

    const attachments = message.attachments.map((a) => a.url);
    const payload = {
      id: message.id,
      room: roomSlug,
      sender: message.member?.displayName || message.author.username,
      avatar: message.author.displayAvatarURL({ size: 64 }),
      text: message.content || (attachments.length ? '' : '[Attachment]'),
      attachments,
      source: 'discord',
      timestamp: Date.now()
    };

    saveMessage(roomSlug, payload);
    io.to(roomSlug).emit('chat_message', payload);
    io.emit('thread_preview', payload);
  });

  discordClient.login(DISCORD_TOKEN).catch((err) => {
    console.error('[Discord Bridge] Login Error:', err.message);
  });
} else {
  console.log('[Server] DISCORD_TOKEN not set. Running in internal server mode.');
}

// WEB APP -> INTERNAL SERVER & DISCORD
io.on('connection', (socket) => {
  // Send initial channel metadata & latest previews
  const previews = {};
  Object.keys(CHANNELS).forEach((slug) => {
    const hist = messageHistory[slug];
    previews[slug] = hist.length ? hist[hist.length - 1] : null;
  });

  socket.emit('init_state', {
    discordConnected: discordReady,
    channels: CHANNELS,
    previews
  });

  socket.on('join_room', (roomSlug) => {
    if (!CHANNELS[roomSlug]) return;
    socket.join(roomSlug);
    socket.emit('history', {
      room: roomSlug,
      messages: messageHistory[roomSlug] || []
    });
  });

  socket.on('send_message', async (data) => {
    const { room, sender, text } = data;
    const channelConfig = CHANNELS[room];
    if (!channelConfig || !text || !text.trim()) return;

    const cleanSender = (sender || 'Guest').trim().slice(0, 24);
    const cleanText = text.trim();

    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      room,
      sender: cleanSender,
      avatar: null,
      text: cleanText,
      attachments: [],
      source: 'web',
      timestamp: Date.now()
    };

    // Broadcast to web app users in this channel
    saveMessage(room, payload);
    io.to(room).emit('chat_message', payload);
    io.emit('thread_preview', payload);

    // Relay to the mapped Discord channel
    if (discordReady && channelConfig.discordChannelId) {
      try {
        const discordChannel = await discordClient.channels.fetch(channelConfig.discordChannelId);
        if (discordChannel) {
          await discordChannel.send(`**[${cleanSender}]:** ${cleanText}`);
        }
      } catch (err) {
        console.error(`[Discord Relay Error -> ${channelConfig.name}]:`, err.message);
      }
    }
  });

  socket.on('typing', ({ room, sender, isTyping }) => {
    if (CHANNELS[room]) {
      socket.to(room).emit('user_typing', { room, sender, isTyping });
    }
  });
});

// Health Check for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', discordReady });
});

// SPA Routes for /, /supervised, /unsupervised, /fs
app.get(['/', '/supervised', '/unsupervised', '/fs'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`iMessage-Discord Bridge running on port ${PORT}`);
});
