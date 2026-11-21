const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, Events } = require('discord.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// =========================================================
// STORAGE DIRECTORIES & PERSISTENT JSON STORES
// =========================================================
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const FILES_FILE = path.join(DATA_DIR, 'file_links.json');

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(FILES_FILE)) fs.writeFileSync(FILES_FILE, JSON.stringify({}, null, 2));

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readUsers() {
  return readJson(USERS_FILE, []);
}

function writeUsers(users) {
  writeJson(USERS_FILE, users);
}

function readFileLinks() {
  return readJson(FILES_FILE, {});
}

function writeFileLinks(links) {
  writeJson(FILES_FILE, links);
}

// Clean up expired 3-hour file download links and files on disk
function cleanupExpiredFiles() {
  const now = Date.now();
  const links = readFileLinks();
  let changed = false;

  for (const [token, info] of Object.entries(links)) {
    if (now > info.expiresAt) {
      const fullPath = path.join(UPLOADS_DIR, info.storedName);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch {}
      }
      delete links[token];
      changed = true;
    }
  }

  if (changed) {
    writeFileLinks(links);
  }
}

setInterval(cleanupExpiredFiles, 60 * 1000);
cleanupExpiredFiles();

function sanitizeUser(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    username: user.username,
    avatarUrl: user.avatarUrl || null,
    trustedDevices: (user.trustedDevices || []).map((d) => ({
      deviceId: d.deviceId,
      label: d.label,
      lastUsed: d.lastUsed
    }))
  };
}

// =========================================================
// EXPRESS & SESSION MIDDLEWARE
// =========================================================
app.use(express.json({ limit: '3mb' }));

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sessionMiddleware = session({
  name: 'bridge_chat_sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: THIRTY_DAYS_MS
  }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================
// AUTH & TRUSTED DEVICE ENDPOINTS
// =========================================================
function attachTrustedDevice(user, req, res, existingDeviceId = null) {
  user.trustedDevices = user.trustedDevices || [];
  const ua = req.headers['user-agent'] || 'Unknown Device';
  const shortLabel = ua.includes('Mobile') || ua.includes('iPhone') || ua.includes('Android')
    ? 'Mobile Browser'
    : ua.includes('Mac')
    ? 'Mac Browser'
    : ua.includes('Windows')
    ? 'Windows Browser'
    : 'Web Browser';

  const deviceId = existingDeviceId || crypto.randomUUID();
  const existingIdx = user.trustedDevices.findIndex((d) => d.deviceId === deviceId);
  const record = {
    deviceId,
    label: `${shortLabel} • ${req.ip || 'web'}`,
    lastUsed: Date.now()
  };

  if (existingIdx >= 0) {
    user.trustedDevices[existingIdx] = record;
  } else {
    user.trustedDevices.push(record);
  }

  res.cookie('trusted_device_id', deviceId, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: THIRTY_DAYS_MS
  });

  return deviceId;
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';').map((s) => s.trim());
  for (const part of parts) {
    if (part.startsWith(name + '=')) {
      return decodeURIComponent(part.slice(name.length + 1));
    }
  }
  return null;
}

function resolveAuthenticatedUser(req, res) {
  const users = readUsers();
  const deviceId = getCookie(req, 'trusted_device_id');

  // 1. Active session
  if (req.session.userId) {
    const user = users.find((u) => u.id === req.session.userId);
    if (user) {
      attachTrustedDevice(user, req, res, deviceId);
      writeUsers(users);
      return user;
    }
  }

  // 2. Trusted device cookie fallback (keeps user logged in on known devices)
  if (deviceId) {
    const user = users.find((u) =>
      (u.trustedDevices || []).some((d) => d.deviceId === deviceId)
    );
    if (user) {
      req.session.userId = user.id;
      attachTrustedDevice(user, req, res, deviceId);
      writeUsers(users);
      return user;
    }
  }

  return null;
}

