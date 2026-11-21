const socket = io();

const STORAGE_USER_KEY = 'bridge_chat_user_v1';
const STORAGE_HISTORY_USERS_KEY = 'bridge_chat_known_usernames_v1';
const STORAGE_DARK_MODE_KEY = 'bridge_chat_dark_mode_v1';

const CHANNEL_META = {
  supervised: { slug: 'supervised', path: '/supervised', name: '#supervised', emoji: '🛡️', color: '#D8F3DC' },
  unsupervised: { slug: 'unsupervised', path: '/unsupervised', name: '#unsupervised', emoji: '🚀', color: '#FFE5D9' },
  fs: { slug: 'fs', path: '/fs', name: '#free-speech', emoji: '🗽', color: '#E0AAFF' }
};

let currentUser = loadCachedUser();
let currentSlug = 'supervised';
let uploadedAvatarDataUrl = null;
let typingTimer = null;
let initialHistoryLoadedForRoom = new Set();

// DOM Elements
const appShell = document.getElementById('appShell');
const messagesList = document.getElementById('messagesList');
const messagesScroll = document.getElementById('messagesScroll');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const headerAvatar = document.getElementById('headerAvatar');
const headerTitleText = document.getElementById('headerTitleText');
const footerAvatar = document.getElementById('footerAvatar');
const footerUserText = document.getElementById('footerUserText');
const signOutBtn = document.getElementById('signOutBtn');
const discordBridgeStatus = document.getElementById('discordBridgeStatus');
const typingRow = document.getElementById('typingRow');
const typingName = document.getElementById('typingName');
const searchInput = document.getElementById('searchInput');
const darkModeToggle = document.getElementById('darkModeToggle');
const darkModeIcon = document.getElementById('darkModeIcon');

// Attachments & GIPHY
const plusBtn = document.getElementById('plusBtn');
const attachMenu = document.getElementById('attachMenu');
const pickMediaBtn = document.getElementById('pickMediaBtn');
const pickGifBtn = document.getElementById('pickGifBtn');
const pickFileBtn = document.getElementById('pickFileBtn');
const mediaFileInput = document.getElementById('mediaFileInput');
const anyFileInput = document.getElementById('anyFileInput');

const giphyModal = document.getElementById('giphyModal');
const closeGiphyBtn = document.getElementById('closeGiphyBtn');
const giphySearchForm = document.getElementById('giphySearchForm');
const giphyQueryInput = document.getElementById('giphyQueryInput');
const giphyGrid = document.getElementById('giphyGrid');
const giphyNote = document.getElementById('giphyNote');

// Auth Modal
const authModal = document.getElementById('authModal');
const closeAuthBtn = document.getElementById('closeAuthBtn');
const authForm = document.getElementById('authForm');
const firstNameInput = document.getElementById('firstNameInput');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const avatarFileInput = document.getElementById('avatarFileInput');
const avatarPreview = document.getElementById('avatarPreview');
const authError = document.getElementById('authError');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const devicesSection = document.getElementById('devicesSection');
const devicesList = document.getElementById('devicesList');

