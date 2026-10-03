import type { Plugin } from "@opencode/plugin";

// A conservative prefilter, not a guarantee that arbitrary text contains no secrets.
export function sensitive(text: string) {
  return /(?:-----BEGIN .*PRIVATE KEY|\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,})|(?:api[_-]?key|token|password|secret|authorization)\s*(?:=|:|\s)\s*\S+)/i.test(text);
}

export async function reviewContext(ctx: Plugin.Context, sessionID: Parameters<typeof ctx.session.get>[0]["sessionID"]) {
  const requests: string[][] = [];
  let id: typeof sessionID | undefined = sessionID;
  const seen = new Set<string>();
  let directory = "";
  for (let depth = 0; id && depth < 5; depth++) {
    if (seen.has(id)) throw new Error("Cyclic session ancestry");
    seen.add(id);
    const session = await ctx.session.get({ sessionID: id });
    if (session.location.workspaceID) throw new Error("Remote workspace review is unsupported");
    if (depth === 0) directory = session.location.directory;
    const messages = await ctx.session.context({ sessionID: id });
    requests.push(messages.filter((m) => m.type === "user").map((m) => m.text));
    id = session.parentID;
  }
  if (id || !directory || !requests.at(-1)?.some((s) => s.trim())) throw new Error("Missing user authorization context");
  const result = { directory, original_user_requests: requests.at(-1)!, delegated_task: requests.slice(0, -1).flat() };
  if (JSON.stringify(result).length > 12_000 || sensitive(JSON.stringify(result))) {
    throw new Error("Context cannot be reviewed safely without truncation");
  }
  return result;
}
