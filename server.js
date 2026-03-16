// Получить список чатов (личных диалогов)
app.get('/api/chats', authenticateToken, async (req, res) => {
  try {
    const chats = await db.getChats(req.user.id);
    // Обогатим информацией о пользователях (уже есть в getChats)
    res.json(chats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get chats' });
  }
});

// Отметить сообщения от конкретного пользователя как прочитанные
app.post('/api/messages/read', authenticateToken, async (req, res) => {
  const { fromUserId } = req.body;
  if (!fromUserId) return res.status(400).json({ error: 'fromUserId required' });
  try {
    await db.markMessagesAsRead(fromUserId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});