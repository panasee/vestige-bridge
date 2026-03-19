function asText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => asText(item))
      .filter(Boolean)
      .join(' ');
  }

  if (value && typeof value === 'object') {
    return [
      value.text,
      value.content,
      value.summary,
      value.body,
      value.message,
      value.value,
    ]
      .map((item) => asText(item))
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function compactWhitespace(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimSegment(text, maxChars, { fromStart = true } = {}) {
  const value = compactWhitespace(text);

  if (!value || value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 1) {
    return value.slice(0, Math.max(maxChars, 0));
  }

  const ellipsis = '…';
  const sliceSize = maxChars - ellipsis.length;

  if (fromStart) {
    return `${value.slice(0, sliceSize).trimEnd()}${ellipsis}`;
  }

  return `${ellipsis}${value.slice(-sliceSize).trimStart()}`;
}

function messageRole(message) {
  const role = message?.role || message?.author || message?.type || 'message';
  return String(role).toLowerCase();
}

function messageText(message) {
  return compactWhitespace(asText(message));
}

export function extractLatestUserTurn(messages = []) {
  if (!Array.isArray(messages)) {
    return compactWhitespace(asText(messages));
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageRole(message) !== 'user') {
      continue;
    }

    const text = messageText(message);
    if (text) {
      return text;
    }
  }

  return '';
}

export const extractLatestUserText = extractLatestUserTurn;

export function buildRecentTail(messages = [], options = {}) {
  const {
    maxMessages = 4,
    maxChars = 220,
    excludeLatestUser = true,
  } = options;

  if (!Array.isArray(messages) || messages.length === 0) {
    return compactWhitespace(asText(messages));
  }

  const latestUserIndex = excludeLatestUser
    ? messages.findLastIndex((message) => messageRole(message) === 'user')
    : -1;

  const picked = [];

  for (let index = messages.length - 1; index >= 0 && picked.length < maxMessages; index -= 1) {
    if (excludeLatestUser && index === latestUserIndex) {
      continue;
    }

    const message = messages[index];
    const text = messageText(message);

    if (!text) {
      continue;
    }

    picked.push(`${messageRole(message)}: ${text}`);
  }

  return trimSegment(picked.reverse().join(' | '), maxChars, { fromStart: false });
}

export function buildRecallQuery(input = {}) {
  const {
    messages,
    latestUserTurn,
    recentTail,
    routeHint,
    projectHint,
    maxChars = 600,
    latestChars = 280,
    tailChars = 220,
    hintChars = 100,
  } = input;

  const latest = trimSegment(
    latestUserTurn || extractLatestUserTurn(messages),
    Math.min(latestChars, maxChars),
  );
  const tail = trimSegment(
    recentTail || buildRecentTail(messages, { maxMessages: 8, maxChars: tailChars }),
    Math.min(tailChars, maxChars),
    { fromStart: false },
  );
  const hint = trimSegment(
    [routeHint, projectHint]
      .map((item) => compactWhitespace(asText(item)))
      .filter(Boolean)
      .join(' | '),
    Math.min(hintChars, maxChars),
  );

  const parts = {};
  const segments = [];

  if (latest) {
    parts.latest = latest;
    segments.push(latest);
  }

  if (tail) {
    parts.tail = tail;
    segments.push(`recent context: ${tail}`);
  }

  if (hint) {
    parts.hint = hint;
    segments.push(`hint: ${hint}`);
  }

  const query = trimSegment(segments.join('\n'), maxChars);

  return {
    query,
    parts,
  };
}
