function ensureSentence(text) {
  const value = String(text || '').trim();
  if (!value) {
    return '';
  }
  if (/[.!?]$/.test(value)) {
    return value;
  }
  return `${value}.`;
}

function sanitizeLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function renderVestigeBullet(entry) {
  const text = ensureSentence(entry?.text || entry?.statement);
  if (!text) {
    return '';
  }

  const label = sanitizeLabel(entry?.label);
  if (!label) {
    return `- ${text}`;
  }

  return `- [${label}] ${text}`;
}

export function renderVestigeRecent(entries = [], options = {}) {
  const { maxChars = 1400 } = options;
  const lines = entries
    .map((entry) => renderVestigeBullet(entry))
    .filter(Boolean);

  if (lines.length === 0) {
    return '';
  }

  const packet = `<vestige_recent>\n${lines.join('\n')}\n</vestige_recent>`;
  if (packet.length <= maxChars) {
    return packet;
  }

  const boundedLines = [];
  let total = '<vestige_recent>\n</vestige_recent>'.length;

  for (const line of lines) {
    const lineSize = line.length + 1;
    if (total + lineSize > maxChars) {
      break;
    }

    boundedLines.push(line);
    total += lineSize;
  }

  if (boundedLines.length === 0) {
    return '';
  }

  return `<vestige_recent>\n${boundedLines.join('\n')}\n</vestige_recent>`;
}
