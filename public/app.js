const socket = io();

const CHANNEL_META = {
  supervised: {
    slug: 'supervised',
    path: '/supervised',
    name: '#supervised',
    emoji: '🛡️',
    color: '#D8F3DC'
  },
  unsupervised: {
    slug: 'unsupervised',
    path: '/unsupervised',
    name: '#unsupervised',
    emoji: '🚀',
    color: '#FFE5D9'
  },
  fs: {
    slug: 'fs',
    path: '/fs',
    name: '#free-speech',
    emoji: '🗽',
    color: '#E0AAFF'
  }
};

let currentSlug = 'supervised';
let username = localStorage.getItem('imessage_username') || '';
let typingTimer = null;

// DOM Elements
const appShell = document.getElementById('appShell');
const messagesList = document.getElementById('messagesList');
const messagesScroll = document.getElementById('messagesScroll');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const headerAvatar = document.getElementById('headerAvatar');
const headerTitleText = document.getElementById('headerTitleText');
const userLabel = document.getElementById('userLabel');
const discordBridgePill = document.getElementById('discordBridgePill');
const typingRow = document.getElementById('typingRow');
const typingName = document.getElementById('typingName');
const searchInput = document.getElementById('searchInput');

// Modal Elements
const nameModal = document.getElementById('nameModal');
const nameInput = document.getElementById('nameInput');
const saveNameBtn = document.getElementById('saveNameBtn');
const cancelNameBtn = document.getElementById('cancelNameBtn');

function openNameModal() {
  nameInput.value = username;
  nameModal.classList.remove('hidden');
  nameInput.focus();
}

saveNameBtn.addEventListener('click', () => {
  const clean = nameInput.value.trim();
  if (clean) {
    username = clean;
    localStorage.setItem('imessage_username', username);
    updateUserUI();
    nameModal.classList.add('hidden');
  }
});

cancelNameBtn.addEventListener('click', () => {
  if (!username) {
    username = 'User' + Math.floor(100 + Math.random() * 900);
    localStorage.setItem('imessage_username', username);
    updateUserUI();
  }
  nameModal.classList.add('hidden');
});

[
  'editNameDesktopBtn',
  'editNameMobileBtn',
  'composeMobileBtn',
  'desktopNameBtn',
  'plusBtn'
].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', openNameModal);
});

function updateUserUI() {
  userLabel.innerHTML = `You: <strong>${escapeHtml(username || 'Guest')}</strong>`;
}

// Determine active channel & mobile view mode from URL pathname
function syncRouteFromURL() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';

  if (path === '/') {
    // On mobile, '/' shows Mobile2.jpeg (Messages Inbox).
    // On desktop, '/' defaults to opening #supervised in the split view.
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

function selectChannel(slug, shouldPushUrl = true) {
  const meta = CHANNEL_META[slug];
  if (!meta) return;

  currentSlug = slug;

  if (shouldPushUrl) {
    navigateTo(meta.path);
    return;
  }

  // Highlight active row in sidebar
  document.querySelectorAll('.contact-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.slug === slug);
  });

  // Update floating header
  headerAvatar.textContent = meta.emoji;
  headerAvatar.style.background = meta.color;
  headerTitleText.textContent = meta.name;

  // Join room and fetch message history
  socket.emit('join_room', slug);
}

// Intercept clicks on contact rows, pinned circles, and mobile back button
document.querySelectorAll('a[data-slug]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const slug = link.dataset.slug;
    navigateTo(CHANNEL_META[slug].path);
  });
});

document.getElementById('mobileBackBtn').addEventListener('click', (e) => {
  e.preventDefault();
  navigateTo('/');
});

window.addEventListener('popstate', syncRouteFromURL);

// Search filter for contacts
searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase();
  document.querySelectorAll('.contact-row').forEach((row) => {
    const name = row.querySelector('.contact-name').textContent.toLowerCase();
    row.style.display = name.includes(q) ? 'flex' : 'none';
  });
});

// Render a message bubble (Apple iMessage Desktop & Mobile1 style)
function appendMessage(msg, isLastMine = false) {
  const isMine = msg.source === 'web' && msg.sender === username;
  const group = document.createElement('div');
  group.className = `msg-group ${isMine ? 'outgoing' : 'incoming'}`;

  if (!isMine) {
    // Sender name above bubble (matches Mobile1.jpeg group chat style)
    const label = document.createElement('div');
    label.className = 'sender-label';
    label.innerHTML = `
      <span>${escapeHtml(msg.sender)}</span>
      ${msg.source === 'discord' ? '<span class="discord-mini-badge">Discord</span>' : ''}
    `;
    group.appendChild(label);

    const inner = document.createElement('div');
    inner.className = 'incoming-row-inner';

    // Circular sender avatar on bottom-left of bubble
    const av = document.createElement('div');
    av.className = 'sender-mini-avatar';
    if (msg.avatar) {
      av.innerHTML = `<img src="${msg.avatar}" alt="" />`;
    } else {
      av.textContent = (msg.sender || '?')[0].toUpperCase();
      av.style.background = msg.source === 'discord' ? '#5865F2' : '#8E8E93';
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.text;

    if (msg.attachments && msg.attachments.length) {
      msg.attachments.forEach((url) => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'bubble-image';
        bubble.appendChild(img);
      });
    }

    inner.appendChild(av);
    inner.appendChild(bubble);
    group.appendChild(inner);
  } else {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.text;
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
    prevEl.textContent = `${msg.sender}: ${msg.text}`;
  }
  if (timeEl) {
    const t = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });
    timeEl.innerHTML = `${t} <span class="chevron">›</span>`;
  }
}

// Socket.IO Event Handlers
socket.on('init_state', ({ discordConnected, previews }) => {
  discordBridgePill.textContent = discordConnected
    ? '● Discord Connected'
    : '○ Internal Server Mode';

  Object.values(previews || {}).forEach((msg) => {
    if (msg) updatePreview(msg);
  });
});

socket.on('bridge_status', ({ connected }) => {
  discordBridgePill.textContent = connected
    ? '● Discord Connected'
    : '○ Internal Server Mode';
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

// Send Message
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  if (!username) {
    openNameModal();
    return;
  }

  socket.emit('send_message', {
    room: currentSlug,
    sender: username,
    text
  });

  messageInput.value = '';
  socket.emit('typing', { room: currentSlug, sender: username, isTyping: false });
});

// Typing events
messageInput.addEventListener('input', () => {
  socket.emit('typing', { room: currentSlug, sender: username, isTyping: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit('typing', { room: currentSlug, sender: username, isTyping: false });
  }, 1500);
});

socket.on('user_typing', ({ room, sender, isTyping }) => {
  if (room === currentSlug && isTyping && sender !== username) {
    typingName.textContent = `${sender} is typing...`;
    typingRow.classList.remove('hidden');
    messagesScroll.scrollTop = messagesScroll.scrollHeight;
  } else {
    typingRow.classList.add('hidden');
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Initialize
if (!username) {
  openNameModal();
} else {
  updateUserUI();
}
syncRouteFromURL();
