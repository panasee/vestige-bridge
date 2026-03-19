import { dedupeCandidates } from './dedupe.js';
import { packCandidates } from './packing.js';
import { buildRecallQuery, buildRecentTail, extractLatestUserText } from './query-builder.js';
import { normalizeCandidate } from './normalize.js';
import { renderVestigeRecentPacket } from './render.js';

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function extractSidecarItems(response) {
  if (!response || typeof response !== 'object') {
    return [];
  }
  return toArray(response.items ?? response.results ?? response.memories ?? response.data);
}

function mapSidecarItemToCandidate(item) {
  return normalizeCandidate({
    source: 'vestige',
    statement: item.statement ?? item.text ?? item.memory ?? '',
    score: Number.isFinite(item.score) ? item.score : Number.isFinite(item.confidence) ? item.confidence : undefined,
    materialized: Boolean(item.materialized),
    shardKey: item.shard_key ?? item.shardKey ?? '',
    raw: item,
  });
}

export async function buildRecentRecallPacket({ sidecarClient, config, messages, logger, routeHint, projectHint, extraCandidates = [] }) {
  const latestUserText = extractLatestUserText(messages);
  if (!latestUserText) {
    return { packet: '', kept: [], dropped: [], packedDropped: [], query: '' };
  }

  const recentTail = buildRecentTail(messages, config.recall.maxTailMessages);
  const query = buildRecallQuery({ latestUserText, recentTail, routeHint, projectHint });
  const response = await sidecarClient.search({
    query,
    maxResults: config.recall.maxResults,
    maxTokens: config.recall.maxTokens,
    skipMaterialized: config.recall.skipMaterialized,
  });

  const vestigeCandidates = extractSidecarItems(response)
    .map((item) => mapSidecarItemToCandidate(item))
    .filter((candidate) => candidate.statement)
    .filter((candidate) => !(config.recall.skipMaterialized && candidate.materialized));

  const merged = [...vestigeCandidates, ...toArray(extraCandidates).map((item) => normalizeCandidate(item))];
  const deduped = dedupeCandidates(merged);
  const packed = packCandidates(deduped.kept, {
    bucketPriority: config.packing.bucketPriority,
    softTarget: config.recall.softTarget,
    hardCap: config.recall.hardCap,
  });

  const packet = renderVestigeRecentPacket(packed.kept.filter((candidate) => candidate.source === 'vestige'));

  logger?.debug?.(`recall query=${query} raw=${vestigeCandidates.length} deduped=${deduped.kept.length} kept=${packed.kept.length}`);

  return {
    query,
    packet,
    kept: packed.kept,
    dropped: deduped.dropped,
    packedDropped: packed.dropped,
    rawVestigeCandidates: vestigeCandidates,
  };
}

export function buildAgentEndPayload({ messages, ctx }) {
  const latestUserText = extractLatestUserText(messages);
  const recentTail = buildRecentTail(messages, 6);
  return {
    session_key: ctx?.sessionKey,
    agent_id: ctx?.agentId,
    latest_user_turn: latestUserText,
    recent_tail: recentTail,
    trigger: ctx?.trigger,
    channel_id: ctx?.channelId,
  };
}
