const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt'); // если используешь bcrypt, или bcryptjs
require('dotenv').config();

const db = require('./database');
const { authenticateToken, JWT_SECRET } = require('./authMiddleware');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ========== Роуты ==========

// Регистрация
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const existingUser = await db.findUserByUsername(username);
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    const user = await db.createUser(username, password);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, bio: user.bio, avatar: user.avatar } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await db.findUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, bio: user.bio, avatar: user.avatar } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Получить профиль текущего пользователя
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const user = await db.findUserById(req.user.id);
    res.json({ id: user.id, username: user.username, bio: user.bio, avatar: user.avatar });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Обновить профиль (bio, avatar)
app.post('/api/profile', authenticateToken, async (req, res) => {
  const { bio, avatar } = req.body;
  try {
    await db.updateUserProfile(req.user.id, { bio, avatar });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Поиск пользователей
app.get('/api/users', authenticateToken, async (req, res) => {
  const search = req.query.search || '';
  try {
    const users = await db.searchUsers(search, req.user.id);
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Получить личные сообщения с пользователем
app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
  const otherUserId = parseInt(req.params.userId);
  try {
    const messages = await db.getMessagesBetweenUsers(req.user.id, otherUserId);
    // Обогатим сообщения информацией об отправителе
    const enriched = await Promise.all(messages.map(async (msg) => {
      const sender = await db.findUserById(msg.fromUserId);
      return {
        ...msg,
        fromUser: sender ? { id: sender.id, username: sender.username, avatar: sender.avatar } : null
      };
    }));
    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Получить список чатов (личных диалогов)
app.get('/api/chats', authenticateToken, async (req, res) => {
  try {
    const chats = await db.getChats(req.user.id);
    res.json(chats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Отметить сообщения с пользователем как прочитанные
app.post('/api/messages/:chatUserId/read', authenticateToken, async (req, res) => {
  const chatUserId = parseInt(req.params.chatUserId);
  try {
    await db.markMessagesAsRead(req.user.id, chatUserId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Загрузка файлов
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

// ========== Роуты групп ==========
app.post('/api/groups', authenticateToken, async (req, res) => {
  const { name, members } = req.body;
  if (!name || !members || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'Group name and members array required' });
  }
  try {
    const group = await db.createGroup(name, req.user.id, members);
    res.json(group);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

app.get('/api/groups', authenticateToken, async (req, res) => {
  try {
    const groups = await db.getUserGroups(req.user.id);
    res.json(groups);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get groups' });
  }
});

app.get('/api/groups/:groupId', authenticateToken, async (req, res) => {
  const groupId = parseInt(req.params.groupId);
  try {
    const members = await db.getGroupMembers(groupId);
    res.json({ groupId, members });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get group info' });
  }
});

app.post('/api/groups/:groupId/members', authenticateToken, async (req, res) => {
  const groupId = parseInt(req.params.groupId);
  const { members } = req.body;
  if (!members || !Array.isArray(members)) {
    return res.status(400).json({ error: 'Members array required' });
  }
  try {
    await db.addGroupMembers(groupId, members);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

app.get('/api/groups/:groupId/messages', authenticateToken, async (req, res) => {
  const groupId = parseInt(req.params.groupId);
  try {
    const messages = await db.getGroupMessages(groupId);
    const enriched = await Promise.all(messages.map(async (msg) => {
      const sender = await db.findUserById(msg.fromUserId);
      return {
        ...msg,
        fromUser: sender ? { id: sender.id, username: sender.username, avatar: sender.avatar } : null
      };
    }));
    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get group messages' });
  }
});

// ========== Socket.IO ==========
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Authentication error'));
    socket.user = user;
    next();
  });
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.user.username} (${socket.user.id})`);
  socket.join(`user_${socket.user.id}`);

  socket.on('private message', async ({ to, text, mediaUrl, type }) => {
    try {
      const msg = await db.saveMessage(socket.user.id, to, text || '', mediaUrl || null, type || 'text');
      const sender = await db.findUserById(socket.user.id);
      const enrichedMsg = {
        id: msg.id,
        from: socket.user.id,
        fromUser: { id: sender.id, username: sender.username, avatar: sender.avatar },
        to,
        text: msg.text,
        mediaUrl: msg.mediaUrl,
        type: msg.type,
        timestamp: msg.timestamp
      };
      io.to(`user_${to}`).emit('private message', enrichedMsg);
      socket.emit('private message', enrichedMsg);
    } catch (err) {
      console.error(err);
      socket.emit('error', 'Failed to send private message');
    }
  });

  socket.on('group message', async ({ groupId, text, mediaUrl, type }) => {
    try {
      const members = await db.getGroupMembers(groupId);
      const isMember = members.some(m => m.id === socket.user.id);
      if (!isMember) {
        socket.emit('error', 'You are not a member of this group');
        return;
      }

      const msg = await db.saveGroupMessage(groupId, socket.user.id, text || '', mediaUrl || null, type || 'text');
      const sender = await db.findUserById(socket.user.id);
      const enrichedMsg = {
        ...msg,
        fromUser: { id: sender.id, username: sender.username, avatar: sender.avatar }
      };

      members.forEach(member => {
        io.to(`user_${member.id}`).emit('group message', enrichedMsg);
      });
    } catch (err) {
      console.error(err);
      socket.emit('error', 'Failed to send group message');
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.user.username}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});