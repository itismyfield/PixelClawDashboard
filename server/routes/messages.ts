import { Router } from "express";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";

const router = Router();

// List messages (with optional filters)
router.get("/api/messages", (req, res) => {
  const db = getDb();
  const { receiverId, receiverType, limit: limitStr, before } = req.query;
  const limit = Math.min(parseInt(limitStr as string) || 50, 200);

  let sql = `
    SELECT m.*,
      a_sender.name AS sender_name,
      a_sender.name_ko AS sender_name_ko,
      a_sender.avatar_emoji AS sender_avatar
    FROM messages m
    LEFT JOIN agents a_sender ON m.sender_type = 'agent' AND m.sender_id = a_sender.id
  `;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (receiverId) {
    // Messages TO this agent OR broadcast to all/department
    conditions.push(`(
      (m.receiver_type = 'agent' AND m.receiver_id = ?) OR
      (m.receiver_type = 'all') OR
      (m.sender_type = 'agent' AND m.sender_id = ?)
    )`);
    params.push(receiverId, receiverId);
  }
  if (receiverType && receiverType !== "all") {
    conditions.push("m.receiver_type = ?");
    params.push(receiverType);
  }
  if (before) {
    conditions.push("m.created_at < ?");
    params.push(parseInt(before as string));
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY m.created_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...(params as Array<string | number | null>));
  res.json({ messages: (rows as Array<Record<string, unknown>>).reverse() });
});

// Send a message
router.post("/api/messages", (req, res) => {
  const db = getDb();
  const {
    sender_type = "ceo",
    sender_id = null,
    receiver_type = "agent",
    receiver_id = null,
    content,
    message_type = "chat",
  } = req.body;

  if (!content || !content.trim()) {
    res.status(400).json({ error: "content required" });
    return;
  }

  const result = db
    .prepare(
      `INSERT INTO messages (sender_type, sender_id, receiver_type, receiver_id, content, message_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sender_type, sender_id, receiver_type, receiver_id, content.trim(), message_type);

  const msg = db
    .prepare(
      `SELECT m.*,
        a.name AS sender_name, a.name_ko AS sender_name_ko, a.avatar_emoji AS sender_avatar
       FROM messages m
       LEFT JOIN agents a ON m.sender_type = 'agent' AND m.sender_id = a.id
       WHERE m.id = ?`,
    )
    .get(result.lastInsertRowid) as Record<string, unknown>;

  // Broadcast via WebSocket
  broadcast("new_message", msg);

  res.json(msg);
});

export default router;
