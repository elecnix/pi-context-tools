import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerTools from "../extensions/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ToolResultLike {
  content: { type: string; text: string }[];
  details?: unknown;
  terminate?: boolean;
}

interface ToolLike {
  name: string;
  description: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<ToolResultLike>;
}

interface CompactionCall {
  onComplete: () => void;
  onError: (error: Error) => void;
}

interface FakeEntry {
  id: string;
  type: string;
  message?:
    | { role: string; content: unknown; excludeFromContext?: boolean }
    | { role: "bashExecution"; command: string; output: string; excludeFromContext?: boolean };
  content?: unknown;
  display?: boolean;
}

/** Minimal stand-in for the append-only session tree pi exposes to extensions. */
class FakeSession {
  entries: FakeEntry[] = [];
  private counter = 0;

  nextId(): string {
    this.counter += 1;
    return `entry-${this.counter}`;
  }

  append(entry: Omit<FakeEntry, "id"> & { id?: string }): FakeEntry {
    const stored: FakeEntry = { ...entry, id: entry.id ?? this.nextId() };
    this.entries.push(stored);
    return stored;
  }

  appendUserMessage(text: string): FakeEntry {
    return this.append({ type: "message", message: { role: "user", content: text } });
  }

  appendBackgroundJob(command: string, output: string): FakeEntry {
    return this.append({ type: "message", message: { role: "bashExecution", command, output } });
  }
}

function createHarness(options: { mode?: string; onSend?: (message: string) => void } = {}) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolLike>();
  const sent: string[] = [];
  const compactions: CompactionCall[] = [];
  const notifications: { message: string; level: string }[] = [];
  const session = new FakeSession();
  let branchFails = false;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerTool(tool: ToolLike) {
      tools.set(tool.name, tool);
    },
    sendUserMessage(message: string) {
      options.onSend?.(message);
      sent.push(message);
      session.appendUserMessage(message);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getBranch() {
        if (branchFails) {
          throw new Error("session is gone");
        }
        return session.entries;
      },
    },
    compact(options: CompactionCall) {
      compactions.push(options);
    },
  } as unknown as ExtensionContext;

  registerTools(pi);

  const fire = async (event: string, payload: unknown = {}) => {
    const handler = handlers.get(event);
    assert.ok(handler, `no handler registered for ${event}`);
    return await handler(payload, ctx);
  };

  const requestCompaction = async (continueMessage: string, expectTerminate = true) => {
    const tool = tools.get("compact_context");
    assert.ok(tool, "compact_context tool is not registered");
    const result = await tool.execute("call-1", { continueMessage }, undefined, undefined, ctx);
    if (expectTerminate) {
      assert.equal(result.terminate, true, "tool must terminate the turn");
    }
    return result;
  };

  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  return {
    handlers,
    tools,
    sent,
    compactions,
    notifications,
    session,
    breakSession: () => {
      branchFails = true;
    },
    fire,
    requestCompaction,
    tick,
  };
}

