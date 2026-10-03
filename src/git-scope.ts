// Deliberately not a shell parser. Only simple, unquoted Git inspection commands
// qualify for the non-Git role exception. Unknown options and shell syntax ask.
const flags: Record<string, Set<string>> = {
  status: new Set(["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"]),
  diff: new Set(["--no-ext-diff", "--no-textconv", "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--check", "--cached", "--staged", "--summary", "--patch", "-p", "--quiet", "--exit-code"]),
  log: new Set(["--no-ext-diff", "--no-textconv", "--oneline", "--stat", "--name-only", "--name-status", "--graph", "--decorate", "--all", "--patch", "-p", "--no-patch"]),
  show: new Set(["--no-ext-diff", "--no-textconv", "--oneline", "--stat", "--name-only", "--name-status", "--summary", "--patch", "-p", "--no-patch", "-s"]),
  "rev-parse": new Set(["--show-toplevel", "--show-prefix", "--git-dir", "--is-inside-work-tree", "--is-bare-repository", "--abbrev-ref", "--verify", "--short", "--symbolic-full-name"]),
  "ls-files": new Set(["--cached", "--modified", "--deleted", "--others", "--exclude-standard", "--stage", "--unmerged", "-s"]),
  remote: new Set(["-v", "--verbose"]),
  branch: new Set(["--list", "-l", "--all", "-a", "--remotes", "-r", "--verbose", "-v", "-vv", "--show-current", "--no-color"]),
};

export function readOnlyGit(command: string) {
  // Excludes expansion, substitution, redirection, quoting, control characters,
  // pipelines and command chaining. Do not mistake a prefix for the whole call.
  if (!/^[A-Za-z0-9_./:@=,+%\- \t]+$/.test(command)) return false;
  const words = command.trim().split(/[ \t]+/);
  if (words.shift() !== "git") return false;
  while (["--no-pager", "--no-optional-locks"].includes(words[0])) words.shift();
  const subcommand = words.shift()!;
  const allowed = flags[subcommand];
  if (!allowed) return false;
  let paths = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // Branch operands can create branches; remote operands can mutate remotes.
    if (subcommand === "branch" || subcommand === "remote") {
      if (!allowed.has(word)) return false;
      continue;
    }
    if (word === "--") { paths = true; continue; }
    if (paths || !word.startsWith("-")) continue;
    if (allowed.has(word)) continue;
    if (subcommand === "log" && (word === "-n" || word === "--max-count")) {
      if (!/^\d+$/.test(words[++i] ?? "")) return false;
      continue;
    }
    if (subcommand === "log" && /^(?:-\d+|-n\d+|--max-count=\d+)$/.test(word)) continue;
    return false;
  }
  return true;
}
