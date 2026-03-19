function formatMetadata(candidate) {
  const extras = [];
  if (candidate.shardKey) {
    extras.push(`shard=${candidate.shardKey}`);
  }
  if (Number.isFinite(candidate.score)) {
    extras.push(`score=${candidate.score.toFixed(2)}`);
  }
  return extras.length > 0 ? ` (${extras.join(', ')})` : '';
}

export function renderVestigeRecentPacket(candidates = []) {
  const lines = candidates
    .filter((candidate) => typeof candidate.statement === 'string' && candidate.statement.trim().length > 0)
    .map((candidate) => `- ${candidate.statement}${formatMetadata(candidate)}`);

  if (lines.length === 0) {
    return '';
  }

  return ['<vestige_recent>', ...lines, '</vestige_recent>'].join('\n');
}

function quoteYaml(value) {
  return JSON.stringify(String(value ?? ''));
}

export function renderShardSnapshot({ shardKey, scope, generationId, generatedAt, items }) {
  const header = [
    '---',
    `source: ${quoteYaml('vestige')}`,
    `type: ${quoteYaml('stable-memory-snapshot')}`,
    `version: ${quoteYaml('1')}`,
    `generated_at: ${quoteYaml(generatedAt)}`,
    `generation_id: ${quoteYaml(generationId)}`,
    `scope: ${quoteYaml(scope)}`,
    `shard_key: ${quoteYaml(shardKey)}`,
    '---',
    '',
  ];

  const body = [...items]
    .sort((left, right) => String(left.vestige_id ?? '').localeCompare(String(right.vestige_id ?? '')))
    .map((item) => {
      const meta = [
        `category=${item.category}`,
        `confidence=${Number.isFinite(item.confidence) ? item.confidence.toFixed(2) : 'n/a'}`,
      ];
      if (item.transfer_reason) {
        meta.push(`transfer_reason=${item.transfer_reason}`);
      }
      return `- ${item.statement} <!-- ${meta.join('; ')} -->`;
    });

  return [...header, ...body, ''].join('\n');
}
