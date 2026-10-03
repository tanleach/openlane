import { sensitive } from "./context";
import { resolve } from "node:path";
import type { inspectActions, FileTool } from "./file-actions";

export class EvidenceUnavailable extends Error {}

// Native executors prepare these diffs before asserting edit permission. Reuse
// that authorized execution context; never independently open target contents.
export function changeEvidence(tool: FileTool, input: unknown, files: Awaited<ReturnType<typeof inspectActions>>, metadata: unknown, directory: string) {
  const rows = (metadata as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(rows) || rows.length !== files.length) throw new EvidenceUnavailable();
  const diffs = rows.map((row, i) => {
    const file = files[i];
    if (!row || typeof row.file !== "string" || typeof row.patch !== "string" || !["added", "modified", "deleted"].includes(row.status)) throw new EvidenceUnavailable();
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(row.patch)) throw new EvidenceUnavailable();
    if (resolve(directory, row.file) !== (file.destination ?? file.path)) throw new EvidenceUnavailable();
    const expectedStatus = file.operation === "delete" ? "deleted" : file.operation === "create" || (tool === "patch" && file.operation === "overwrite") ? "added" : "modified";
    if (row.status !== expectedStatus) throw new EvidenceUnavailable();
    // Patch Add treats an existing file as empty, and move diffs omit the
    // destination preimage. Neither supports a complete overwrite assessment.
    if ((tool === "patch" && file.operation === "overwrite") || file.destinationExisted) throw new EvidenceUnavailable();
    return { path: file.path, destination: file.destination, status: row.status, diff: row.patch };
  });
  // The exact scalar input preserves indentation which native patch previews may
  // normalize. Reject unexpected fields instead of forwarding arbitrary metadata.
  const value = input as Record<string, unknown>;
  const proposed = tool === "patch" ? { patchText: value.patchText } : tool === "write" ? { path: value.path, content: value.content } :
    { path: value.path, oldString: value.oldString, newString: value.newString, replaceAll: value.replaceAll === true };
  const evidence = { proposed, diffs };
  const text = JSON.stringify(evidence);
  if (text.length > 24_000 || sensitive(text)) throw new EvidenceUnavailable();
  return evidence;
}
