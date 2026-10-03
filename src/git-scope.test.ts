import { expect, test } from "bun:test";
import { readOnlyGit } from "./git-scope";
import { localScope } from "./runtime";

test("simple approved Git inspections qualify for Build and Engineer only", () => {
  for (const command of [
    "git status", "git status --short", "git diff --no-ext-diff --no-textconv",
    "git diff --cached --stat", "git diff -- src/runtime.ts", "git log -5 --oneline",
    "git log -n 10", "git log --max-count=10", "git show --no-ext-diff --no-textconv HEAD",
    "git rev-parse --show-toplevel", "git rev-parse --verify HEAD", "git ls-files",
    "git remote -v", "git branch", "git branch --list", "git branch -a",
    "git --no-pager diff --stat", "git --no-optional-locks status --short",
  ]) {
    expect(readOnlyGit(command)).toBe(true);
    for (const agent of ["build", "engineer"]) expect(localScope(command, "/project", "/project", agent)).toBe(true);
    for (const agent of ["plan", "scribe", "unknown"]) expect(localScope(command, "/project", "/project", agent)).toBe(false);
  }
  expect(localScope("git status", "/outside", "/project", "build")).toBe(false);
  // Eligibility is not approval: Eikos must assess sensitive historical reads.
  expect(localScope("git show HEAD:.env", "/project", "/project", "build")).toBe(true);
});

test("mutations, overrides, execution options and shell compositions do not qualify", () => {
  for (const command of [
    "git push", "git fetch", "git add .", "git commit", "git reset", "git checkout main",
    "git branch new-branch", "git branch -D main", "git remote add origin example",
    "git config --list", "git -c alias.status=push status", "git -C /outside status",
    "git --git-dir=/outside status", "git log --output=result", "git diff --output=result",
    "git diff --ext-diff", "git show --textconv HEAD", "git log -n --output=result",
    "git status && git push", "git status; git push", "git status | cat", "git status > result",
    "git status\ngit push", "git show $(touch result)", "git show `touch result`",
    "git diff -- '*.ts'", "env git status", "/usr/bin/git status", "git remote update",
    "gh pr list", "glab issue list", "ghl status",
  ]) {
    expect(readOnlyGit(command)).toBe(false);
    expect(localScope(command, "/project", "/project", "build")).toBe(false);
    expect(localScope(command, "/project", "/project", "engineer")).toBe(false);
  }
  expect(localScope("git push", "/project", "/project", "git")).toBe(true);
});