app.get('/api/auth/me', (req, res) => {
  const user = resolveAuthenticatedUser(req, res);
  if (!user) {
    return res.json({ user: null });
  }
  return res.json({ user: sanitizeUser(user) });
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const firstName = String(req.body.firstName || '').trim();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const avatarUrl =
      typeof req.body.avatarUrl === 'string' && req.body.avatarUrl.startsWith('data:image/')
        ? req.body.avatarUrl
        : null;

    if (!firstName || !username || !password) {
      return res.status(400).json({ error: 'First name, username, and password are required.' });
    }
    if (!/^[a-zA-Z0-9_.-]{2,24}$/.test(username)) {
      return res.status(400).json({
        error: 'Username must be 2–24 characters (letters, numbers, _, ., -).'
      });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const users = readUsers();
    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ error: 'Username already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = {
      id: crypto.randomUUID(),
      firstName,
      username,
      passwordHash,
      avatarUrl,
      trustedDevices: [],
      createdAt: Date.now()
    };

    req.session.userId = newUser.id;
    attachTrustedDevice(newUser, req, res);
    users.push(newUser);
    writeUsers(users);

    return res.status(201).json({ user: sanitizeUser(newUser) });
  } catch (err) {
    console.error('[Signup Error]:', err);
    return res.status(500).json({ error: 'Failed to create account.' });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const users = readUsers();
    const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    req.session.userId = user.id;
    attachTrustedDevice(user, req, res);
    writeUsers(users);

    return res.json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error('[Signin Error]:', err);
    return res.status(500).json({ error: 'Sign in failed.' });
  }
});

app.post('/api/auth/revoke-device', (req, res) => {
  const user = resolveAuthenticatedUser(req, res);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const targetId = String(req.body.deviceId || '');
  const users = readUsers();
  const dbUser = users.find((u) => u.id === user.id);
  if (!dbUser) return res.status(404).json({ error: 'User not found.' });

  dbUser.trustedDevices = (dbUser.trustedDevices || []).filter((d) => d.deviceId !== targetId);
  writeUsers(users);

  const currentDeviceId = getCookie(req, 'trusted_device_id');
  if (targetId === currentDeviceId) {
    res.clearCookie('trusted_device_id');
    req.session.destroy(() => {});
  }

  return res.json({ user: sanitizeUser(dbUser) });
});

app.post('/api/auth/signout', (req, res) => {
  const deviceId = getCookie(req, 'trusted_device_id');
  if (req.session.userId && deviceId) {
    const users = readUsers();
    const dbUser = users.find((u) => u.id === req.session.userId);
    if (dbUser) {
      dbUser.trustedDevices = (dbUser.trustedDevices || []).filter((d) => d.deviceId !== deviceId);
      writeUsers(users);
    }
  }
  res.clearCookie('trusted_device_id');
  res.clearCookie('bridge_chat_sid');
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// =========================================================
// FILE UPLOADS (3-HOUR EXPIRING DOWNLOAD LINKS) & GIPHY
// =========================================================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safeExt = path.extname(file.originalname || '').slice(0, 12);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  cleanupExpiredFiles();
  const user = resolveAuthenticatedUser(req, res);
  if (!user) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(401).json({ error: 'Sign in required to upload files.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file received.' });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + THREE_HOURS_MS;
  const mime = req.file.mimetype || 'application/octet-stream';

  let kind = 'file';
  if (mime.startsWith('image/')) kind = 'image';
  else if (mime.startsWith('video/')) kind = 'video';

  const links = readFileLinks();
  links[token] = {
    token,
    storedName: req.file.filename,
    originalName: req.file.originalname || 'file',
    mimeType: mime,
    kind,
    expiresAt
  };
  writeFileLinks(links);

  const publicUrl = `/dl/${token}`;
  return res.json({
    token,
    url: publicUrl,
    originalName: links[token].originalName,
    kind,
    expiresAt
  });
});

app.get('/dl/:token', (req, res) => {
  cleanupExpiredFiles();
  const links = readFileLinks();
  const info = links[req.params.token];

  if (!info || Date.now() > info.expiresAt) {
    return res.status(404).send('This download link has expired (links last 3 hours) or does not exist.');
  }

  const filePath = path.join(UPLOADS_DIR, info.storedName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found.');
  }

  if (info.kind === 'image' || info.kind === 'video') {
    res.setHeader('Content-Type', info.mimeType);
    return res.sendFile(filePath);
  }

  return res.download(filePath, info.originalName);
});

