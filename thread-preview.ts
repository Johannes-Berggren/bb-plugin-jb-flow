// Reading a thread for the app without opening it: the one-line preview from
// its last reply, what happened since you last read it (the Catch up card),
// and the options the reply buttons offer.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { countSince } from "./catch-up-model";
import { nextMove, nextMoves } from "./decisions";
import type { rpcContract } from "./rpc-contract";

export function threadPreviewRpc(bb: BbPluginApi): Pick<PluginRpcHandlers<typeof rpcContract>, "thread_preview" | "catch_up_card" | "decision_options"> {
  return {
    thread_preview: async ({ threadId }) => {
      const [output, outline] = await Promise.all([
        bb.sdk.threads.output({ threadId }).catch(() => ({ output: null })),
        bb.sdk.threads.conversationOutline({ threadId }).catch(() => ({ items: [] as Array<{ role: string; preview: string }> })),
      ]);
      const reply = output.output ?? "";
      // Markdown → plain text for one-line display.
      const plain = (text: string) =>
        text
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/[*_`>#]+/g, "")
          .replace(/[\u2580-\u259F\u2500-\u257F]+/g, "")
          .replace(/\s+/g, " ")
          .trim();
      // The user's Status template: "**Goal:** …", "**Next:** …", etc.
      const field = (name: string) => {
        const match = new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, "i").exec(reply);
        return match ? plain(match[1]!).slice(0, 300) : "";
      };
      const userItems = outline.items.filter((item) => item.role === "user");
      const firstLines = reply
        .split("\n")
        .map(plain)
        .filter((line) => line.length > 0 && !/^(goal|done|next|blocked):/i.test(line))
        .slice(0, 4)
        .join(" ");
      return {
        goal: field("Goal") || plain(userItems[0]?.preview ?? "").slice(0, 300),
        done: field("Done"),
        next: field("Next"),
        blocked: field("Blocked"),
        latest: firstLines.slice(0, 400),
        prompts: userItems.length,
      };
    },
    catch_up_card: async ({ threadId, since }) => {
      // The card embeds the thread itself; this adds what happened since you last read it.
      const timeline = await bb.sdk.threads
        .timeline({ threadId, segmentLimit: "8", deferContent: "true", includeNestedRows: "false" })
        .catch(() => null);
      return { since: countSince(timeline?.rows ?? [], since, (timeline?.timelinePage.olderCursor ?? null) !== null) };
    },
    decision_options: async ({ threadId }) => {
      const output = await bb.sdk.threads.output({ threadId }).catch(() => ({ output: null }));
      const message = output.output ?? "";
      const groups = nextMoves(message);
      return { ...nextMove(message), ...(groups.length > 1 ? { groups } : {}) };
    },
  };
}
