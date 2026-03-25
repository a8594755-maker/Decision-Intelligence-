/**
 * transcriptIntakeService.js — Meeting Transcript Intake Processor
 *
 * Parses meeting transcripts and extracts actionable tasks for the AI Employee.
 *
 * Supports:
 *   - Speaker turn parsing (Speaker: text format)
 *   - Action item extraction with owner assignment
 *   - Decision point detection
 *   - Topic segmentation
 *   - Priority and deadline extraction from context
 *
 * Usage:
 *   const result = await processTranscriptIntake({
 *     transcript: 'John: We need a forecast for Q2...',
 *     meetingTitle: 'Weekly Supply Chain Review',
 *     employeeId, userId,
 *   });
 */

import { processIntake, batchProcessIntake, INTAKE_SOURCES } from './taskIntakeService.js';

// ── Speaker Turn Parsing ────────────────────────────────────────────────────

/**
 * @typedef {Object} SpeakerTurn
 * @property {string} speaker   - Speaker name
 * @property {string} text      - What was said
 * @property {number} turnIndex - Sequential index
 * @property {string} [timestamp] - Timestamp if present
 */

const TURN_PATTERNS = [
  // "John:" or "John Smith:"
  /^([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?):\s*(.+)/,
  // "[00:15:30] John:" with timestamp
  /^\[(\d{2}:\d{2}(?::\d{2})?)\]\s*([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?):\s*(.+)/,
  // "Speaker 1:" or "Participant A:"
  /^((?:Speaker|Participant)\s+\w+):\s*(.+)/,
];

/**
 * Parse a transcript into speaker turns.
 *
 * @param {string} transcript
 * @returns {SpeakerTurn[]}
 */
export function parseSpeakerTurns(transcript) {
  if (!transcript) return [];

  const lines = transcript.split(/\r?\n/).filter(l => l.trim());
  const turns = [];
  let currentTurn = null;

  for (const line of lines) {
    let matched = false;

    for (const pattern of TURN_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        // Save previous turn
        if (currentTurn) turns.push(currentTurn);

        if (match.length === 4) {
          // Pattern with timestamp
          currentTurn = {
            speaker: match[2],
            text: match[3].trim(),
            turnIndex: turns.length,
            timestamp: match[1],
          };
        } else {
          currentTurn = {
            speaker: match[1],
            text: match[2].trim(),
            turnIndex: turns.length,
          };
        }
        matched = true;
        break;
      }
    }

    if (!matched && currentTurn) {
      // Continuation of previous turn
      currentTurn.text += ' ' + line.trim();
    } else if (!matched && !currentTurn) {
      // Unstructured text — treat as single "Unknown" speaker block
      currentTurn = {
        speaker: 'Unknown',
        text: line.trim(),
        turnIndex: turns.length,
      };
    }
  }

  // Push last turn
  if (currentTurn) turns.push(currentTurn);

  return turns;
}

// ── Action Item Extraction ──────────────────────────────────────────────────

const TRANSCRIPT_ACTION_PATTERNS = [
  /(?:action item|action|todo|task|follow.?up):\s*(.+)/gi,
  /(?:we need to|let'?s|please|I'?ll|someone should)\s+(.+?)(?:\.|$)/gi,
  /(?:can you|could you|would you)\s+(.+?)(?:\?|$)/gi,
  /(?:assigned? to)\s+(\S+):\s*(.+)/gi,
  /(?:deadline|due|by)\s+(.+)/gi,
  /(?:請|需要|要)\s*(.+?)(?:。|$)/gi,
];

const DECISION_PATTERNS = [
  /(?:decided|agreed|confirmed|approved|decision):\s*(.+)/gi,
  /(?:we(?:'ll| will)|going to)\s+(.+?)(?:\.|$)/gi,
  /(?:決定|同意|確認)\s*(.+?)(?:。|$)/gi,
];

/**
 * @typedef {Object} TranscriptActionItem
 * @property {string} text        - Action description
 * @property {string} [owner]     - Assigned person
 * @property {string} [deadline]  - Mentioned deadline
 * @property {string} speaker     - Who mentioned it
 * @property {number} turnIndex   - Where in transcript
 * @property {'action'|'decision'} type
 */

/**
 * Extract action items and decisions from parsed turns.
 *
 * @param {SpeakerTurn[]} turns
 * @returns {TranscriptActionItem[]}
 */
export function extractTranscriptActions(turns) {
  const items = [];
  const seen = new Set();

  for (const turn of turns) {
    // Check action patterns
    for (const pattern of TRANSCRIPT_ACTION_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(turn.text)) !== null) {
        const text = (match[2] || match[1]).trim();
        if (text.length < 5 || text.length > 300 || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());

        items.push({
          text,
          owner: extractOwnerFromContext(turn.text, text),
          deadline: extractDeadlineFromContext(turn.text),
          speaker: turn.speaker,
          turnIndex: turn.turnIndex,
          type: 'action',
        });
      }
    }

    // Check decision patterns
    for (const pattern of DECISION_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(turn.text)) !== null) {
        const text = (match[1]).trim();
        if (text.length < 5 || text.length > 300 || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());

        items.push({
          text,
          speaker: turn.speaker,
          turnIndex: turn.turnIndex,
          type: 'decision',
        });
      }
    }
  }

  return items;
}

