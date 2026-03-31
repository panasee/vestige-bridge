# Lossless-Claw 依赖检查表

> **目的**: 当 lossless-claw 版本更新后，使用此检查表验证 vestige-bridge 功能完整性。
> 
> **位置**: `/home/dongkai-claw/workspace/vestige-bridge/`
> 
> **当前版本**: lossless-claw 0.5.1

---

## 1. 数据库路径检查

| 检查项 | 预期值 | 检查命令 | 通过标准 |
|-------|--------|---------|---------|
| 默认 LCM 数据库路径 | `~/.openclaw/lcm.db` | `ls -la ~/.openclaw/lcm.db` | 文件存在且可读 |
| 数据库文件权限 | `-rw-r--r--` 或更宽松 | `stat ~/.openclaw/lcm.db` | 用户可读写 |
| 数据库完整性 | 无损坏 | `sqlite3 ~/.openclaw/lcm.db "PRAGMA integrity_check;"` | 返回 `ok` |

**代码位置**: `src/lcm-trigger.js:resolveLcmDbPath()`

---

## 2. 表结构检查

### 2.1 核心表存在性

| 表名 | 检查命令 | 通过标准 |
|-----|---------|---------|
| `conversations` | `sqlite3 ~/.openclaw/lcm.db "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations';"` | 返回表名 |
| `messages` | 同上，替换表名 | 返回表名 |
| `message_parts` | 同上，替换表名 | 返回表名 |
| `summaries` | 同上，替换表名 | 返回表名 |

### 2.2 表列名检查

**conversations 表**:
```sql
sqlite3 ~/.openclaw/lcm.db "PRAGMA table_info(conversations);"
```
预期列: `conversation_id`, `session_id`, `created_at`

**messages 表**:
```sql
sqlite3 ~/.openclaw/lcm.db "PRAGMA table_info(messages);"
```
预期列: `message_id`, `conversation_id`, `seq`, `role`, `created_at`

**message_parts 表**:
```sql
sqlite3 ~/.openclaw/lcm.db "PRAGMA table_info(message_parts);"
```
预期列: `message_id`, `part_type`, `text_content`, `tool_output`, `metadata`, `ordinal`

**summaries 表**:
```sql
sqlite3 ~/.openclaw/lcm.db "PRAGMA table_info(summaries);"
```
预期列: `summary_id`, `conversation_id`, `created_at`, `kind`, `depth`, `content`

---

## 3. SQL 查询兼容性检查

vestige-bridge 使用以下 SQL 查询，需逐一验证：

### 3.1 查询最新摘要水印

```sql
sqlite3 -json ~/.openclaw/lcm.db "
SELECT summary_id, created_at
FROM summaries
ORDER BY datetime(created_at) DESC, summary_id DESC
LIMIT 1
"
```
**代码位置**: `getLatestSummaryWatermark()`

### 3.2 查询会话进度

```sql
sqlite3 -json ~/.openclaw/lcm.db "
SELECT c.conversation_id AS conversationId,
       c.session_id AS sessionId,
       COALESCE(MAX(m.seq), 0) AS maxSeq
FROM conversations c
LEFT JOIN messages m ON m.conversation_id = c.conversation_id
GROUP BY c.conversation_id, c.session_id
"
```
**代码位置**: `listConversationProgress()`

### 3.3 查询会话消息增量

```sql
sqlite3 -json ~/.openclaw/lcm.db "
SELECT conversation_id AS conversationId,
       COALESCE(MAX(seq), 0) AS maxSeq
FROM messages
WHERE conversation_id = 14
GROUP BY conversation_id
LIMIT 1
"
```
**代码位置**: `getConversationMessageProgress()`

### 3.4 查询最新摘要

