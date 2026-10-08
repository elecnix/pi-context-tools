import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** A compaction request, armed by the tool and waiting for its boundary. */
interface PendingCompaction {
  /** Instruction the agent wants to receive once the compacted context is live. */
  continueMessage: string;
  /**
   * Session entries that already existed when the agent composed
   * `continueMessage`. Background job completions and user input append entries
   * behind the agent's back, and compaction rewrites the context underneath its
   * instruction, so the resume message has to mention them.
   */
  knownEntryIds: Set<string>;
}

/** Compaction failures that leave the context usable and need no scary warning. */
const BENIGN_COMPACTION_ERRORS = /already compacted|nothing to compact/i;

/**
 * Modes that tear the session down as soon as the prompt resolves. Compaction
 * cannot finish there, and requesting it would only abort the agent's run.
 */
const SINGLE_SHOT_MODES = new Set(["print", "json"]);

const ARRIVAL_PREVIEW_LENGTH = 300;

function textPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= ARRIVAL_PREVIEW_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, ARRIVAL_PREVIEW_LENGTH)}...`;
}

function describeContent(content: unknown): string | undefined {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) =>
        part && typeof part === "object" && "text" in part && typeof part.text === "string"
          ? part.text
          : "",
      )
      .join("\n");
  }
  if (!text.trim()) {
    return undefined;
  }
  return textPreview(text);
}

/**
 * Describe a session entry that reached the conversation after a compaction
 * request. Background job completions are appended straight to the session as
 * `bashExecution` messages, user input as user messages, and extensions use
 * custom messages, so all three have to be recognized.
 */
function describeEntry(entry: SessionEntry): string | undefined {
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "bashExecution") {
      if (message.excludeFromContext) {
        return undefined;
      }
      const output = message.output.trim();
      return textPreview(
        output ? `Ran \`${message.command}\`: ${output}` : `Ran \`${message.command}\``,
      );
    }
    if (message.role === "user" || message.role === "custom") {
      return describeContent(message.content);
    }
    return undefined;
  }
  if (entry.type === "custom_message" && entry.display) {
    return describeContent(entry.content);
  }
  return undefined;
}

/**
 * Everything the user or a background job delivered after the request was
 * composed, oldest first. Compaction keeps recent entries, so these messages
 * usually survive into the compacted context, but the resume instruction was
 * written without knowing about them.
 */
function collectArrivals(
  sessionManager: ExtensionContext["sessionManager"],
  request: PendingCompaction,
): string[] {
  const arrivals: string[] = [];
  for (const entry of sessionManager.getBranch()) {
    if (request.knownEntryIds.has(entry.id)) {
      continue;
    }
    const description = describeEntry(entry);
    if (description) {
      arrivals.push(description);
    }
  }
  return arrivals;
}

/**
 * What the compaction callbacks need once they run. It is captured while the
 * session is still alive: pi invalidates `ctx` on session replacement, reload,
 * and teardown, and these callbacks fire later, sometimes after the session is
 * already gone.
 */
interface ResumeTarget {
  notify(message: string, level: "info" | "error"): void;
  arrivals(request: PendingCompaction): string[];
  send(message: string): void;
}