// GIPHY Search Endpoint
app.get('/api/giphy', async (req, res) => {
  const q = String(req.query.q || 'funny reaction').trim().slice(0, 60);
  const apiKey = process.env.GIPHY_API_KEY || '';

  if (!apiKey) {
    return res.json({
      gifs: [
        {
          id: 'fallback-1',
          title: 'Wave',
          url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExN2x2OXl6bWF3eGJ6Ynl5eG95cG96bWF3eGJ6Ynl5eG95cG96/3o7abKhOup0N392LPy/giphy.gif'
        },
        {
          id: 'fallback-2',
          title: 'Thumbs Up',
          url: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif'
        },
        {
          id: 'fallback-3',
          title: 'High Five',
          url: 'https://media.giphy.com/media/l0ErFafpUCQTQFMSY/giphy.gif'
        }
      ],
      note: 'Set GIPHY_API_KEY in Render env vars for live full GIPHY search.'
    });
  }

  try {
    const endpoint = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(
      apiKey
    )}&q=${encodeURIComponent(q)}&limit=12&rating=pg-13`;
    const r = await fetch(endpoint);
    const json = await r.json();
    const gifs = (json.data || []).map((g) => ({
      id: g.id,
      title: g.title || 'GIF',
      url: g.images?.fixed_height?.url || g.images?.original?.url
    })).filter((g) => Boolean(g.url));

    return res.json({ gifs });
  } catch (err) {
    console.error('[GIPHY Error]:', err.message);
    return res.status(500).json({ error: 'Failed to fetch GIFs.' });
  }
});

// =========================================================
// DISCORD CHANNELS, PING TRANSLATION & RELAY
// =========================================================
const CHANNELS = {
  supervised: {
    slug: 'supervised',
    path: '/supervised',
    name: '#supervised',
    emoji: '🛡️',
    color: '#D8F3DC',
    discordChannelId: process.env.DISCORD_SUPERVISED_ID || ''
  },
  unsupervised: {
    slug: 'unsupervised',
    path: '/unsupervised',
    name: '#unsupervised',
    emoji: '🚀',
    color: '#FFE5D9',
    discordChannelId: process.env.DISCORD_UNSUPERVISED_ID || ''
  },
  fs: {
    slug: 'fs',
    path: '/fs',
    name: '#free-speech',
    emoji: '🗽',
    color: '#E0AAFF',
    discordChannelId: process.env.DISCORD_FS_ID || ''
  }
};

const discordIdToSlug = {};
Object.values(CHANNELS).forEach((ch) => {
  if (ch.discordChannelId) {
    discordIdToSlug[ch.discordChannelId] = ch.slug;
  }
});

// Caches for translating pings in both directions
const discordUserIdToName = new Map(); // id -> username
const discordNameToUserId = new Map(); // lowercase username/displayName -> id
const discordChannelIdToName = new Map(); // id -> channelName

const messageHistory = {
  supervised: [],
  unsupervised: [],
  fs: []
};

function saveMessage(room, msg) {
  if (!messageHistory[room]) messageHistory[room] = [];
  messageHistory[room].push(msg);
  if (messageHistory[room].length > 120) {
    messageHistory[room].shift();
  }
}

async function cacheGuildDirectory(guild) {
  if (!guild) return;
  try {
    guild.channels.cache.forEach((ch) => {
      if (ch.name) discordChannelIdToName.set(ch.id, ch.name);
    });
    guild.members.cache.forEach((m) => {
      const uname = m.user?.username;
      if (uname) {
        discordUserIdToName.set(m.id, uname);
        discordNameToUserId.set(uname.toLowerCase(), m.id);
      }
      if (m.displayName) {
        discordNameToUserId.set(m.displayName.toLowerCase(), m.id);
      }
    });
  } catch {}
}

// Discord -> App: translate <@123>, <@!123>, <#123> to readable @username / #channel
function translateDiscordPingsToReadable(text, message) {
  if (!text) return '';
  if (message?.mentions?.users) {
    message.mentions.users.forEach((u) => {
      discordUserIdToName.set(u.id, u.username);
      discordNameToUserId.set(u.username.toLowerCase(), u.id);
    });
  }
  if (message?.mentions?.channels) {
    message.mentions.channels.forEach((c) => {
      if (c.name) discordChannelIdToName.set(c.id, c.name);
    });
  }

  return text
    .replace(/<@!?(\d+)>/g, (_, userId) => {
      const name = discordUserIdToName.get(userId);
      return name ? `@${name}` : `@user(${userId})`;
    })
    .replace(/<#(\d+)>/g, (_, chId) => {
      const chName = discordChannelIdToName.get(chId);
      return chName ? `#${chName}` : `#channel(${chId})`;
    });
}