```sql
sqlite3 -json ~/.openclaw/lcm.db "
SELECT summary_id AS summaryId,
       conversation_id AS conversationId,
       created_at AS createdAt,
       kind,
       depth,
       content
FROM summaries
ORDER BY datetime(created_at) DESC, summary_id DESC
LIMIT 8
"
```
**代码位置**: `getRecentSummariesSince()`

### 3.5 查询会话对应的 conversation

```sql
sqlite3 -json ~/.openclaw/lcm.db "
SELECT conversation_id AS conversationId,
       session_id AS sessionId,
       created_at AS createdAt
FROM conversations
WHERE session_id = 'test-session-id'
ORDER BY datetime(created_at) DESC
LIMIT 1
"
```
**代码位置**: `getConversationForSession()`

### 3.6 查询会话最近消息

```sql
sqlite3 -json ~/.openclaw/lcm.db "
SELECT m.role,
       m.seq,
       m.created_at AS createdAt,
       mp.part_type AS partType,
       mp.text_content,
       mp.tool_output,
       mp.metadata
FROM messages m
JOIN conversations c ON c.conversation_id = m.conversation_id
LEFT JOIN message_parts mp ON mp.message_id = m.message_id
WHERE c.session_id = 'test-session-id'
ORDER BY m.seq DESC, mp.ordinal ASC
LIMIT 48
"
```
**代码位置**: `getRecentMessagesForSession()`

### 3.7 查询指定 conversation 的新消息

```sql
sqlite3 -json ~/.openclaw/lcm.db "
SELECT m.role,
       m.seq,
       m.created_at AS createdAt,
       mp.part_type AS partType,
       mp.text_content,
       mp.tool_output,
       mp.metadata
FROM messages m
LEFT JOIN message_parts mp ON mp.message_id = m.message_id
WHERE m.conversation_id = 14
  AND m.seq > 0
ORDER BY m.seq ASC, mp.ordinal ASC
LIMIT 192
"
```
**代码位置**: `getConversationMessagesSince()`

---

## 4. 外部依赖检查

| 依赖 | 检查命令 | 通过标准 |
|-----|---------|---------|
| `sqlite3` CLI | `which sqlite3 && sqlite3 --version` | 命令存在，版本 >= 3.35 |
| Node.js `child_process.execFileSync` | Node 内置，无需检查 | N/A |

**注意**: vestige-bridge 通过 `execFileSync('sqlite3', ...)` 直接调用 SQLite CLI，而非使用 Node.js sqlite3 库。

---

## 5. 功能回归测试

### 5.1 触发器集成测试

运行 vestige-bridge 健康检查:
```bash
cd ~/workspace/vestige-bridge
npm run health
```

预期输出: 包含 `status: "healthy"` 或类似成功标识。

### 5.2 LCM Inspector 测试

手动测试 `createLcmInspector`:
```bash
node --input-type=module --eval "
import { createLcmInspector } from './src/lcm-trigger.js';
const inspector = createLcmInspector();
console.log('DB Path:', inspector.dbPath);
console.log('Latest Summary:', inspector.getLatestSummaryWatermark());
console.log('Conversation Progress:', inspector.listConversationProgress().slice(0, 3));
"
```

### 5.3 端到端触发测试

触发一次 Vestige 提取:
```bash
curl -X POST http://127.0.0.1:3928/ingest \
  -H "Authorization: Bearer $(cat ~/.local/share/core/auth_token)" \
  -H "Content-Type: application/json" \
  -d '{"content": "test memory from lcm integration check"}'
```

---

## 6. 版本变更历史追踪

| 日期 | lossless-claw 版本 | vestige-bridge 版本 | 变更影响 | 验证状态 |
|-----|-------------------|-------------------|---------|---------|
| 2026-03-23 | 0.5.1 | 0.1.0 | 初始安装 | ✅ 通过 |
| | | | | |

---

## 7. 常见问题排查

### 问题 1: `ENOENT: no such file or directory, open '~/.openclaw/lcm.db'`

**原因**: LCM 数据库未初始化或路径变更。

