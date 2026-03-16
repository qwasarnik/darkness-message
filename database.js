const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs'); // заменили на bcryptjs

const dbPath = path.resolve(__dirname, 'darkness.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Пользователи с bio и avatar
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      bio TEXT,
      avatar TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Личные сообщения с полем read
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromUserId INTEGER NOT NULL,
      toUserId INTEGER NOT NULL,
      text TEXT,
      mediaUrl TEXT,
      type TEXT DEFAULT 'text',
      read INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(fromUserId) REFERENCES users(id),
      FOREIGN KEY(toUserId) REFERENCES users(id)
    )
  `);
  // Индекс для ускорения получения чатов
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(fromUserId, toUserId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);

  // Группы
  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      createdBy INTEGER NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(createdBy) REFERENCES users(id)
    )
  `);

  // Участники групп
  db.run(`
    CREATE TABLE IF NOT EXISTS group_members (
      groupId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (groupId, userId),
      FOREIGN KEY(groupId) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Сообщения групп
  db.run(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      groupId INTEGER NOT NULL,
      fromUserId INTEGER NOT NULL,
      text TEXT,
      mediaUrl TEXT,
      type TEXT DEFAULT 'text',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(groupId) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY(fromUserId) REFERENCES users(id)
    )
  `);
});

// ---------- Пользователи ----------
const createUser = (username, password, bio = '', avatar = '') => {
  return new Promise((resolve, reject) => {
    const hash = bcrypt.hashSync(password, 10);
    db.run(
      'INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, ?, ?)',
      [username, hash, bio, avatar],
      function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, username, bio, avatar });
      }
    );
  });
};

const findUserByUsername = (username) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const findUserById = (id) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, username, bio, avatar, createdAt FROM users WHERE id = ?', [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const searchUsers = (query, excludeUserId) => {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, username, bio, avatar FROM users WHERE username LIKE ? AND id != ? LIMIT 20',
      [`%${query}%`, excludeUserId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

const updateUserProfile = (userId, { bio, avatar }) => {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET bio = COALESCE(?, bio), avatar = COALESCE(?, avatar) WHERE id = ?',
      [bio, avatar, userId],
      function(err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
};

// ---------- Личные сообщения ----------
const saveMessage = (fromUserId, toUserId, text, mediaUrl, type) => {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO messages (fromUserId, toUserId, text, mediaUrl, type, read) VALUES (?, ?, ?, ?, ?, 0)',
      [fromUserId, toUserId, text, mediaUrl, type],
      function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, fromUserId, toUserId, text, mediaUrl, type, read: 0, timestamp: new Date() });
      }
    );
  });
};