function captureTarget(pi: ExtensionAPI, ctx: ExtensionContext): ResumeTarget {
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const sessionManager = ctx.sessionManager;
  return {
    notify(message, level) {
      ui?.notify(message, level);
    },
    arrivals(request) {
      try {
        return collectArrivals(sessionManager, request);
      } catch {
        // The session went away mid-compaction: report no arrivals rather than
        // taking the whole pi process down with us.
        return [];
      }
    },
    send(message) {
      try {
        pi.sendUserMessage(message);
      } catch {
        // Nothing to resume into, for example a session that was torn down.
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  /** Armed by the tool, waiting for the turn boundary. */
  let pending: PendingCompaction | undefined;
  let inFlight = false;
  /** Last message this extension injected, so it is not reported as an arrival. */
  let selfInjected: string | undefined;

  const buildResumeMessage = (
    target: ResumeTarget,
    request: PendingCompaction,
    failure?: string,
  ): string => {
    const sections = [request.continueMessage.trim()];

    if (failure && !BENIGN_COMPACTION_ERRORS.test(failure)) {
      sections.push(
        `Compaction was requested but did not complete (${failure}). The context above is unchanged, so re-check current state before continuing.`,
      );
    }

    const arrivals = target.arrivals(request).filter(
      // Never report this extension's own resume message as newly arrived work.
      (arrival) => selfInjected === undefined || arrival !== textPreview(selfInjected),
    );
    if (arrivals.length > 0) {
      sections.push(
        "These arrived after you composed that instruction, so verify their current state before acting on it:",
        ...arrivals.map((arrival, index) => `${index + 1}. ${arrival}`),
      );
    }

    return sections.join("\n\n");
  };

  /**
   * Start compaction now. `ctx.compact()` is fire-and-forget: it aborts the
   * current run first, then summarizes once the agent is idle, so queued work
   * (background job notifications, user input) cannot jump ahead of it.
   */
  const startCompaction = (ctx: ExtensionContext, request: PendingCompaction) => {
    const target = captureTarget(pi, ctx);
    inFlight = true;
    target.notify("Compaction requested: summarizing context now.", "info");

    ctx.compact({
      onComplete: () => {
        inFlight = false;
        target.notify("Compaction completed. Continuing with the compacted context.", "info");
        const resume = buildResumeMessage(target, request);
        selfInjected = resume;
        // Compaction has finished and the agent is idle, so this user message is
        // accepted immediately and starts a turn with the compacted context.
        target.send(resume);
      },
      onError: (error) => {
        inFlight = false;
        target.notify(`Compaction failed: ${error.message}`, "error");
        // Never strand the agent: it already stopped to compact, so it needs a
        // message that puts it back on track even when compaction did not run.
        const resume = buildResumeMessage(target, request, error.message);
        selfInjected = resume;
        target.send(resume);
      },
    });
  };

  // Earliest safe point: every tool result of the turn is persisted, so no
  // sibling tool is cut off and nothing the agent just produced is lost.
  pi.on("turn_end", (_event, ctx) => {
    if (!pending || inFlight) {
      return undefined;
    }
    const request = pending;
    pending = undefined;
    startCompaction(ctx, request);
    // Do not let another extension chain another model request onto a context
    // that is about to be replaced.
    return { continue: false };
  });

  // Fallback for runs that end without reaching a turn boundary (for example an
  // aborted turn). Compaction still outranks queued work: ctx.compact() aborts
  // the run before summarizing.
  pi.on("agent_end", (_event, ctx) => {
    if (!pending || inFlight) {
      return;
    }
    const request = pending;
    pending = undefined;
    setTimeout(() => {
      if (inFlight) {
        return;
      }
      startCompaction(ctx, request);
    }, 0);
  });

  pi.registerTool({
    name: "context_info",
    label: "Context Info",
    description:
      "Get the token/context length of the current agent session. Useful to decide whether to invoke the compact_context tool to keep session size low.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const usage = ctx.getContextUsage();

      if (!usage) {
        return {
          content: [{ type: "text", text: "Context usage is unavailable right now." }],
          details: {},
        };
      }

      if (usage.tokens === null) {
        return {
          content: [
            {
              type: "text",
              text: "Current context length is unknown until the next model response after compaction.",
            },
          ],
          details: {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            usage,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              usage.percent === null
                ? `Current context length: ${usage.tokens} tokens.`
                : `Current context length: ${usage.tokens} tokens (${usage.percent.toFixed(1)}% of maximum context window).`,
          },
        ],
        details:
          usage.percent === null
            ? {
                tokens: usage.tokens,
                contextWindow: usage.contextWindow,
                usage,
              }
            : {
                tokens: usage.tokens,
                percent: usage.percent,
                contextWindow: usage.contextWindow,
                usage,
              },
      };
    },
  });

  pi.registerTool({
    name: "compact_context",
    label: "Compact context",
    description:
      "Trigger context compaction. Useful for long-sessions or when orchestrating subagents/multi-step workflows to keep context size low. Compaction starts as soon as the current turn's tool results are in, ahead of any queued background job notifications, so the rest of this turn is skipped. The required continueMessage is sent as a user message after compaction completes, so it should describe what the agent should do next with the compacted context; anything that arrives while compaction runs is appended to that message.",
    parameters: Type.Object({
      continueMessage: Type.String({
        description:
          "Instruction for what the agent should do after compaction, sent as a user message once compaction completes.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (SINGLE_SHOT_MODES.has(ctx.mode)) {
        // pi tears the session down as soon as this prompt resolves, so there is
        // no run left to abort, summarize for, or resume into.
        pending = undefined;
        if (ctx.hasUI) {
          ctx.ui.notify(
            "compact_context does nothing in print/json mode: the session ends with this prompt.",
            "warning",
          );
        }
        return {
          content: [
            {
              type: "text",
              text: "Compaction is unavailable in this mode: pi exits when this prompt resolves, so there is no session left to compact or resume. Keep working in the current context instead.",
            },
          ],
          details: {},
        };
      }

      pending = {
        continueMessage: params.continueMessage,
        knownEntryIds: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)),
      };
      selfInjected = undefined;

      return {
        content: [
          {
            type: "text",
            text: "Compaction starts as soon as this turn's tool results are in. Stop planning further steps for this turn.",
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });
}
