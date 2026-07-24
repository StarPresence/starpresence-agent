/**
 * starreview — social review management for AI agents.
 *
 * Output contract (agent-first, mirrors the Postiz agent-CLI convention):
 * every command prints exactly one JSON document to stdout. Success prints the
 * tool payload verbatim; failure prints { "error": code, "message": ... } and
 * exits non-zero. Usage problems print usage to stderr and exit 2.
 *
 * The CLI is a thin client over the hosted MCP endpoint: it drafts and submits
 * replies into the owner's approval queue and can NEVER publish — the server
 * has no publish tool (see SKILL.md, "Boundaries").
 */

import { parseArgs } from 'node:util';
import { callTool, CliError } from './mcp.js';

const USAGE = `starreview <command> [options]

Review management for AI agents. Auth: export STARREVIEW_API_KEY=sragt_...
(create the key in your StarReview settings). JSON output on stdout.

Commands (authenticated):
  locations   [--business <id>]                       connected locations
  reviews     [--business <id>] [--location <id>] [--provider <slug>] [--limit <n>]
                                                      unanswered reviews
  review      <reviewId>                              full review context + drafts
  draft       <reviewId>                              generate reply drafts (pending approval)
  submit      <reviewId> --variant <n> [--text <s>] [--post-at <iso>]
                                                      submit a StarReview draft for approval
  submit      <reviewId> --text <s> [--post-at <iso>] submit your OWN text for approval
  stats       [--business <id>] [--location <id>] [--days <n>]
                                                      read-only review KPIs

Commands (no key needed):
  info                                                about StarReview + pricing
  check       "<business name>" [--place <placeId>] [--lang de|fr|it|en]
                                                      free response-rate check

Every reply an agent submits waits for the owner's approval. The CLI cannot
post to Google or any other platform.`;

function usageError(message) {
  const err = new Error(message);
  err.isUsage = true;
  return err;
}

function parse(argv, options, allowPositionals = false) {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true });
  } catch (err) {
    throw usageError(err.message);
  }
}

function intOrUsage(value, flag) {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw usageError(`--${flag} must be a positive integer`);
  return n;
}

const SCOPE_OPTIONS = {
  business: { type: 'string' },
};

async function cmdLocations(argv, ctx) {
  const { values } = parse(argv, SCOPE_OPTIONS);
  return callTool({ name: 'list_locations', args: prune({ businessId: values.business }), ...ctx });
}

async function cmdReviews(argv, ctx) {
  const { values } = parse(argv, {
    ...SCOPE_OPTIONS,
    location: { type: 'string' },
    provider: { type: 'string' },
    limit: { type: 'string' },
  });
  return callTool({
    name: 'list_unanswered_reviews',
    args: prune({
      businessId: values.business,
      locationId: values.location,
      provider: values.provider,
      limit: intOrUsage(values.limit, 'limit'),
    }),
    ...ctx,
  });
}

async function cmdReview(argv, ctx) {
  const { positionals } = parse(argv, {}, true);
  if (positionals.length !== 1) throw usageError('usage: starreview review <reviewId>');
  return callTool({ name: 'get_review_context', args: { reviewId: positionals[0] }, ...ctx });
}

async function cmdDraft(argv, ctx) {
  const { positionals } = parse(argv, {}, true);
  if (positionals.length !== 1) throw usageError('usage: starreview draft <reviewId>');
  return callTool({ name: 'draft_reply', args: { reviewId: positionals[0] }, ...ctx });
}

async function cmdSubmit(argv, ctx) {
  const { values, positionals } = parse(argv, {
    variant: { type: 'string' },
    text: { type: 'string' },
    'post-at': { type: 'string' },
  }, true);
  if (positionals.length !== 1) throw usageError('usage: starreview submit <reviewId> (--variant <n> [--text <s>] | --text <s>) [--post-at <iso>]');
  const reviewId = positionals[0];
  const postAt = values['post-at'];

  if (values.variant !== undefined) {
    // Commit one of StarReview's drafted variants (optionally edited).
    return callTool({
      name: 'submit_reply_for_approval',
      args: prune({
        reviewId,
        variant: intOrUsage(values.variant, 'variant'),
        finalText: values.text,
        preferredPostAt: postAt,
      }),
      ...ctx,
    });
  }
  if (values.text) {
    // The agent's own text: always waits for a human, never auto-schedules.
    return callTool({
      name: 'submit_own_reply',
      args: prune({ reviewId, finalText: values.text, preferredPostAt: postAt }),
      ...ctx,
    });
  }
  throw usageError('submit needs --variant <n> (a StarReview draft) or --text <s> (your own reply)');
}

async function cmdStats(argv, ctx) {
  const { values } = parse(argv, {
    ...SCOPE_OPTIONS,
    location: { type: 'string' },
    days: { type: 'string' },
  });
  return callTool({
    name: 'get_review_stats',
    args: prune({
      businessId: values.business,
      locationId: values.location,
      days: intOrUsage(values.days, 'days'),
    }),
    ...ctx,
  });
}

async function cmdInfo(argv, ctx) {
  parse(argv, {});
  return callTool({ name: 'get_service_info', args: {}, isPublic: true, ...ctx });
}

async function cmdCheck(argv, ctx) {
  const { values, positionals } = parse(argv, {
    lang: { type: 'string' },
    place: { type: 'string' },
  }, true);
  const lang = values.lang;
  if (lang && !['de', 'fr', 'it', 'en'].includes(lang)) throw usageError('--lang must be de|fr|it|en');

  if (values.place) {
    return callTool({ name: 'check_response_rate', args: prune({ placeId: values.place, lang }), isPublic: true, ...ctx });
  }

  const query = positionals.join(' ').trim();
  if (query.length < 3) throw usageError('usage: starreview check "<business name>" [--place <placeId>] [--lang de]');

  const found = await callTool({ name: 'search_business', args: prune({ query, lang }), isPublic: true, ...ctx });
  const candidates = Array.isArray(found?.candidates) ? found.candidates : (Array.isArray(found) ? found : []);
  if (candidates.length === 1 && candidates[0]?.placeId) {
    const check = await callTool({ name: 'check_response_rate', args: prune({ placeId: candidates[0].placeId, lang }), isPublic: true, ...ctx });
    return { candidate: candidates[0], check };
  }
  // Ambiguous (or empty): never guess which business the user meant.
  return {
    candidates,
    hint: candidates.length
      ? 'Multiple candidates. Re-run: starreview check --place <placeId>'
      : 'No candidates found. Refine the query (add the city).',
  };
}

const COMMANDS = {
  locations: cmdLocations,
  reviews: cmdReviews,
  review: cmdReview,
  draft: cmdDraft,
  submit: cmdSubmit,
  stats: cmdStats,
  info: cmdInfo,
  check: cmdCheck,
};

function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Run the CLI. Returns the process exit code; printing goes through io
 * (injectable for tests).
 */
export async function main(argv, io = { out: console.log, err: console.error }, ctx = {}) {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.err(USAGE);
    return command ? 0 : 2;
  }

  const fn = COMMANDS[command];
  if (!fn) {
    io.err(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  try {
    const payload = await fn(rest, ctx);
    io.out(JSON.stringify(payload, null, 2));
    return 0;
  } catch (err) {
    if (err?.isUsage) {
      io.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    const code = err instanceof CliError ? err.code : 'internal_error';
    io.out(JSON.stringify({ error: code, message: err?.message || String(err) }, null, 2));
    return 1;
  }
}
