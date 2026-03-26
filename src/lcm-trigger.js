import path from 'node:path';
import { execFileSync } from 'node:child_process';

function resolveLcmDbPath(config = {}) {
  const explicit = typeof config?.behavior?.lcmDbPath === 'string' ? config.behavior.lcmDbPath.trim() : '';
  if (explicit) return explicit;
  return path.join(process.env.HOME || '', '.openclaw', 'lcm.db');
}

function querySqliteJson(dbPath, sql) {
  const raw = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' });
  const text = raw.trim();
  return text ? JSON.parse(text) : [];
}

function toSqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function readMessageTextPart(row) {
  return [row?.text_content, row?.text, row?.content, row?.message, row?.output_text, row?.tool_output]
    .find((value) => typeof value === 'string' && value.trim()) || '';
}

export function createLcmInspector(config = {}) {
  const dbPath = resolveLcmDbPath(config);

  function getLatestSummaryWatermark(conversationId = null) {
    const where = conversationId === null || conversationId === undefined
      ? ''
      : `WHERE conversation_id = ${Number(conversationId)}`;
    const rows = querySqliteJson(dbPath, `
      SELECT summary_id, created_at
      FROM summaries
      ${where}
      ORDER BY datetime(created_at) DESC, summary_id DESC
      LIMIT 1
    `);
    const row = Array.isArray(rows) ? rows[0] : null;
    return {
      latestCreatedAt: row?.summary_id ? (row?.created_at ?? null) : null,
      latestSummaryId: row?.summary_id ?? null,
    };
  }

  function listConversationProgress() {
    const rows = querySqliteJson(dbPath, `
      SELECT c.conversation_id AS conversationId,
             c.session_id AS sessionId,
             COALESCE(MAX(m.seq), 0) AS maxSeq
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.conversation_id
      GROUP BY c.conversation_id, c.session_id
    `);
    return Array.isArray(rows) ? rows : [];
  }

  function computeMessageDelta(previousWatermark = {}) {
    const rows = listConversationProgress();
    const nextWatermark = {};
    let newMessages = 0;
    for (const row of rows) {
      const conversationId = String(row.conversationId);
      const maxSeq = Number(row.maxSeq || 0);
      nextWatermark[conversationId] = maxSeq;
      const prev = Number(previousWatermark?.[conversationId] || 0);
      if (maxSeq > prev) newMessages += (maxSeq - prev);
    }
    return { newMessages, nextWatermark, conversations: rows };
  }

  function getConversationMessageProgress(conversationId) {
    if (conversationId === null || conversationId === undefined) {
      return { conversationId: null, maxSeq: 0 };
    }
    const rows = querySqliteJson(dbPath, `
      SELECT conversation_id AS conversationId,
             COALESCE(MAX(seq), 0) AS maxSeq
      FROM messages
      WHERE conversation_id = ${Number(conversationId)}
      GROUP BY conversation_id
      LIMIT 1
    `);
    return Array.isArray(rows) && rows.length > 0
      ? rows[0]
      : { conversationId: Number(conversationId), maxSeq: 0 };
  }

  function computeConversationMessageDelta(conversationId, previousWatermark = {}) {
    if (conversationId === null || conversationId === undefined) {
      return {
        newMessages: 0,
        nextWatermark: {},
        conversation: null,
      };
    }
    const row = getConversationMessageProgress(conversationId);
    const key = String(conversationId);
    const maxSeq = Number(row?.maxSeq || 0);
    const prev = Number(previousWatermark?.[key] || 0);
    return {
      newMessages: maxSeq > prev ? (maxSeq - prev) : 0,
      nextWatermark: { [key]: maxSeq },
      conversation: row,
    };
  }

  function hasSummaryAdvanced(previousWatermark = {}, conversationId = null) {
    const latest = getLatestSummaryWatermark(conversationId);
    const prevCreatedAt = previousWatermark?.latestCreatedAt ?? null;
    const prevSummaryId = previousWatermark?.latestSummaryId ?? null;
    const advanced =
      !latest.latestSummaryId
        ? false
        : latest.latestCreatedAt !== prevCreatedAt || latest.latestSummaryId !== prevSummaryId;
    return { advanced, latest };
  }

  function getRecentSummariesSince(previousWatermark = {}, limit = 8, conversationId = null) {
    const prevCreatedAt = previousWatermark?.latestCreatedAt ?? null;
    const prevSummaryId = previousWatermark?.latestSummaryId ?? null;
    const clauses = [];
    if (conversationId !== null && conversationId !== undefined) {
      clauses.push(`conversation_id = ${Number(conversationId)}`);
    }
    if (prevCreatedAt) {
      clauses.push(`(datetime(created_at) > datetime(${toSqlString(prevCreatedAt)}) OR (created_at = ${toSqlString(prevCreatedAt)} AND summary_id > ${toSqlString(prevSummaryId || '')}))`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = querySqliteJson(dbPath, `
      SELECT summary_id AS summaryId,
             conversation_id AS conversationId,
             created_at AS createdAt,
             kind,
             depth,
             content
      FROM summaries
      ${where}
      ORDER BY datetime(created_at) DESC, summary_id DESC
      LIMIT ${Math.max(1, Number(limit || 8))}
    `);

    return (Array.isArray(rows) ? rows : []).reverse();
  }

  function getConversationForSession(sessionId) {
    if (!sessionId) return null;
    const rows = querySqliteJson(dbPath, `
      SELECT conversation_id AS conversationId,
             session_id AS sessionId,
             created_at AS createdAt
      FROM conversations
      WHERE session_id = ${toSqlString(sessionId)}
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  function mergeMessageRows(rows = []) {
    const merged = [];
    const seen = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const partType = String(row?.partType || 'text');
      if (partType !== 'text') continue;
      const seq = Number(row?.seq || 0);
      const key = `${seq}:${row?.role || 'assistant'}`;
      const text = readMessageTextPart(row).trim();
      if (!text) continue;
      if (!seen.has(key)) {
        seen.set(key, {
          role: row?.role || 'assistant',
          seq,
          createdAt: row?.createdAt || null,
          content: text,
        });
        merged.push(seen.get(key));
      } else {
        const current = seen.get(key);
        current.content = `${current.content} ${text}`.trim();
      }
    }
    return merged;
  }

  function getRecentMessagesForSession(sessionId, limit = 12) {
    if (!sessionId) return [];
    const rows = querySqliteJson(dbPath, `
      SELECT m.role,
             m.seq,
             m.created_at AS createdAt,
             mp.part_type AS partType,
             mp.text_content,
             mp.tool_output,
             mp.metadata
      FROM messages m
      LEFT JOIN message_parts mp ON mp.message_id = m.message_id
      WHERE m.session_id = ${toSqlString(sessionId)}
      ORDER BY m.seq DESC, mp.ordinal ASC
      LIMIT ${Math.max(1, Number(limit || 12) * 4)}
    `);

    return mergeMessageRows(rows).reverse().slice(-Math.abs(limit));
  }

  function getConversationMessagesSince(conversationId, previousSeq = 0, limit = 48) {
    if (conversationId === null || conversationId === undefined) return [];
    const rows = querySqliteJson(dbPath, `
      SELECT m.role,
             m.seq,
             m.created_at AS createdAt,
             mp.part_type AS partType,
             mp.text_content,
             mp.tool_output,
             mp.metadata
      FROM messages m
      LEFT JOIN message_parts mp ON mp.message_id = m.message_id
      WHERE m.conversation_id = ${Number(conversationId)}
        AND m.seq > ${Math.max(0, Number(previousSeq || 0))}
      ORDER BY m.seq ASC, mp.ordinal ASC
      LIMIT ${Math.max(1, Number(limit || 48) * 4)}
    `);

    return mergeMessageRows(rows).slice(-Math.abs(limit));
  }

  return {
    dbPath,
    getLatestSummaryWatermark,
    computeMessageDelta,
    computeConversationMessageDelta,
    hasSummaryAdvanced,
    getRecentSummariesSince,
    getRecentMessagesForSession,
    getConversationMessagesSince,
    getConversationForSession,
  };
}
