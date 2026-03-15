import { Router } from "express";
import { getDb } from "../db/runtime.js";
import { broadcast } from "../ws.js";
import { sendDiscordTarget, sendToAgentChannel, type BotType } from "../discord-announce.js";
import { listRoleBindings } from "../role-map.js";
import { appendAuditLog, getAuditActor } from "../audit-log.js";
import { processReviewVerdict, type ReviewVerdictItem } from "../kanban-cards.js";

const router = Router();

// --- Discord forwarding helper ---

/** Forward a CEO message to Discord channel(s) */
async function forwardToDiscord(
  db: ReturnType<typeof getDb>,
  receiverType: string,
  receiverId: string | null,
  content: string,
  discordTarget: string | null,
): Promise<void> {
  const prefix = "📢 **[CEO 메시지]**\n";
  const text = `${prefix}${content}`;

  if (receiverType === "agent" && receiverId) {
    // sendToAgentChannel handles dual-channel + fallback
    await sendToAgentChannel(receiverId, text, discordTarget);
  } else if (receiverType === "department" && receiverId) {
    const departmentAgents = db
      .prepare(
        `SELECT id
         FROM agents
         WHERE department_id = ?`,
      )
      .all(receiverId) as Array<{ id: string }>;

    for (const agent of departmentAgents) {
      await sendToAgentChannel(agent.id, text);
    }
  } else if (receiverType === "all") {
    const roleIdsWithBindings = new Set(
      listRoleBindings()
        .filter((binding) => Boolean(binding.channelId))
        .map((binding) => binding.roleId),
    );
    const agents = db
      .prepare(
        `SELECT id, role_id, discord_channel_id, discord_channel_id_alt, discord_channel_id_codex
         FROM agents`,
      )
      .all() as Array<{
      id: string;
      role_id: string | null;
      discord_channel_id: string | null;
      discord_channel_id_alt: string | null;
      discord_channel_id_codex: string | null;
    }>;

    for (const agent of agents) {
      const roleId = agent.role_id ?? "";
      const hasDbChannel =
        Boolean(agent.discord_channel_id) ||
        Boolean(agent.discord_channel_id_alt) ||
        Boolean(agent.discord_channel_id_codex);
      const hasRoleMapChannel = roleId.length > 0 && roleIdsWithBindings.has(roleId);
      if (!hasDbChannel && !hasRoleMapChannel) continue;
      await sendToAgentChannel(agent.id, text);
    }
  }
}

// --- Routes ---