function extractOwnerFromContext(text, actionText) {
  const ownerPatterns = [
    /assigned?\s+to\s+(\S+)/i,
    /(\S+)\s+(?:will|should|can)\s+/i,
    /@(\w+)/,
  ];
  for (const p of ownerPatterns) {
    const m = text.match(p);
    if (m && m[1] !== actionText.split(' ')[0]) return m[1];
  }
  return null;
}

function extractDeadlineFromContext(text) {
  const deadlinePatterns = [
    /by\s+((?:next\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|week|month|EOD|end of day|end of week))/i,
    /(?:deadline|due):\s*(.+?)(?:\.|,|$)/i,
    /before\s+([\w\s]+?)(?:\.|,|$)/i,
  ];
  for (const p of deadlinePatterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

// ── Topic Segmentation ──────────────────────────────────────────────────────

const TOPIC_MARKERS = [
  /(?:let'?s (?:talk|discuss|move on to)|next (?:topic|item)|moving on|regarding)\s+(.+?)(?:\.|$)/gi,
  /(?:agenda item|topic)\s*\d*:\s*(.+)/gi,
  /(?:關於|接下來|議題)\s*(.+?)(?:。|$)/gi,
];

/**
 * Detect topic boundaries in the transcript.
 *
 * @param {SpeakerTurn[]} turns
 * @returns {{ topic: string, startTurn: number }[]}
 */
export function detectTopics(turns) {
  const topics = [];

  for (const turn of turns) {
    for (const pattern of TOPIC_MARKERS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(turn.text);
      if (match) {
        topics.push({
          topic: match[1].trim(),
          startTurn: turn.turnIndex,
        });
      }
    }
  }

  return topics;
}

// ── Meeting Summary ─────────────────────────────────────────────────────────

/**
 * Build a structured meeting summary.
 *
 * @param {string} transcript
 * @param {Object} [metadata]
 * @returns {{ turns, speakers, topics, actions, decisions, summary }}
 */
export function analyzeMeeting(transcript, metadata = {}) {
  const turns = parseSpeakerTurns(transcript);
  const speakers = [...new Set(turns.map(t => t.speaker))];
  const topics = detectTopics(turns);
  const allActions = extractTranscriptActions(turns);
  const actions = allActions.filter(a => a.type === 'action');
  const decisions = allActions.filter(a => a.type === 'decision');

  return {
    meeting_title: metadata.meeting_title || metadata.title || 'Untitled Meeting',
    date: metadata.date || new Date().toISOString(),
    duration_minutes: metadata.duration_minutes || null,
    turns: turns.length,
    speakers,
    speaker_count: speakers.length,
    topics,
    actions,
    decisions,
    summary: {
      total_turns: turns.length,
      total_actions: actions.length,
      total_decisions: decisions.length,
      total_topics: topics.length,
    },
  };
}

// ── Full Transcript Intake Pipeline ─────────────────────────────────────────

/**
 * Process a meeting transcript into work orders.
 *
 * @param {Object} params
 * @param {string} params.transcript     - Full transcript text
 * @param {string} [params.meetingTitle] - Meeting title
 * @param {Object} [params.metadata]     - Additional metadata (date, participants, etc.)
 * @param {string} params.employeeId     - Target AI employee
 * @param {string} params.userId         - Requesting user
 * @returns {Promise<Object>} Intake results with work orders
 */
export async function processTranscriptIntake({ transcript, meetingTitle, metadata = {}, employeeId, userId }) {
  // 1. Analyze the meeting
  const analysis = analyzeMeeting(transcript, { ...metadata, meeting_title: meetingTitle });

  // 2. If no action items found, create single work order from full transcript
  if (analysis.actions.length === 0) {
    const result = await processIntake({
      source: INTAKE_SOURCES.MEETING_TRANSCRIPT,
      message: transcript,
      employeeId,
      userId,
      metadata: {
        meeting_title: meetingTitle,
        speakers: analysis.speakers,
        topics: analysis.topics.map(t => t.topic),
        ...metadata,
      },
    });

    return {
      analysis,
      work_orders: [result.workOrder],
      statuses: [result.status],
    };
  }

  // 3. Create work orders for each action item
  const intakeItems = analysis.actions.map(action => ({
    source: INTAKE_SOURCES.MEETING_TRANSCRIPT,
    message: action.text,
    employeeId,
    userId,
    metadata: {
      meeting_title: meetingTitle,
      title: `[Meeting] ${action.text.slice(0, 60)}`,
      owner: action.owner,
      deadline_hint: action.deadline,
      speaker: action.speaker,
      speakers: analysis.speakers,
      decisions: analysis.decisions.map(d => d.text),
      ...metadata,
    },
  }));

  const batchResult = await batchProcessIntake(intakeItems);

  return {
    analysis,
    work_orders: batchResult.created,
    statuses: {
      created: batchResult.created.length,
      duplicates: batchResult.duplicates,
      clarifications: batchResult.clarifications,
    },
  };
}
