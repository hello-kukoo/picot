// ABOUTME: Sends owner-scoped Git host requests with workspace-generation binding.
// ABOUTME: Correlates replies and clears pending requests when the workspace changes.

export class GitClient {
  constructor({ send, timeoutMs = 10000 } = {}) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.generation = null;
    this.counter = 0;
    this.pending = new Map();
    this.pendingWrites = new Set();
    this.pendingPushes = new Set();
  }
  setWorkspaceGeneration(value) {
    const generation = Number(value);
    if (!Number.isSafeInteger(generation) || generation < 0) return false;
    if (this.generation !== null && this.generation !== generation) this.reset();
    this.generation = generation;
    return true;
  }
  command(payload = {}, operation = null) {
    if (this.generation === null) return null;
    const requestId = `git-${++this.counter}`;
    const type = operation || payload.type;
    if (typeof type !== "string" || !type) return null;
    const args = { ...payload };
    delete args.type;
    const operationName = type.startsWith("git_") ? type : `git_${type}`;
    this.send?.({
      type: "host_request",
      protocolVersion: 2,
      requestId,
      operation: operationName,
      workspaceGeneration: this.generation,
      args,
    });
    return requestId;
  }
  diff(snapshotId, group, pathBytesBase64, comparison) {
    return this.command({ type: "diff", snapshotId, group, pathBytesBase64, comparison });
  }
  log(limit = 50, before = null) {
    return this.command({ type: "log", limit, before });
  }
  logDetail(oid) {
    return this.command({ type: "log_detail", oid });
  }
  commitDiff(commitOid, pathBytesBase64) {
    return this.command({ type: "commit_diff", commitOid, pathBytesBase64 });
  }
  write(operation, snapshotId, entries) {
    const requestId = this.command({ type: operation, snapshotId, entries });
    if (requestId) this.pendingWrites.add(requestId);
    return requestId;
  }
  consumeWriteAck(message) {
    if (message?.workspaceGeneration !== this.generation) return false;
    const requestId = message?.requestId;
    if (!this.pendingWrites.has(requestId)) return false;
    this.pendingWrites.delete(requestId);
    return true;
  }
  consumeWriteFailure(message) {
    if (message?.workspaceGeneration !== this.generation) return false;
    return this.pendingWrites.delete(message?.requestId);
  }
  aiCommitMessage() {
    return this.command({}, "git_ai_commit_message");
  }
  push() {
    const requestId = this.command({ type: "push" });
    if (requestId) this.pendingPushes.add(requestId);
    return requestId;
  }
  consumePushOutcome(message) {
    if (message?.workspaceGeneration !== this.generation) return false;
    return this.pendingPushes.delete(message?.requestId);
  }
  commit(snapshotId, message, confirmationToken = null) {
    return this.command({ type: "commit", snapshotId, message, confirmationToken });
  }
  sendAndAwait(payload, matcher = null, timeoutMs = this.timeoutMs) {
    if (this.generation === null) return Promise.resolve(null);
    const type = payload?.type;
    if (typeof type !== "string" || !type) return Promise.resolve(null);
    const requestId = `git-${++this.counter}`;
    const promise = this._await(
      requestId,
      matcher || ((message) => message?.requestId === requestId),
      timeoutMs,
    );
    const args = { ...payload };
    delete args.type;
    const operationName =
      typeof type === "string" && type.startsWith("git_") ? type : `git_${type}`;
    this.send?.({
      type: "host_request",
      protocolVersion: 2,
      requestId,
      operation: operationName,
      workspaceGeneration: this.generation,
      args,
    });
    return promise;
  }
  _await(requestId, matcher, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(requestId, {
        matcher,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }
  resolveResponse(message) {
    const entry = this.pending.get(message?.requestId);
    if (!entry?.matcher(message)) return false;
    this.pending.delete(message.requestId);
    entry.resolve(message);
    return true;
  }
  reset() {
    for (const entry of this.pending.values()) entry.resolve(null);
    this.pending.clear();
    this.pendingWrites.clear();
    this.pendingPushes.clear();
    this.generation = null;
  }
}
