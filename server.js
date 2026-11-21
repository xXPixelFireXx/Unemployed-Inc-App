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

try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
  if (!fs.existsSync(FILES_FILE)) fs.writeFileSync(FILES_FILE, JSON.stringify({}, null, 2));
} catch (err) {
  console.error('[Storage Init Warning]:', err.message);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Write JSON Warning]:', err.message);
  }
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

function cleanupExpiredFiles() {
  try {
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
  } catch (err) {
    console.error('[Cleanup Warning]:', err.message);
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
    authToken: user.authToken || null,
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
  if (!user.authToken) {
    user.authToken = crypto.randomBytes(24).toString('hex');
  }
  const ua = req.headers['user-agent'] || 'Unknown Device';
  const shortLabel =
    ua.includes('Mobile') || ua.includes('iPhone') || ua.includes('Android')
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

function resolveAuthenticatedUser(req, res, explicitToken = null) {
  const users = readUsers();
  const deviceId = getCookie(req, 'trusted_device_id');
  const bearerOrToken =
    explicitToken ||
    req.headers['x-auth-token'] ||
    (req.body && req.body.authToken) ||
    null;

  if (req.session && req.session.userId) {
    const user = users.find((u) => u.id === req.session.userId);
    if (user) {
      attachTrustedDevice(user, req, res, deviceId);
      writeUsers(users);
      return user;
    }
  }

  if (deviceId) {
    const user = users.find((u) =>
      (u.trustedDevices || []).some((d) => d.deviceId === deviceId)
    );
    if (user) {
      if (req.session) req.session.userId = user.id;
      attachTrustedDevice(user, req, res, deviceId);
      writeUsers(users);
      return user;
    }
  }

  if (bearerOrToken) {
    const user = users.find((u) => u.authToken && u.authToken === String(bearerOrToken));
    if (user) {
      if (req.session) req.session.userId = user.id;
      attachTrustedDevice(user, req, res, deviceId);
      writeUsers(users);
      return user;
    }
  }

  return null;
}

app.get('/api/auth/me', (req, res) => {
  const token = req.query.token ? String(req.query.token) : null;
  const user = resolveAuthenticatedUser(req, res, token);
  if (!user) {
    return res.json({ user: null });
  }
  return res.json({ user: sanitizeUser(user) });
});

app.post('/api/auth/enter', async (req, res) => {
  try {
    const firstName = String(req.body.firstName || '').trim();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const cachedKnownUser = Boolean(req.body.cachedKnownUser);
    const avatarUrl =
      typeof req.body.avatarUrl === 'string' && req.body.avatarUrl.startsWith('data:image/')
        ? req.body.avatarUrl
        : null;

    if (!username) {
      return res.status(400).json({ error: 'Username is required.' });
    }
    if (!/^[a-zA-Z0-9_.-]{2,24}$/.test(username)) {
      return res.status(400).json({
        error: 'Username must be 2–24 characters (letters, numbers, _, ., -).'
      });
    }

    const users = readUsers();
    const existingUser = users.find((u) => u.username.toLowerCase() === username.toLowerCase());

    if (existingUser) {
      let authenticated = false;
      if (password) {
        authenticated = await bcrypt.compare(password, existingUser.passwordHash);
      } else if (
        cachedKnownUser &&
        firstName &&
        firstName.toLowerCase() === String(existingUser.firstName || '').toLowerCase()
      ) {
        authenticated = true;
      }

      if (!authenticated) {
        return res.status(401).json({
          error: 'Account found for this username — please enter your password.'
        });
      }

      if (firstName && firstName !== existingUser.firstName) {
        existingUser.firstName = firstName;
      }
      if (avatarUrl) {
        existingUser.avatarUrl = avatarUrl;
      }

      req.session.userId = existingUser.id;
      attachTrustedDevice(existingUser, req, res);
      writeUsers(users);

      return res.json({ user: sanitizeUser(existingUser), mode: 'signin' });
    }

    if (!firstName) {
      return res.status(400).json({ error: 'First name is required for a new account.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters for a new account.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = {
      id: crypto.randomUUID(),
      firstName,
      username,
      passwordHash,
      avatarUrl,
      authToken: crypto.randomBytes(24).toString('hex'),
      trustedDevices: [],
      createdAt: Date.now()
    };

    req.session.userId = newUser.id;
    attachTrustedDevice(newUser, req, res);
    users.push(newUser);
    writeUsers(users);

    return res.status(201).json({ user: sanitizeUser(newUser), mode: 'signup' });
  } catch (err) {
    console.error('[Auth Enter Error]:', err);
    return res.status(500).json({ error: 'Failed to sign in or create account.' });
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
  if (req.session && req.session.userId && deviceId) {
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
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  cleanupExpiredFiles();
  const token = req.headers['x-auth-token'] || (req.body && req.body.authToken) || null;
  const user = resolveAuthenticatedUser(req, res, token);
  if (!user) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(401).json({ error: 'Sign in required to upload files.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file received.' });
  }

  const fileToken = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + THREE_HOURS_MS;
  const mime = req.file.mimetype || 'application/octet-stream';

  let kind = 'file';
  if (mime.startsWith('image/')) kind = 'image';
  else if (mime.startsWith('video/')) kind = 'video';

  const links = readFileLinks();
  links[fileToken] = {
    token: fileToken,
    storedName: req.file.filename,
    originalName: req.file.originalname || 'file',
    mimeType: mime,
    kind,
    expiresAt
  };
  writeFileLinks(links);

  return res.json({
    token: fileToken,
    url: `/dl/${fileToken}`,
    originalName: links[fileToken].originalName,
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
    const gifs = (json.data || [])
      .map((g) => ({
        id: g.id,
        title: g.title || 'GIF',
        url: g.images?.fixed_height?.url || g.images?.original?.url
      }))
      .filter((g) => Boolean(g.url));

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

const discordUserIdToName = new Map();
const discordNameToUserId = new Map();
const discordChannelIdToName = new Map();

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
    GatewayIntentBits.MessageContent
  ]
});

discordClient.on('error', (err) => {
  console.error('[Discord Client Error]:', err.message);
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
}

function resolveSocketUser(socket, data = {}) {
  const users = readUsers();
  const sessionUserId = socket.request.session?.userId;
  if (sessionUserId) {
    const u = users.find((x) => x.id === sessionUserId);
    if (u) return u;
  }
  if (data.authToken) {
    const u = users.find((x) => x.authToken === String(data.authToken));
    if (u) {
      if (socket.request.session) socket.request.session.userId = u.id;
      return u;
    }
  }
  if (data.username) {
    const u = users.find(
      (x) => x.username.toLowerCase() === String(data.username).trim().toLowerCase()
    );
    if (u) return u;
  }
  return null;
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

  socket.on('send_message', async (data = {}) => {
    const user = resolveSocketUser(socket, data);
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

    if (discordReady && channelConfig.discordChannelId) {
      try {
        const discordChannel = await discordClient.channels.fetch(channelConfig.discordChannelId);
        if (discordChannel) {
          if (discordChannel.guild) await cacheGuildDirectory(discordChannel.guild);
          const translatedBody = translateAppPingsToDiscord(cleanText);
          const attachmentLines = attachments
            .map((att) => (att.fullUrl ? att.fullUrl : `${att.name || 'File'}: ${att.url}`))
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

  socket.on('typing', (data = {}) => {
    const user = resolveSocketUser(socket, data);
    if (CHANNELS[data.room] && user) {
      socket.to(data.room).emit('user_typing', {
        room: data.room,
        sender: user.username,
        isTyping: Boolean(data.isTyping)
      });
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', discordReady });
});

const spaHandler = (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
};

app.get('/', spaHandler);
app.get('/supervised', spaHandler);
app.get('/unsupervised', spaHandler);
app.get('/fs', spaHandler);

server.on('error', (err) => {
  console.error('[HTTP Server Error]:', err.message);
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