describe("compact_context", () => {
  it("starts compaction at the turn boundary instead of waiting for the agent to go idle", async () => {
    const harness = createHarness();

    await harness.requestCompaction("Keep going");
    assert.equal(harness.compactions.length, 0, "compaction must not start mid-turn");

    const boundaryResult = await harness.fire("turn_end");

    assert.equal(harness.compactions.length, 1, "compaction starts at turn_end");
    assert.deepEqual(boundaryResult, { continue: false });

    harness.compactions[0].onComplete();
    assert.deepEqual(harness.sent, ["Keep going"]);
  });

  it("reports queued work that arrived after the request was composed", async () => {
    const harness = createHarness();

    await harness.requestCompaction("Keep going");
    harness.session.appendBackgroundJob("npm test", "2 passing");
    await harness.fire("turn_end");
    harness.compactions[0].onComplete();

    assert.equal(harness.sent.length, 1);
    const resume = harness.sent[0];
    assert.ok(resume.startsWith("Keep going"), "resume keeps the agent's instruction");
    assert.match(resume, /arrived after you composed/);
    assert.match(resume, /1\. Ran `npm test`: 2 passing/);
  });

  it("includes work that arrives while compaction is summarizing", async () => {
    const harness = createHarness();

    await harness.requestCompaction("Keep going");
    await harness.fire("turn_end");
    harness.session.appendUserMessage("actually stop and review the migration plan first");
    harness.compactions[0].onComplete();

    assert.match(harness.sent[0], /1\. actually stop and review the migration plan first/);
  });

  it("ignores entries that existed before the request", async () => {
    const harness = createHarness();

    harness.session.appendUserMessage("the original prompt");
    await harness.requestCompaction("Keep going");
    await harness.fire("turn_end");
    harness.compactions[0].onComplete();

    assert.deepEqual(harness.sent, ["Keep going"]);
  });

  it("skips entries that never reach the model", async () => {
    const harness = createHarness();

    await harness.requestCompaction("Keep going");
    harness.session.append({
      type: "message",
      message: {
        role: "bashExecution",
        command: "setup",
        output: "secret setup output",
        excludeFromContext: true,
      },
    });
    harness.session.append({ type: "custom_message", content: "hidden note", display: false });
    await harness.fire("turn_end");
    harness.compactions[0].onComplete();

    assert.deepEqual(harness.sent, ["Keep going"]);
  });

  it("resumes the agent when compaction fails", async () => {
    const harness = createHarness();

    await harness.requestCompaction("Keep going");
    await harness.fire("turn_end");
    harness.compactions[0].onError(new Error("summarization request failed"));

    assert.equal(harness.sent.length, 1, "a failed compaction must not strand the agent");
    assert.match(harness.sent[0], /Keep going/);
    assert.match(harness.sent[0], /did not complete \(summarization request failed\)/);
    assert.ok(
      harness.notifications.some((n) => n.level === "error"),
      "failure is surfaced in the UI",
    );
  });

  it("does not warn when there was simply nothing to compact", async () => {
    const harness = createHarness();

    await harness.requestCompaction("Keep going");
    await harness.fire("turn_end");
    harness.compactions[0].onError(new Error("Nothing to compact (session too small)"));

    assert.deepEqual(harness.sent, ["Keep going"]);
  });

  it("falls back to agent_end when no turn boundary fires", async () => {
    const harness = createHarness();

    await harness.requestCompaction("Keep going");
    await harness.fire("agent_end");
    assert.equal(harness.compactions.length, 0, "start is deferred out of the agent_end handler");
    await harness.tick();

    assert.equal(harness.compactions.length, 1);
    harness.compactions[0].onComplete();
    assert.deepEqual(harness.sent, ["Keep going"]);
  });

  it("compacts once per request", async () => {
    const harness = createHarness();

    await harness.requestCompaction("Keep going");
    await harness.fire("turn_end");
    await harness.fire("turn_end");
    await harness.fire("agent_end");
    await harness.tick();

    assert.equal(harness.compactions.length, 1);
  });

  it("treats a re-request during compaction as a new request without echoing its own resume message", async () => {
    const harness = createHarness();

    await harness.requestCompaction("Keep going");
    await harness.fire("turn_end");
    // The agent asked again while the first compaction was still summarizing.
    await harness.requestCompaction("Now do the second pass");
    harness.compactions[0].onComplete();
    await harness.fire("turn_end");

    assert.equal(harness.compactions.length, 2);
    harness.compactions[1].onComplete();
    assert.deepEqual(harness.sent[1], "Now do the second pass");
  });

  it("declines to compact in single-shot modes instead of aborting the run", async () => {
    for (const mode of ["print", "json"]) {
      const harness = createHarness({ mode });
      const result = await harness.requestCompaction("Keep going", false);
      assert.match(result.content[0].text, /unavailable in this mode/);
      await harness.fire("turn_end");
      assert.equal(harness.compactions.length, 0);
      assert.deepEqual(harness.sent, []);
    }
  });

  it("never throws when the session is torn down while compaction runs", async () => {
    const harness = createHarness({
      onSend: () => {
        throw new Error("session replaced");
      },
    });

    await harness.requestCompaction("Keep going");
    await harness.fire("turn_end");
    harness.breakSession();

    assert.doesNotThrow(() => harness.compactions[0].onComplete());
    assert.doesNotThrow(() =>
      harness.compactions[0].onError(new Error("summarization request failed")),
    );
  });
});
