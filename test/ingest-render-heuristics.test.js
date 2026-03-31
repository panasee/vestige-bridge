import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTimeSensitiveMemory,
  buildFreshnessHint,
  renderVestigeBullet,
} from '../src/render.js';
import {
  buildExistingMemorySynopsisSection,
  buildEvaluationContext,
} from '../src/ingest.js';

test('isTimeSensitiveMemory keeps stable preference-style memories non-time-sensitive', () => {
  assert.equal(isTimeSensitiveMemory({
    label: 'recent-preference',
    statement: 'User prefers concise technical summaries and concrete plans.',
  }), false);

  assert.equal(isTimeSensitiveMemory({
    statement: 'User prefers mechanism-first explanations over vague brainstorming.',
  }), false);
});

test('isTimeSensitiveMemory marks project snapshot/config memories as time-sensitive', () => {
  assert.equal(isTimeSensitiveMemory({
    label: 'recent-project-momentum',
    statement: 'Current repo layout depends on the new config path and runtime wiring.',
  }), true);

  assert.equal(isTimeSensitiveMemory({
    statement: 'Current runtime behavior depends on repo config and database schema details.',
  }), true);
});

test('isTimeSensitiveMemory does not mark explicit corrections as time-sensitive', () => {
  assert.equal(isTimeSensitiveMemory({
    explicit: true,
    correction: true,
    statement: 'User corrected that durable writes must stay in memory-crystallizer only.',
  }), false);
});

test('buildFreshnessHint only appears for old time-sensitive memories', () => {
  const hint = buildFreshnessHint({
    label: 'recent-project-momentum',
    statement: 'Current config path depends on the runtime wiring.',
    timestamp: '2026-03-01T00:00:00Z',
  }, {
    now: new Date('2026-03-31T00:00:00Z'),
    thresholdDays: 14,
  });

  assert.match(hint, /Recorded 30 days ago/i);
  assert.match(hint, /verify against current code\/config/i);

  const noHint = buildFreshnessHint({
    label: 'recent-preference',
    statement: 'User prefers concise technical summaries.',
    timestamp: '2026-03-01T00:00:00Z',
  }, {
    now: new Date('2026-03-31T00:00:00Z'),
    thresholdDays: 14,
  });

  assert.equal(noHint, '');
});

test('renderVestigeBullet appends freshness guidance only when applicable', () => {
  const line = renderVestigeBullet({
    label: 'recent-project-momentum',
    statement: 'Current repo workflow depends on the config schema.',
    timestamp: '2026-03-01T00:00:00Z',
  }, {
    now: new Date('2026-03-31T00:00:00Z'),
    thresholdDays: 14,
  });

  assert.match(line, /Recorded 30 days ago/i);

  const stable = renderVestigeBullet({
    label: 'recent-preference',
    statement: 'User prefers concise technical summaries.',
    timestamp: '2026-03-01T00:00:00Z',
  }, {
    now: new Date('2026-03-31T00:00:00Z'),
    thresholdDays: 14,
  });

  assert.doesNotMatch(stable, /Recorded \d+ days ago/i);
});

test('buildExistingMemorySynopsisSection injects bounded related-memory bullets', () => {
  const section = buildExistingMemorySynopsisSection([
    {
      category: 'preference',
      statement: 'User prefers concise summaries.',
    },
    {
      category: 'project_fact',
      statement: 'Durable writes belong to memory-crystallizer.',
    },
  ], {
    ingest: {
      includeExistingMemorySynopsis: true,
      existingMemoryMaxItems: 1,
      existingMemoryMaxChars: 200,
    },
  });

  assert.match(section, /^Existing Related Memory Synopsis:/);
  assert.match(section, /User prefers concise summaries/i);
  assert.doesNotMatch(section, /memory-crystallizer/i);
});

test('buildEvaluationContext includes existing-memory synopsis alongside trigger and conversation context', () => {
  const context = buildEvaluationContext({
    messages: [
      { role: 'user', text: 'Please tighten memory extraction.' },
      { role: 'assistant', text: 'I will inspect the heuristics.' },
    ],
    summaries: [
      { summaryId: 'sum_1', createdAt: '2026-03-31T10:00:00Z', text: 'Earlier summary about durable memory policy.' },
    ],
    existingMemories: [
      { category: 'constraint', statement: 'Durable writes must stay in memory-crystallizer.' },
    ],
    trigger: { kind: 'agent_end', newMessages: 2 },
    config: {
      ingest: {
        includeExistingMemorySynopsis: true,
        existingMemoryMaxItems: 3,
        existingMemoryMaxChars: 300,
        maxTailMessages: 4,
      },
    },
  });

  assert.match(context, /Trigger Context:/);
  assert.match(context, /Existing Related Memory Synopsis:/);
  assert.match(context, /Recent Raw Conversation:/);
  assert.match(context, /Recent LCM Summaries:/);
  assert.match(context, /Durable writes must stay in memory-crystallizer/i);
});
