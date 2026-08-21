/**
 * State Manager - Manages chat state
 */

export class StateManager {
  constructor() {
    this.messages = [];
    this.toolExecutions = new Map(); // toolCallId -> tool execution data
    this.isStreaming = false;
    this.currentStreamingMessage = null;
    this.listeners = new Set();
    // Files successfully written by the in-flight agent turn, in first-write
    // order. Settled into the final assistant message at agent_end and used
    // to render the per-turn file chips row.
    this.turnWrites = [];
  }

  addListener(callback) {
    this.listeners.add(callback);
  }

  removeListener(callback) {
    this.listeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach((callback) => {
      callback();
    });
  }

  addMessage(message) {
    this.messages.push(message);
    this.notifyListeners();
  }

  updateLastMessage(updates) {
    if (this.messages.length > 0) {
      const lastMessage = this.messages[this.messages.length - 1];
      Object.assign(lastMessage, updates);
      this.notifyListeners();
    }
  }

  setStreamingMessage(message) {
    this.currentStreamingMessage = message;
    this.notifyListeners();
  }

  clearStreamingMessage() {
    this.currentStreamingMessage = null;
    this.notifyListeners();
  }

  setStreaming(isStreaming) {
    this.isStreaming = isStreaming;
    this.notifyListeners();
  }

  addTurnWrite(filePath) {
    const normalized = String(filePath || "").trim();
    if (!normalized) return;
    if (this.turnWrites.some((entry) => entry.filePath === normalized)) return;
    this.turnWrites.push({ toolCallId: null, filePath: normalized });
  }

  settleTurnWrites() {
    const writes = this.turnWrites.slice();
    this.turnWrites = [];
    return writes;
  }

  addToolExecution(toolCallId, data) {
    this.toolExecutions.set(toolCallId, {
      toolCallId,
      toolName: data.toolName,
      args: data.args,
      status: "pending",
      output: "",
      isError: false,
      ...data,
    });
    this.notifyListeners();
  }

  updateToolExecution(toolCallId, updates) {
    const tool = this.toolExecutions.get(toolCallId);
    if (tool) {
      Object.assign(tool, updates);
      this.notifyListeners();
    }
  }

  getToolExecution(toolCallId) {
    return this.toolExecutions.get(toolCallId);
  }

  getAllToolExecutions() {
    return Array.from(this.toolExecutions.values());
  }

  reset() {
    this.messages = [];
    this.toolExecutions.clear();
    this.isStreaming = false;
    this.currentStreamingMessage = null;
    this.turnWrites = [];
    this.notifyListeners();
  }
}