const getMessagesBetweenUsers = (user1Id, user2Id) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM messages 
       WHERE (fromUserId = ? AND toUserId = ?) OR (fromUserId = ? AND toUserId = ?)
       ORDER BY timestamp ASC`,
      [user1Id, user2Id, user2Id, user1Id],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

// Получить список чатов (личных диалогов) пользователя
const getChats = (userId) => {
  return new Promise((resolve, reject) => {
    // Находим всех собеседников, с которыми есть переписка
    db.all(
      `SELECT DISTINCT 
         CASE WHEN fromUserId = ? THEN toUserId ELSE fromUserId END AS otherUserId
       FROM messages 
       WHERE fromUserId = ? OR toUserId = ?`,
      [userId, userId, userId],
      (err, rows) => {
        if (err) return reject(err);
        const otherUserIds = rows.map(r => r.otherUserId);
        if (otherUserIds.length === 0) return resolve([]);

        // Для каждого собеседника получим последнее сообщение и количество непрочитанных
        const promises = otherUserIds.map(otherId => {
          return Promise.all([
            // последнее сообщение
            new Promise((res, rej) => {
              db.get(
                `SELECT * FROM messages 
                 WHERE (fromUserId = ? AND toUserId = ?) OR (fromUserId = ? AND toUserId = ?)
                 ORDER BY timestamp DESC LIMIT 1`,
                [userId, otherId, otherId, userId],
                (err, msg) => {
                  if (err) rej(err);
                  else res(msg);
                }
              );
            }),
            // количество непрочитанных сообщений от этого собеседника к userId
            new Promise((res, rej) => {
              db.get(
                `SELECT COUNT(*) as cnt FROM messages 
                 WHERE fromUserId = ? AND toUserId = ? AND read = 0`,
                [otherId, userId],
                (err, row) => {
                  if (err) rej(err);
                  else res(row ? row.cnt : 0);
                }
              );
            }),
            // информация о собеседнике
            findUserById(otherId)
          ]);
        });

        Promise.all(promises)
          .then(results => {
            const chats = results.map(([lastMsg, unreadCount, otherUser]) => ({
              userId: otherUser.id,
              username: otherUser.username,
              avatar: otherUser.avatar,
              lastMessage: lastMsg ? (lastMsg.text || (lastMsg.mediaUrl ? (lastMsg.type === 'image' ? '📷 Фото' : lastMsg.type === 'video' ? '🎥 Видео' : '📹 Кружок') : '')) : '',
              lastMessageTime: lastMsg ? lastMsg.timestamp : null,
              unreadCount
            }));
            // сортировка по времени последнего сообщения (сначала новые)
            chats.sort((a, b) => (a.lastMessageTime > b.lastMessageTime ? -1 : 1));
            resolve(chats);
          })
          .catch(reject);
      }
    );
  });
};

// Пометить все сообщения от fromUserId к toUserId как прочитанные
const markMessagesAsRead = (fromUserId, toUserId) => {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE messages SET read = 1 WHERE fromUserId = ? AND toUserId = ? AND read = 0',
      [fromUserId, toUserId],
      function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      }
    );
  });
};

// ---------- Группы ----------
const createGroup = (name, createdBy, memberIds) => {
  return new Promise(async (resolve, reject) => {
    try {
      await new Promise((res, rej) => {
        db.run('BEGIN TRANSACTION', (err) => (err ? rej(err) : res()));
      });

      const groupResult = await new Promise((res, rej) => {
        db.run('INSERT INTO groups (name, createdBy) VALUES (?, ?)', [name, createdBy], function(err) {
          if (err) rej(err);
          else res({ id: this.lastID });
        });
      });

      const groupId = groupResult.id;
      const allMembers = [createdBy, ...memberIds.filter(id => id !== createdBy)];
      for (const userId of allMembers) {
        await new Promise((res, rej) => {
          db.run('INSERT INTO group_members (groupId, userId) VALUES (?, ?)', [groupId, userId], (err) => {
            if (err) rej(err);
            else res();
          });
        });
      }

      await new Promise((res, rej) => db.run('COMMIT', (err) => (err ? rej(err) : res())));
      resolve({ id: groupId, name, createdBy });
    } catch (err) {
      await new Promise((res) => db.run('ROLLBACK', () => res()));
      reject(err);
    }
  });
};

const getUserGroups = (userId) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT g.* FROM groups g
       JOIN group_members gm ON g.id = gm.groupId
       WHERE gm.userId = ?
       ORDER BY g.createdAt DESC`,
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

const getGroupMembers = (groupId) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT u.id, u.username, u.avatar FROM users u
       JOIN group_members gm ON u.id = gm.userId
       WHERE gm.groupId = ?`,
      [groupId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

const addGroupMembers = (groupId, userIds) => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      const stmt = db.prepare('INSERT OR IGNORE INTO group_members (groupId, userId) VALUES (?, ?)');
      for (const uid of userIds) {
        stmt.run(groupId, uid);
      }
      stmt.finalize();
      db.run('COMMIT', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
};

const saveGroupMessage = (groupId, fromUserId, text, mediaUrl, type) => {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO group_messages (groupId, fromUserId, text, mediaUrl, type) VALUES (?, ?, ?, ?, ?)',
      [groupId, fromUserId, text, mediaUrl, type],
      function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, groupId, fromUserId, text, mediaUrl, type, timestamp: new Date() });
      }
    );
  });
};

const getGroupMessages = (groupId) => {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM group_messages WHERE groupId = ? ORDER BY timestamp ASC',
      [groupId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

module.exports = {
  createUser,
  findUserByUsername,
  findUserById,
  searchUsers,
  updateUserProfile,
  saveMessage,
  getMessagesBetweenUsers,
  getChats,
  markMessagesAsRead,
  createGroup,
  getUserGroups,
  getGroupMembers,
  addGroupMembers,
  saveGroupMessage,
  getGroupMessages
};