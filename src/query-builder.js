function cleanText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
}

export function buildRecallQuery({ latestUserText = '', recentTail = '', routeHint = '', projectHint = '' } = {}) {
  const parts = [];

  const latest = cleanText(latestUserText);
  const tail = cleanText(recentTail);
  const route = cleanText(routeHint);
  const project = cleanText(projectHint);

  if (latest) {
    parts.push(`latest user turn: ${latest}`);
  }
  if (tail) {
    parts.push(`recent context: ${tail}`);
  }
  if (project) {
    parts.push(`project hint: ${project}`);
  }
  if (route) {
    parts.push(`route hint: ${route}`);
  }

  return parts.join(' | ').slice(0, 1200);
}

export function extractLatestUserText(messages = []) {
  const normalized = normalizeMessages(messages);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (message.role === 'user' && message.text) {
      return message.text;
    }
  }
  return '';
}

export function buildRecentTail(messages = [], maxMessages = 8) {
  const normalized = normalizeMessages(messages);
  return normalized
    .slice(-Math.max(1, maxMessages))
    .map((message) => `${message.role}: ${message.text}`)
    .filter(Boolean)
    .join(' || ')
    .slice(0, 2000);
}

export function normalizeMessages(messages = []) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => normalizeMessage(message))
    .filter((message) => Boolean(message.text));
}

export function normalizeMessage(message) {
  if (typeof message === 'string') {
    return { role: 'unknown', text: cleanText(message) };
  }

  if (!message || typeof message !== 'object') {
    return { role: 'unknown', text: '' };
  }

  const role = typeof message.role === 'string' ? message.role : typeof message.type === 'string' ? message.type : 'unknown';
  const content = readMessageText(message.content ?? message.text ?? message.message ?? '');

  return {
    role: cleanRole(role),
    text: cleanText(content),
  };
}

function cleanRole(role) {
  const text = cleanText(role).toLowerCase();
  if (['user', 'assistant', 'system', 'tool'].includes(text)) {
    return text;
  }
  if (text.includes('user')) {
    return 'user';
  }
  if (text.includes('assistant')) {
    return 'assistant';
  }
  return text || 'unknown';
}

function readMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (!item || typeof item !== 'object') {
        return '';
      }
      return typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : '';
    })
    .join(' ');
}
