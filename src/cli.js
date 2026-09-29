/**
 * starreview — social review management for AI agents.
 *
 * Output contract (agent-first, mirrors the Postiz agent-CLI convention):
 * every command prints exactly one JSON document to stdout. Success prints the
 * tool payload verbatim; failure prints { "error": code, "message": ... } and
 * exits non-zero. Usage problems print usage to stderr and exit 2.
 *
 * The CLI is a thin client over the hosted MCP endpoint. It drafts and submits
 * replies but can never post them itself. StarReview applies the owner's
 * approval and automatic-publishing settings (see SKILL.md, "Boundaries").
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
  draft       <reviewId>                              generate reply drafts
  submit      <reviewId> --variant <n> [--text <s>] [--post-at <iso>]
                                                      submit a StarReview draft
  submit      <reviewId> --text <s> [--post-at <iso>] submit your OWN text (always pending)
  stats       [--business <id>] [--provider <slug>]   weekly recap headline stats

Commands (no key needed):
  info                                                about StarReview + pricing

The CLI never posts to Google or any other platform. An eligible, unedited
StarReview draft may be scheduled under the owner's standing consent and
automatic-publishing settings. Agent-written, edited, or safety-held replies
remain pending.`;

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

function intOrUsage(value, flag, maximum) {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw usageError(`--${flag} must be an integer from 1 to ${maximum}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) {
    throw usageError(`--${flag} must be an integer from 1 to ${maximum}`);
  }
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
      limit: intOrUsage(values.limit, 'limit', 50),
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
        variant: intOrUsage(values.variant, 'variant', Number.MAX_SAFE_INTEGER),
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
    provider: { type: 'string' },
  });
  return callTool({
    name: 'get_report_stats',
    args: prune({ businessId: values.business, provider: values.provider }),
    ...ctx,
  });
}

async function cmdInfo(argv, ctx) {
  parse(argv, {});
  return callTool({ name: 'get_service_info', args: {}, isPublic: true, ...ctx });
}


const COMMANDS = {
  locations: cmdLocations,
  reviews: cmdReviews,
  review: cmdReview,
  draft: cmdDraft,
  submit: cmdSubmit,
  stats: cmdStats,
  info: cmdInfo,
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
