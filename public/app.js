const socket = io();

const CHANNEL_META = {
  supervised: { slug: 'supervised', path: '/supervised', name: '#supervised', emoji: '🛡️', color: '#D8F3DC' },
  unsupervised: { slug: 'unsupervised', path: '/unsupervised', name: '#unsupervised', emoji: '🚀', color: '#FFE5D9' },
  fs: { slug: 'fs', path: '/fs', name: '#free-speech', emoji: '🗽', color: '#E0AAFF' }
};

let currentUser = null;
let currentSlug = 'supervised';
let authMode = 'signin';
let uploadedAvatarDataUrl = null;
let typingTimer = null;

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
const tabSignIn = document.getElementById('tabSignIn');
const tabSignUp = document.getElementById('tabSignUp');
const signUpFields = document.getElementById('signUpFields');
const authSubtitle = document.getElementById('authSubtitle');
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
// MARKDOWN FORMATTING (Bold, Italic, Bold-Italic)
// =========================================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

function formatRichText(raw) {
  let out = escapeHtml(raw);
  // Bold + Italic: ***text***
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold: **text**
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic: *text* or _text_
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\b_(.+?)_\b/g, '<em>$1</em>');
  return out;
}

// =========================================================
// AUTH & TRUSTED DEVICES
// =========================================================
function setAuthMode(mode) {
  authMode = mode;
  authError.classList.add('hidden');
  authError.textContent = '';

  if (mode === 'signup') {
    tabSignUp.classList.add('active');
    tabSignIn.classList.remove('active');
    signUpFields.classList.remove('hidden');
    authSubmitBtn.textContent = 'Create Account';
    authSubtitle.innerHTML =
      'Register your username, first name, and password. Your device stays remembered.';
  } else {
    tabSignIn.classList.add('active');
    tabSignUp.classList.remove('active');
    signUpFields.classList.add('hidden');
    authSubmitBtn.textContent = 'Sign In';
    authSubtitle.innerHTML =
      'Sign in to chat as <strong>[USERNAME] ([FIRST-NAME])</strong> and stay logged in on this device.';
  }
}

tabSignIn.addEventListener('click', () => setAuthMode('signin'));
tabSignUp.addEventListener('click', () => setAuthMode('signup'));

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: dev.deviceId })
      });
      const data = await res.json();
      if (res.status === 401 || !data.user) {
        currentUser = null;
        updateUserUI();
        authModal.classList.remove('hidden');
      } else {
        currentUser = data.user;
        renderDevicesList();
      }
    });
    devicesList.appendChild(row);
  });
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.add('hidden');

  const endpoint = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/signin';
  const body =
    authMode === 'signup'
      ? {
          firstName: firstNameInput.value.trim(),
          username: usernameInput.value.trim(),
          password: passwordInput.value,
          avatarUrl: uploadedAvatarDataUrl
        }
      : {
          username: usernameInput.value.trim(),
          password: passwordInput.value
        };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      authError.textContent = data.error || 'Authentication failed.';
      authError.classList.remove('hidden');
      return;
    }

    currentUser = data.user;
    updateUserUI();
    renderDevicesList();
    authModal.classList.add('hidden');
    passwordInput.value = '';
  } catch {
    authError.textContent = 'Network error connecting to server.';
    authError.classList.remove('hidden');
  }
});

signOutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/signout', { method: 'POST' });
  currentUser = null;
  updateUserUI();
  renderDevicesList();
  setAuthMode('signin');
  authModal.classList.remove('hidden');
});

function updateUserUI() {
  if (currentUser) {
    footerUserText.textContent = `${currentUser.username} (${currentUser.firstName})`;
    signOutBtn.classList.remove('hidden');
    if (currentUser.avatarUrl) {
      footerAvatar.innerHTML = `<img src="${currentUser.avatarUrl}" alt="" />`;
    } else {
      footerAvatar.textContent = currentUser.firstName[0].toUpperCase();
    }
  } else {
    footerUserText.textContent = 'Not signed in';
    footerAvatar.textContent = '?';
    signOutBtn.classList.add('hidden');
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
  const res = await fetch('/api/auth/me');
  const data = await res.json();
  currentUser = data.user;
  updateUserUI();
  renderDevicesList();
  if (!currentUser) {
    authModal.classList.remove('hidden');
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
    ]
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
        ]
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
// - Outgoing (You) = Dark Red
// - Other App Users = Black
// - Discord = Purple
// =========================================================
function appendMessage(msg, isLastMine = false) {
  const isDiscord = msg.source === 'discord';
  const isMine = !isDiscord && currentUser && msg.sender === currentUser.username;

  let colorClass = 'from-app-other';
  if (isDiscord) colorClass = 'from-discord';
  else if (isMine) colorClass = 'from-me';

  const group = document.createElement('div');
  group.className = `msg-group ${isMine ? 'outgoing' : 'incoming'} ${colorClass}`;

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
    av.style.background = isDiscord ? '#5865F2' : '#141417';
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
});

socket.on('chat_message', (msg) => {
  updatePreview(msg);
  if (msg.room === currentSlug) {
    document.querySelectorAll('.receipt-status').forEach((el) => el.remove());
    appendMessage(msg, true);
  }
});

socket.on('thread_preview', (msg) => {
  updatePreview(msg);
});

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentUser) {
    authModal.classList.remove('hidden');
    return;
  }

  const text = messageInput.value.trim();
  if (!text) return;

  socket.emit('send_message', {
    room: currentSlug,
    text,
    attachments: []
  });

  messageInput.value = '';
  socket.emit('typing', { room: currentSlug, isTyping: false });
});

messageInput.addEventListener('input', () => {
  if (!currentUser) return;
  socket.emit('typing', { room: currentSlug, isTyping: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit('typing', { room: currentSlug, isTyping: false });
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