// App -> Discord: translate @username back into <@discordUserId> when known, keep @everyone / @here
function translateAppPingsToDiscord(text) {
  if (!text) return '';
  return text.replace(/@([a-zA-Z0-9_.-]{1,32})/g, (fullMatch, handle) => {
    const lower = handle.toLowerCase();
    if (lower === 'everyone' || lower === 'here') {
      return `@${lower}`;
    }
    const discordId = discordNameToUserId.get(lower);
    if (discordId) {
      return `<@${discordId}>`;
    }
    return fullMatch;
  });
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
let discordReady = false;

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

if (DISCORD_TOKEN) {
  discordClient.once(Events.ClientReady, async (c) => {
    discordReady = true;
    console.log(`[Discord] Logged in as ${c.user.tag}`);
    for (const [, guild] of c.guilds.cache) {
      await cacheGuildDirectory(guild);
    }
    io.emit('bridge_status', { connected: true });
  });

  discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.guild) await cacheGuildDirectory(message.guild);

    const roomSlug = discordIdToSlug[message.channel.id];
    if (!roomSlug) return;

    discordUserIdToName.set(message.author.id, message.author.username);
    discordNameToUserId.set(message.author.username.toLowerCase(), message.author.id);

    const readableText = translateDiscordPingsToReadable(message.content || '', message);
    const attachments = message.attachments.map((a) => ({
      url: a.url,
      name: a.name || 'attachment',
      isImage: /\.(png|jpe?g|gif|webp)$/i.test(a.name || a.url),
      isVideo: /\.(mp4|webm|mov)$/i.test(a.name || a.url)
    }));

    const payload = {
      id: message.id,
      room: roomSlug,
      sender: message.author.username,
      firstName: message.member?.displayName || null,
      avatar: message.author.displayAvatarURL({ extension: 'png', size: 128 }),
      text: readableText,
      attachments,
      source: 'discord',
      timestamp: Date.now()
    };

    saveMessage(roomSlug, payload);
    io.to(roomSlug).emit('chat_message', payload);
    io.emit('thread_preview', payload);
  });

  discordClient.login(DISCORD_TOKEN).catch((err) => {
    console.error('[Discord Login Error]:', err.message);
  });
} else {
  console.log('[Server] DISCORD_TOKEN not configured.');
}

// =========================================================
// SOCKET.IO REAL-TIME MESSAGING
// =========================================================
io.on('connection', (socket) => {
  const previews = {};
  Object.keys(CHANNELS).forEach((slug) => {
    const hist = messageHistory[slug];
    previews[slug] = hist.length ? hist[hist.length - 1] : null;
  });

  socket.emit('init_state', {
    discordConnected: discordReady,
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
    const sessionUserId = socket.request.session?.userId;
    const users = readUsers();
    const user = users.find((u) => u.id === sessionUserId);
    if (!user) {
      socket.emit('auth_required');
      return;
    }

    const room = data.room;
    const channelConfig = CHANNELS[room];
    const cleanText = String(data.text || '').trim();
    const attachments = Array.isArray(data.attachments) ? data.attachments.slice(0, 5) : [];

    if (!channelConfig || (!cleanText && attachments.length === 0)) return;

    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      room,
      sender: user.username,
      firstName: user.firstName,
      avatar: user.avatarUrl || null,
      text: cleanText,
      attachments,
      source: 'app',
      timestamp: Date.now()
    };

    saveMessage(room, payload);
    io.to(room).emit('chat_message', payload);
    io.emit('thread_preview', payload);

    // Relay to Discord as "[USERNAME] ([FIRST-NAME]): message"
    if (discordReady && channelConfig.discordChannelId) {
      try {
        const discordChannel = await discordClient.channels.fetch(channelConfig.discordChannelId);
        if (discordChannel) {
          if (discordChannel.guild) await cacheGuildDirectory(discordChannel.guild);
          const translatedBody = translateAppPingsToDiscord(cleanText);
          const attachmentLines = attachments
            .map((att) =>
              att.fullUrl ? att.fullUrl : `${att.name || 'File'}: ${att.url}`
            )
            .join('\n');

          const combined = [translatedBody, attachmentLines].filter(Boolean).join('\n');
          await discordChannel.send({
            content: `**[${user.username} (${user.firstName})]:** ${combined}`.slice(0, 1990),
            allowedMentions: { parse: ['users', 'roles', 'everyone'] }
          });
        }
      } catch (err) {
        console.error(`[Discord Relay Error -> ${channelConfig.name}]:`, err.message);
      }
    }
  });

  socket.on('typing', ({ room, isTyping }) => {
    const sessionUserId = socket.request.session?.userId;
    const users = readUsers();
    const user = users.find((u) => u.id === sessionUserId);
    if (CHANNELS[room] && user) {
      socket.to(room).emit('user_typing', {
        room,
        sender: user.username,
        isTyping
      });
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', discordReady });
});

app.get(['/', '/supervised', '/unsupervised', '/fs'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