**解决**:
1. 检查 lossless-claw 插件是否正常加载
2. 验证 `openclaw.json` 中 `contextEngine: "lossless-claw"` 配置
3. 确认至少有一个会话已被 LCM 处理

### 问题 2: `SQLITE_ERROR: no such table: summaries`

**原因**: LCM 数据库 schema 不匹配。

**解决**:
1. 检查 lossless-claw 版本是否与 vestige-bridge 预期的 schema 兼容
2. 如有 schema 迁移，需同步更新 `lcm-trigger.js` 中的 SQL 查询

### 问题 3: 摘要水印检测失败

**原因**: `summaries` 表结构或时间戳格式变更。

**解决**:
1. 手动执行 §3.1 的 SQL 验证返回格式
2. 检查 `created_at` 字段是否仍为 ISO 8601 格式
3. 验证 `summary_id` 格式是否为 `sum_xxx`

### 问题 4: 消息增量计算不准确

**原因**: `messages` 或 `message_parts` 表结构变更。

**解决**:
1. 检查 `seq` 字段是否仍为整数序列
2. 验证 `message_parts.part_type` 枚举值是否包含 `'text'`
3. 检查 `message_parts.text_content` 列名是否正确

---

## 8. 升级后验证流程

当 lossless-claw 发布新版本时，按以下顺序执行：

```
┌─────────────────────────────────────────────────────────┐
│ 1. 备份当前 LCM 数据库                                   │
│    cp ~/.openclaw/lcm.db ~/.openclaw/lcm.db.bak         │
├─────────────────────────────────────────────────────────┤
│ 2. 执行 §1 数据库路径检查                                │
├─────────────────────────────────────────────────────────┤
│ 3. 执行 §2 表结构检查                                    │
│    - 如有新表/新列，评估是否需要更新 vestige-bridge     │
├─────────────────────────────────────────────────────────┤
│ 4. 执行 §3 SQL 查询兼容性检查（7项）                     │
│    - 如有查询失败，需修改 lcm-trigger.js                │
├─────────────────────────────────────────────────────────┤
│ 5. 执行 §5 功能回归测试                                  │
├─────────────────────────────────────────────────────────┤
│ 6. 更新 §6 版本变更历史                                  │
└─────────────────────────────────────────────────────────┘
```

---

## 9. 关键代码映射

| vestige-bridge 函数 | 依赖的 LCM 表/字段 | SQL 片段 |
|-------------------|-------------------|---------|
| `resolveLcmDbPath()` | 文件系统路径 | N/A |
| `getLatestSummaryWatermark()` | `summaries.summary_id`, `summaries.created_at` | `ORDER BY datetime(created_at) DESC` |
| `listConversationProgress()` | `conversations.*`, `messages.seq` | `LEFT JOIN ... GROUP BY` |
| `getConversationMessageProgress()` | `messages.conversation_id`, `messages.seq` | `COALESCE(MAX(seq), 0)` |
| `computeConversationMessageDelta()` | 同上 | 同上 |
| `hasSummaryAdvanced()` | `summaries.*` | 时间戳比较 |
| `getRecentSummariesSince()` | `summaries.*` | `datetime(created_at) > datetime(...)` |
| `getConversationForSession()` | `conversations.session_id` | `WHERE session_id = ?` |
| `getRecentMessagesForSession()` | `messages.*`, `message_parts.*`, `conversations.session_id` | 3表 JOIN |
| `getConversationMessagesSince()` | `messages.*`, `message_parts.*` | `WHERE seq > ?` |

---

## 10. 联系与维护

- **vestige-bridge 维护者**: 用户自行维护
- **lossless-claw 来源**: `@martian-engineering/lossless-claw` (npm)
- **当前安装路径**: `~/.openclaw/extensions/lossless-claw/`
- **当前版本**: 0.5.1

---

*最后更新: 2026-03-29*
*创建者: Coder Bot*