// =========================================================
// LOCAL STORAGE HELPERS & DARK MODE
// =========================================================
function loadCachedUser() {
  try {
    const raw = localStorage.getItem(STORAGE_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCachedUser(user) {
  currentUser = user;
  try {
    if (user) {
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
      const known = loadKnownUsernames();
      if (!known.includes(user.username.toLowerCase())) {
        known.push(user.username.toLowerCase());
        localStorage.setItem(STORAGE_HISTORY_USERS_KEY, JSON.stringify(known));
      }
    } else {
      localStorage.removeItem(STORAGE_USER_KEY);
    }
  } catch {}
  updateUserUI();
  renderDevicesList();
}

function loadKnownUsernames() {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY_USERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function applyDarkMode(enabled) {
  document.body.classList.toggle('dark-mode', enabled);
  darkModeIcon.textContent = enabled ? '☀️' : '🌙';
  try {
    localStorage.setItem(STORAGE_DARK_MODE_KEY, enabled ? '1' : '0');
  } catch {}
}

darkModeToggle.addEventListener('click', () => {
  const next = !document.body.classList.contains('dark-mode');
  applyDarkMode(next);
});

applyDarkMode(localStorage.getItem(STORAGE_DARK_MODE_KEY) === '1');

// =========================================================
// NOTIFICATIONS (App & Discord messages)
// =========================================================
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {}
  }
}

function triggerMessageNotification(msg) {
  const isDiscord = msg.source === 'discord';
  const isMine = !isDiscord && currentUser && msg.sender === currentUser.username;
  if (isMine) return;

  const chName = CHANNEL_META[msg.room]?.name || `#${msg.room}`;
  const originLabel = isDiscord ? 'Discord' : 'App';
  const title = `${msg.sender} (${originLabel}) • ${chName}`;
  const body =
    msg.text ||
    (msg.attachments?.[0]?.name ? `Sent ${msg.attachments[0].name}` : 'Sent an attachment');

  if ('Notification' in window && Notification.permission === 'granted') {
    if (document.hidden || msg.room !== currentSlug) {
      try {
        const n = new Notification(title, {
          body,
          icon: msg.avatar || undefined,
          tag: `${msg.room}-${msg.id}`
        });
        n.onclick = () => {
          window.focus();
          navigateTo(CHANNEL_META[msg.room]?.path || '/supervised');
          n.close();
        };
      } catch {}
    }
  }
}

// =========================================================
// MARKDOWN FORMATTING (Bold, Italic, Bold-Italic)
// =========================================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

function formatRichText(raw) {
  let out = escapeHtml(raw);
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\b_(.+?)_\b/g, '<em>$1</em>');
  return out;
}

// =========================================================
// UNIFIED AUTH FLOW
// =========================================================
avatarFileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      canvas.getContext('2d').drawImage(img, 0, 0, 128, 128);
      uploadedAvatarDataUrl = canvas.toDataURL('image/jpeg', 0.82);
      avatarPreview.innerHTML = `<img src="${uploadedAvatarDataUrl}" alt="Preview" />`;
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

function renderDevicesList() {
  if (!currentUser || !currentUser.trustedDevices?.length) {
    devicesSection.classList.add('hidden');
    return;
  }
  devicesSection.classList.remove('hidden');
  devicesList.innerHTML = '';

  currentUser.trustedDevices.forEach((dev) => {
    const row = document.createElement('div');
    row.className = 'device-row';
    row.innerHTML = `
      <span>${escapeHtml(dev.label)}</span>
      <button type="button" class="device-revoke-btn" data-did="${escapeHtml(dev.deviceId)}">Remove</button>
    `;
    row.querySelector('.device-revoke-btn').addEventListener('click', async () => {
      const res = await fetch('/api/auth/revoke-device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(currentUser?.authToken ? { 'x-auth-token': currentUser.authToken } : {})
        },
        body: JSON.stringify({ deviceId: dev.deviceId })
      });
      const data = await res.json();
      if (res.status === 401 || !data.user) {
        saveCachedUser(null);
        authModal.classList.remove('hidden');
      } else {
        saveCachedUser(data.user);
      }
    });
    devicesList.appendChild(row);
  });
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.add('hidden');

  const uname = usernameInput.value.trim();
  const fname = firstNameInput.value.trim();
  const pw = passwordInput.value;
  const knownUsernames = loadKnownUsernames();
  const cachedKnownUser = knownUsernames.includes(uname.toLowerCase());

  authSubmitBtn.disabled = true;
  authSubmitBtn.textContent = 'Checking...';

  try {
    const res = await fetch('/api/auth/enter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: uname,
        firstName: fname,
        password: pw,
        cachedKnownUser,
        avatarUrl: uploadedAvatarDataUrl || currentUser?.avatarUrl || null
      })
    });
    const data = await res.json();

    if (!res.ok) {
      authError.textContent = data.error || 'Could not continue.';
      authError.classList.remove('hidden');
      return;
    }

    saveCachedUser(data.user);
    passwordInput.value = '';
    authModal.classList.add('hidden');
    requestNotificationPermission();
  } catch {
    authError.textContent = 'Network error connecting to server.';
    authError.classList.remove('hidden');
  } finally {
    authSubmitBtn.disabled = false;
    authSubmitBtn.textContent = 'Continue';
  }
});

signOutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/signout', {
    method: 'POST',
    headers: currentUser?.authToken ? { 'x-auth-token': currentUser.authToken } : {}
  });
  saveCachedUser(null);
  usernameInput.value = '';
  firstNameInput.value = '';
  passwordInput.value = '';
  authModal.classList.remove('hidden');
});

closeAuthBtn.addEventListener('click', () => {
  if (currentUser) {
    authModal.classList.add('hidden');
  }
});

function updateUserUI() {
  if (currentUser) {
    footerUserText.textContent = `${currentUser.username} (${currentUser.firstName})`;
    signOutBtn.classList.remove('hidden');
    closeAuthBtn.classList.remove('hidden');
    usernameInput.value = currentUser.username;
    firstNameInput.value = currentUser.firstName;
    if (currentUser.avatarUrl) {
      footerAvatar.innerHTML = `<img src="${escapeHtml(currentUser.avatarUrl)}" alt="" />`;
      avatarPreview.innerHTML = `<img src="${escapeHtml(currentUser.avatarUrl)}" alt="" />`;
    } else {
      footerAvatar.textContent = currentUser.firstName[0].toUpperCase();
      avatarPreview.textContent = currentUser.firstName[0].toUpperCase();
    }
  } else {
    footerUserText.textContent = 'Not signed in';
    footerAvatar.textContent = '?';
    avatarPreview.textContent = '?';
    signOutBtn.classList.add('hidden');
    closeAuthBtn.classList.add('hidden');
  }
}

['openAccountDesktopBtn', 'openAccountMobileBtn'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('click', () => {
      renderDevicesList();
      authModal.classList.remove('hidden');
    });
  }
});

async function checkSession() {
  if (currentUser) {
    updateUserUI();
    renderDevicesList();
    authModal.classList.add('hidden');
    requestNotificationPermission();
  }

  try {
    const query = currentUser?.authToken ? `?token=${encodeURIComponent(currentUser.authToken)}` : '';
    const res = await fetch(`/api/auth/me${query}`);
    const data = await res.json();
    if (data.user) {
      saveCachedUser(data.user);
      authModal.classList.add('hidden');
    } else if (!currentUser) {
      authModal.classList.remove('hidden');
    }
  } catch {
    if (!currentUser) {
      authModal.classList.remove('hidden');
    }
  }
}

// =========================================================
// "+" ATTACHMENT MENU, UPLOADS (3H LINKS) & GIPHY
// =========================================================
plusBtn.addEventListener('click', () => {
  if (!currentUser) {
    authModal.classList.remove('hidden');
    return;
  }
  attachMenu.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (!attachMenu.contains(e.target) && e.target !== plusBtn) {
    attachMenu.classList.add('hidden');
  }
});

pickMediaBtn.addEventListener('click', () => {
  attachMenu.classList.add('hidden');
  mediaFileInput.click();
});

pickFileBtn.addEventListener('click', () => {
  attachMenu.classList.add('hidden');
  anyFileInput.click();
});

async function handleFileUpload(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: currentUser?.authToken ? { 'x-auth-token': currentUser.authToken } : {},
    body: formData
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Upload failed.');
    return;
  }

  const fullUrl = `${window.location.origin}${data.url}`;
  socket.emit('send_message', {
    room: currentSlug,
    text: data.kind === 'file' ? `File (expires in 3h): ${data.originalName}` : '',
    attachments: [
      {
        url: data.url,
        fullUrl,
        name: data.originalName,
        isImage: data.kind === 'image',
        isVideo: data.kind === 'video',
        isFile: data.kind === 'file'
      }
    ],
    authToken: currentUser?.authToken,
    username: currentUser?.username
  });
}

mediaFileInput.addEventListener('change', (e) => {
  handleFileUpload(e.target.files?.[0]);
  e.target.value = '';
});

anyFileInput.addEventListener('change', (e) => {
  handleFileUpload(e.target.files?.[0]);
  e.target.value = '';
});

pickGifBtn.addEventListener('click', () => {
  attachMenu.classList.add('hidden');
  giphyModal.classList.remove('hidden');
  loadGifs(giphyQueryInput.value || 'excited');
});

closeGiphyBtn.addEventListener('click', () => {
  giphyModal.classList.add('hidden');
});

giphySearchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loadGifs(giphyQueryInput.value || 'funny');
});

