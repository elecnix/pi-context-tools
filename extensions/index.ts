import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  let compactAfterTurn: string | undefined = undefined;

  pi.on("agent_end", (_event, ctx) => {
    if (!compactAfterTurn) {
      return;
    }

    const continueMessage = compactAfterTurn;
    compactAfterTurn = undefined;
    setTimeout(() => {
      ctx.compact({
        onComplete: () => {
          if (ctx.hasUI) {
            ctx.ui.notify(
              "Compaction completed. Context usage will refresh after the next model response.",
              "info",
            );
          }
          // Compaction has finished and the agent is idle again, so this user
          // message is accepted immediately and triggers a new turn with the
          // compacted context.
          pi.sendUserMessage(continueMessage);
        },
        onError: (error) => {
          if (ctx.hasUI) {
            ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
          }
        },
      });
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
      "Trigger context compaction. Useful for long-sessions or when orchestrating subagents/multi-step workflows to keep context size low. After compaction completes, the message in continueMessage is sent as a user message to resume the agent.",
    parameters: Type.Object({
      continueMessage: Type.String({
        description:
          'Message to send as a user message after compaction completes, e.g. "Please continue".',
      }),
    }),
    async execute(_toolCallId, params) {
      compactAfterTurn = params.continueMessage;

      return {
        content: [
          {
            type: "text",
            text: "Compaction will run after this turn finishes.",
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });
}
