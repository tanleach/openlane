import { Patch } from "@opencode/util/patch";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readPolicy } from "./policy";

export type FileTool = "patch" | "edit" | "write";
export type Operation = "create" | "edit" | "delete" | "move" | "overwrite" | "batch" | "read";
export type FileAction = { operation: Operation; path: string; destination?: string; added: number; removed: number };
export class FileGuardError extends Error {
  constructor(readonly reason: "protected_path" | "unsafe_path" | "unsupported_input") { super(`Eikos file guard: ${reason}`); }
}

// Standalone protection; host permissions remain separate.
// OpenCode's wildcard resources use * across slashes, not filesystem glob semantics.
const rules = readPolicy.map((r) => ({
  effect: r.effect,
  pattern: new RegExp(`^${r.pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`),
}));
export function protectedPath(path: string) {
  let denied = false;
  for (const rule of rules) if (rule.pattern.test(path)) denied = rule.effect === "deny";
  return denied;
}

export function fileActions(tool: FileTool, input: unknown): FileAction[] {
  if (!input || typeof input !== "object") throw new FileGuardError("unsupported_input");
  const value = input as Record<string, unknown>;
  if (tool === "patch") {
    if (typeof value.patchText !== "string" || value.patchText.length > 128_000) throw new FileGuardError("unsupported_input");
    const result = Patch.parse(value.patchText);
    if (!("success" in result) || !result.success.length || result.success.length > 64) throw new FileGuardError("unsupported_input");
    return result.success.map((h) => ({
      operation: h.type === "add" ? "create" : h.type === "delete" ? "delete" : h.movePath ? "move" : "edit",
      path: h.path,
      ...(h.type === "update" && h.movePath ? { destination: h.movePath } : {}),
      added: h.type === "add" ? h.contents.length : h.type === "update" ? h.chunks.reduce((n, c) => n + c.newLines.join("\n").length, 0) : 0,
      removed: h.type === "update" ? h.chunks.reduce((n, c) => n + c.oldLines.join("\n").length, 0) : 0,
    }));
  }
  if (typeof value.path !== "string") throw new FileGuardError("unsupported_input");
  if (tool === "write" && typeof value.content === "string") {
    return [{ operation: "create", path: value.path, added: value.content.length, removed: 0 }];
  }
  if (tool === "edit" && typeof value.oldString === "string" && typeof value.newString === "string") {
    return [{ operation: "edit", path: value.path, added: value.newString.length, removed: value.oldString.length }];
  }
  throw new FileGuardError("unsupported_input");
}

export function inProject(path: string, directory: string) {
  const part = relative(directory, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

// Metadata only: NEVER open/read targets. Reject symlinks in any component,
// special files and hard-linked files. This is conservative, not a race-proof sandbox.
export async function inspectPath(path: string, directory: string) {
  if (!path || /[\x00-\x1f]/.test(path) || path.startsWith("~")) throw new FileGuardError("unsafe_path");
  const absolute = resolve(directory, path);
  if (protectedPath(path) || protectedPath(absolute)) throw new FileGuardError("protected_path");
  const parts = absolute.split(sep).filter(Boolean);
  const state: unknown[] = [];
  let current = "/";
  let exists = false;
  let bytes = 0;
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    let info;
    try { info = await lstat(current, { bigint: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new FileGuardError("unsafe_path");
      state.push([current, "absent"]);
      break;
    }
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink > 1n)) throw new FileGuardError("unsafe_path");
    if (i < parts.length - 1 && !info.isDirectory()) throw new FileGuardError("unsafe_path");
    // Ancestor identity/mode, not mtime: unrelated sibling writes aren't stale actions.
    state.push([current, String(info.dev), String(info.ino), String(info.mode), ...(i === parts.length - 1 ? [String(info.size), String(info.mtimeNs), String(info.ctimeNs)] : [])]);
    if (i === parts.length - 1) {
      if (!info.isFile()) throw new FileGuardError("unsafe_path");
      exists = true;
      bytes = Number(info.size);
    }
  }
  return { absolute, exists, bytes, fingerprint: JSON.stringify(state) };
}

export async function inspectActions(actions: FileAction[], directory: string) {
  const files = [];
  for (const action of actions) {
    const source = await inspectPath(action.path, directory);
    const destination = action.destination ? await inspectPath(action.destination, directory) : undefined;
    files.push({
      ...action, path: source.absolute, ...(destination ? { destination: destination.absolute } : {}),
      operation: action.operation === "create" && source.exists ? "overwrite" as const : action.operation,
      existed: source.exists, destinationExisted: destination?.exists,
      bytes: source.bytes, destinationBytes: destination?.bytes,
      fingerprint: source.fingerprint, destinationFingerprint: destination?.fingerprint,
    });
  }
  return files;
}