// List messages (with optional filters)
router.get("/api/messages", (req, res) => {
  const db = getDb();
  const { receiverId, receiverType, limit: limitStr, before, messageType } = req.query;
  const limit = Math.min(parseInt(limitStr as string) || 50, 200);
  const receiverIdValue = typeof receiverId === "string" ? receiverId : null;
  const receiverTypeValue = typeof receiverType === "string" ? receiverType : null;
  const messageTypeValue = typeof messageType === "string" ? messageType : null;

  let sql = `
    SELECT m.*,
      a_sender.name AS sender_name,
      a_sender.name_ko AS sender_name_ko,
      a_sender.avatar_emoji AS sender_avatar,
      COALESCE(a_receiver.name, d_receiver.name) AS receiver_name,
      COALESCE(a_receiver.name_ko, d_receiver.name_ko) AS receiver_name_ko
    FROM messages m
    LEFT JOIN agents a_sender ON m.sender_type = 'agent' AND m.sender_id = a_sender.id
    LEFT JOIN agents a_receiver ON m.receiver_type = 'agent' AND m.receiver_id = a_receiver.id
    LEFT JOIN departments d_receiver ON m.receiver_type = 'department' AND m.receiver_id = d_receiver.id
  `;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (receiverTypeValue === "agent" && receiverIdValue) {
    conditions.push(`(
      (m.receiver_type = 'agent' AND m.receiver_id = ?) OR
      (m.receiver_type = 'all') OR
      (m.sender_type = 'agent' AND m.sender_id = ?)
    )`);
    params.push(receiverIdValue, receiverIdValue);
  } else if (receiverTypeValue === "department" && receiverIdValue) {
    conditions.push(`(
      (m.receiver_type = 'department' AND m.receiver_id = ?) OR
      (m.receiver_type = 'all') OR
      (m.sender_type = 'agent' AND m.sender_id IN (
        SELECT id FROM agents WHERE department_id = ?
      ))
    )`);
    params.push(receiverIdValue, receiverIdValue);
  } else if (receiverIdValue) {
    conditions.push(`(
      (m.receiver_type = 'agent' AND m.receiver_id = ?) OR
      (m.receiver_type = 'all') OR
      (m.sender_type = 'agent' AND m.sender_id = ?)
    )`);
    params.push(receiverIdValue, receiverIdValue);
  } else if (receiverTypeValue && receiverTypeValue !== "all") {
    conditions.push("m.receiver_type = ?");
    params.push(receiverTypeValue);
  }

  if (messageTypeValue && messageTypeValue !== "all") {
    conditions.push("m.message_type = ?");
    params.push(messageTypeValue);
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
    discord_target = null,
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
        a_sender.name AS sender_name,
        a_sender.name_ko AS sender_name_ko,
        a_sender.avatar_emoji AS sender_avatar,
        COALESCE(a_receiver.name, d_receiver.name) AS receiver_name,
        COALESCE(a_receiver.name_ko, d_receiver.name_ko) AS receiver_name_ko
       FROM messages m
       LEFT JOIN agents a_sender ON m.sender_type = 'agent' AND m.sender_id = a_sender.id
       LEFT JOIN agents a_receiver ON m.receiver_type = 'agent' AND m.receiver_id = a_receiver.id
       LEFT JOIN departments d_receiver ON m.receiver_type = 'department' AND m.receiver_id = d_receiver.id
       WHERE m.id = ?`,
    )
    .get(result.lastInsertRowid) as Record<string, unknown>;

  // Broadcast via WebSocket
  broadcast("new_message", msg);

  // Forward CEO messages to Discord (fire-and-forget)
  if (sender_type === "ceo") {
    const targetLabel =
        receiver_type === "all"
        ? "broadcast"
        : receiver_type === "department"
          ? `department:${receiver_id ?? "unknown"}`
          : `agent:${receiver_id ?? "unknown"}`;
    appendAuditLog({
      actor: getAuditActor(req),
      action: "message.sent",
      entityType: "message",
      entityId: String(result.lastInsertRowid),
      summary: `CEO message sent to ${targetLabel}`,
      metadata: {
        receiver_type,
        receiver_id,
        discord_target,
        message_type,
        content_preview: content.trim().slice(0, 160),
      },
    });
    forwardToDiscord(db, receiver_type, receiver_id, content.trim(), discord_target).catch((err) =>
      console.error("[PCD→Discord] forward error:", err),
    );
  }

  res.json(msg);
});

router.post("/api/discord/send-target", async (req, res) => {
  const { target, content, source = "pcd", bot = "command" } = req.body ?? {};

  if (!target || typeof target !== "string") {
    res.status(400).json({ error: "target required" });
    return;
  }
  if (!content || typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content required" });
    return;
  }

  const botType: BotType = bot === "notify" ? "notify" : "command";
  const ok = await sendDiscordTarget(target, content.trim(), botType);
  if (!ok) {
    res.status(502).json({ ok: false, error: "discord send failed", target });
    return;
  }

  console.log(`[PCD→Discord] send-target source=${source} target=${target} bot=${botType}`);

  // Intercept review verdict replies: [리뷰결과:{dispatch_id}] pass|improve — ...
  const verdictMatch = content.match(/\[리뷰결과:([0-9a-f-]{36})\]\s*(pass|improve)\b/i);
  if (verdictMatch) {
    const [, dispatchId, overall] = verdictMatch;
    const items: ReviewVerdictItem[] = [];
    if (overall === "improve") {
      // Extract bullet items after the verdict line
      const lines = content.split("\n").filter((l: string) => /^\s*[-\d.]/.test(l.trim()));
      lines.forEach((line: string, i: number) => {
        const text = line.replace(/^\s*[-\d.)\s]+/, "").trim();
        if (text) items.push({ id: `item-${i + 1}`, category: "improve" as const, summary: text });
      });
      if (items.length === 0) {
        items.push({ id: "item-1", category: "improve" as const, summary: "리뷰 에이전트가 개선 필요로 판단 (상세 내용은 채널 확인)" });
      }
    }
    try {
      const db = getDb();
      processReviewVerdict(db, dispatchId, { overall: overall as "pass" | "improve", items });
      console.log(`[review-verdict] Processed via send-target: dispatch=${dispatchId}, verdict=${overall}, items=${items.length}`);
    } catch (e) {
      console.error(`[review-verdict] Failed to process verdict for ${dispatchId}:`, (e as Error).message);
    }
  }

  res.json({ ok: true, target, source, bot: botType });
});

export default router;