async function loadGifs(query) {
  giphyGrid.innerHTML = '<small>Loading...</small>';
  const res = await fetch(`/api/giphy?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  giphyNote.textContent = data.note || '';
  giphyGrid.innerHTML = '';

  (data.gifs || []).forEach((gif) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'giphy-item';
    btn.innerHTML = `<img src="${escapeHtml(gif.url)}" alt="${escapeHtml(gif.title)}" />`;
    btn.addEventListener('click', () => {
      socket.emit('send_message', {
        room: currentSlug,
        text: '',
        attachments: [
          {
            url: gif.url,
            fullUrl: gif.url,
            name: `${gif.title}.gif`,
            isImage: true,
            isVideo: false,
            isFile: false
          }
        ],
        authToken: currentUser?.authToken,
        username: currentUser?.username
      });
      giphyModal.classList.add('hidden');
    });
    giphyGrid.appendChild(btn);
  });
}

// =========================================================
// URL & CHANNEL ROUTING
// =========================================================
function syncRouteFromURL() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') {
    appShell.classList.add('mobile-inbox-mode');
    appShell.classList.remove('mobile-thread-mode');
    selectChannel('supervised', false);
  } else {
    const slug = path.replace('/', '');
    if (CHANNEL_META[slug]) {
      appShell.classList.remove('mobile-inbox-mode');
      appShell.classList.add('mobile-thread-mode');
      selectChannel(slug, false);
    } else {
      navigateTo('/supervised');
    }
  }
}

function navigateTo(targetPath) {
  window.history.pushState({}, '', targetPath);
  syncRouteFromURL();
}

function selectChannel(slug, shouldPush = true) {
  const meta = CHANNEL_META[slug];
  if (!meta) return;
  currentSlug = slug;

  if (shouldPush) {
    navigateTo(meta.path);
    return;
  }

  document.querySelectorAll('.contact-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.slug === slug);
  });

  headerAvatar.textContent = meta.emoji;
  headerAvatar.style.background = meta.color;
  headerTitleText.textContent = meta.name;

  socket.emit('join_room', slug);
}

document.querySelectorAll('a[data-slug]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(CHANNEL_META[link.dataset.slug].path);
  });
});

document.getElementById('mobileBackBtn').addEventListener('click', (e) => {
  e.preventDefault();
  navigateTo('/');
});

window.addEventListener('popstate', syncRouteFromURL);

searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase();
  document.querySelectorAll('.contact-row').forEach((row) => {
    const name = row.querySelector('.contact-name').textContent.toLowerCase();
    row.style.display = name.includes(q) ? 'flex' : 'none';
  });
});

// =========================================================
// MESSAGE RENDERING:
// - All App messages = Red
// - All Discord messages = Purple
// =========================================================
function appendMessage(msg, isLastMine = false) {
  const isDiscord = msg.source === 'discord';
  const isMine = !isDiscord && currentUser && msg.sender === currentUser.username;

  const group = document.createElement('div');
  group.className = `msg-group ${isMine ? 'outgoing' : 'incoming'} ${
    isDiscord ? 'from-discord' : 'from-app'
  }`;

  const renderBubbleContent = (bubbleEl) => {
    if (msg.text) {
      const textDiv = document.createElement('div');
      textDiv.innerHTML = formatRichText(msg.text);
      bubbleEl.appendChild(textDiv);
    }

    (msg.attachments || []).forEach((att) => {
      if (att.isImage) {
        const img = document.createElement('img');
        img.src = att.url;
        img.alt = att.name || 'image';
        img.className = 'bubble-media';
        bubbleEl.appendChild(img);
      } else if (att.isVideo) {
        const vid = document.createElement('video');
        vid.src = att.url;
        vid.controls = true;
        vid.className = 'bubble-media';
        bubbleEl.appendChild(vid);
      } else {
        const a = document.createElement('a');
        a.href = att.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'file-link-card';
        a.textContent = `⬇ ${att.name || 'Download File'} (3h link)`;
        bubbleEl.appendChild(a);
      }
    });
  };

  if (!isMine) {
    const label = document.createElement('div');
    label.className = 'sender-label';
    const displayLabel = msg.firstName && !isDiscord ? `${msg.sender} (${msg.firstName})` : msg.sender;
    label.innerHTML = `
      <span>${escapeHtml(displayLabel)}</span>
      <span class="source-badge ${isDiscord ? 'discord' : 'app'}">${isDiscord ? 'Discord' : 'App'}</span>
    `;
    group.appendChild(label);

    const inner = document.createElement('div');
    inner.className = 'incoming-row-inner';

    const av = document.createElement('div');
    av.className = 'sender-mini-avatar';
    av.style.background = isDiscord ? '#5865F2' : '#8B1E1E';
    if (msg.avatar) {
      av.innerHTML = `<img src="${escapeHtml(msg.avatar)}" alt="" />`;
    } else {
      av.textContent = (msg.sender || '?')[0].toUpperCase();
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    renderBubbleContent(bubble);

    inner.appendChild(av);
    inner.appendChild(bubble);
    group.appendChild(inner);
  } else {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    renderBubbleContent(bubble);
    group.appendChild(bubble);

    if (isLastMine) {
      const receipt = document.createElement('div');
      receipt.className = 'receipt-status';
      receipt.textContent = 'Delivered';
      group.appendChild(receipt);
    }
  }

  messagesList.appendChild(group);
  messagesScroll.scrollTop = messagesScroll.scrollHeight;
}

function updatePreview(msg) {
  const prevEl = document.getElementById(`preview-${msg.room}`);
  const timeEl = document.getElementById(`time-${msg.room}`);
  if (prevEl) {
    const previewText = msg.text || (msg.attachments?.[0]?.name ? `[${msg.attachments[0].name}]` : 'Media');
    prevEl.textContent = `${msg.sender}: ${previewText}`;
  }
  if (timeEl) {
    const t = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });
    timeEl.innerHTML = `${t} <span class="chevron">›</span>`;
  }
}

socket.on('init_state', ({ discordConnected, previews }) => {
  discordBridgeStatus.textContent = discordConnected ? '● Discord Connected' : '○ Internal Mode';
  Object.values(previews || {}).forEach((msg) => {
    if (msg) updatePreview(msg);
  });
});

socket.on('bridge_status', ({ connected }) => {
  discordBridgeStatus.textContent = connected ? '● Discord Connected' : '○ Internal Mode';
});

socket.on('auth_required', () => {
  authModal.classList.remove('hidden');
});

socket.on('history', ({ room, messages }) => {
  if (room !== currentSlug) return;
  messagesList.innerHTML = '';
  messages.forEach((m, idx) => {
    appendMessage(m, idx === messages.length - 1);
  });
  initialHistoryLoadedForRoom.add(room);
});

socket.on('chat_message', (msg) => {
  updatePreview(msg);
  if (msg.room === currentSlug) {
    document.querySelectorAll('.receipt-status').forEach((el) => el.remove());
    appendMessage(msg, true);
  }
  if (initialHistoryLoadedForRoom.has(msg.room)) {
    triggerMessageNotification(msg);
  }
});

socket.on('thread_preview', (msg) => {
  updatePreview(msg);
});

messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) {
    authModal.classList.remove('hidden');
    return;
  }

  await requestNotificationPermission();

  const text = messageInput.value.trim();
  if (!text) return;

  socket.emit('send_message', {
    room: currentSlug,
    text,
    attachments: [],
    authToken: currentUser.authToken,
    username: currentUser.username
  });

  messageInput.value = '';
  socket.emit('typing', {
    room: currentSlug,
    isTyping: false,
    authToken: currentUser.authToken,
    username: currentUser.username
  });
});

messageInput.addEventListener('input', () => {
  if (!currentUser) return;
  socket.emit('typing', {
    room: currentSlug,
    isTyping: true,
    authToken: currentUser.authToken,
    username: currentUser.username
  });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit('typing', {
      room: currentSlug,
      isTyping: false,
      authToken: currentUser.authToken,
      username: currentUser.username
    });
  }, 1500);
});

socket.on('user_typing', ({ room, sender, isTyping }) => {
  if (room === currentSlug && isTyping && sender !== currentUser?.username) {
    typingName.textContent = `${sender} is typing...`;
    typingRow.classList.remove('hidden');
    messagesScroll.scrollTop = messagesScroll.scrollHeight;
  } else {
    typingRow.classList.add('hidden');
  }
});

checkSession();
syncRouteFromURL();
