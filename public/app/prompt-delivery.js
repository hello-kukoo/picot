// ABOUTME: Composer send delivery records — awaiting → accepted / rejected / unconfirmed.
// ABOUTME: The composer's text and attachments are released only on Pi's correlated acceptance.

/**
 * Delivery state machine for direct composer sends (C3). Each dispatch wraps
 * one correlated runtime_request/response pair:
 *
 *   awaiting ──runtime_response.success──▶ accepted   (release text + images)
 *        │                                          ──success=false──▶ rejected
 *        ├──runtimeError / transport failure──────▶  rejected          (restore text)
 *        └──8000ms without a reply────────────────▶  unconfirmed pill  (never auto-resend;
 *                                                        a late reply settles it)
 *
 * Callbacks stay DOM-free except through the injected handlers, so the whole
 * machine is unit-testable with stub timers.
 */
export function createPromptDelivery({
  send, // (cmd) => { requestId, response: Promise<reply|null> } | null-ish when not connected
  onAccept, // (record, { late }) => void
  onReject, // (record, reason) => void
  onUnconfirmed, // (record) => void
  onRecordsChanged = () => {},
  timeoutMs = 8000,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  const records = new Map(); // requestId -> record

  function settleRecord(requestId, updater) {
    const record = records.get(requestId);
    if (!record) return null;
    if (record.timer) {
      clearTimeoutFn(record.timer);
      record.timer = null;
    }
    updater(record);
    records.delete(requestId);
    onRecordsChanged(record);
    return record;
  }

  function accept(requestId, reply, late = false) {
    const record = settleRecord(requestId, (r) => {
      r.state = "accepted";
    });
    if (record && typeof onAccept === "function") onAccept(record, { late, reply });
  }

  function rejectRecord(requestId, reason) {
    const record = settleRecord(requestId, (r) => {
      r.state = "rejected";
    });
    if (record && typeof onReject === "function") onReject(record, reason || {});
  }

  function markUnconfirmed(requestId) {
    const record = records.get(requestId);
    if (record?.state !== "awaiting") return;
    record.state = "unconfirmed";
    record.timer = null;
    if (typeof onUnconfirmed === "function") onUnconfirmed(record);
    onRecordsChanged(record);
  }

  /**
   * Dispatch one command. `payload` carries what must survive a rejection:
   * the raw composer text (and its exact pre-send value), the captured
   * attachment objects, and the session identity the send belongs to.
   */
  function dispatch(cmd, payload = {}) {
    const record = {
      requestId: null,
      kind: payload.kind || "prompt",
      text: payload.text || "",
      textAtSend: payload.textAtSend ?? payload.text ?? "",
      images: payload.images || [],
      imageSources: payload.imageSources || [],
      sessionIdentity: payload.sessionIdentity || null,
      // Whether a run was streaming when this send was dispatched. A
      // follow-up (or a send racing a run) must never unlock the streaming
      // UI on rejection — that run is not this record's to end.
      streamingAtDispatch: Boolean(payload.streamingAtDispatch),
      state: "awaiting",
      pulledBack: false,
      timer: null,
    };

    let sent = null;
    try {
      sent = typeof send === "function" ? send(cmd) : null;
    } catch (error) {
      sent = { requestId: null, response: Promise.reject(error) };
    }
    if (!sent?.requestId) {
      // Not connected: no frame was sent, so nothing can ever correlate.
      record.state = "rejected";
      if (typeof onReject === "function") onReject(record, { message: "not connected" });
      onRecordsChanged(record);
      return record;
    }

    record.requestId = sent.requestId;
    records.set(record.requestId, record);
    record.timer = setTimeoutFn(() => markUnconfirmed(record.requestId), timeoutMs);
    sent.response.then(
      (reply) => {
        // Only an explicit success envelope is acceptance. A resolved reply
        // that is missing, null, or shape-invalid is NOT a success — treating
        // it as one would clear the composer on a corrupted frame.
        if (reply && reply.success === true) {
          accept(record.requestId, reply, record.pulledBack || record.state === "unconfirmed");
        } else {
          rejectRecord(record.requestId, {
            message: reply?.error || "malformed reply",
          });
        }
      },
      (error) => {
        // A correlated runtime_error (command_undeliverable) rejects the
        // promise with its machine code attached — that is a rejection. The
        // WS-level "timed out" rejection with no runtime_response at all is
        // the never-answered case: keep the unconfirmed pill (never resend).
        const message = error?.message || String(error);
        const isTimeoutOnly = !error?.code && !error?.errorCode && /timed out/i.test(message);
        if (isTimeoutOnly && records.get(record.requestId)?.state === "unconfirmed") {
          const current = records.get(record.requestId);
          if (current?.timer) {
            clearTimeoutFn(current.timer);
            current.timer = null;
          }
          onRecordsChanged(current);
          return;
        }
        rejectRecord(record.requestId, { message, code: error?.code || error?.errorCode });
      },
    );
    onRecordsChanged(record);
    return record;
  }

  /** Correlate a broker `runtimeError` (e.g. command_undeliverable). */
  function rejectByRequestId(requestId, reason) {
    rejectRecord(requestId, reason);
  }

  /**
   * Esc / clear-queue path: pi just handed these texts back, so the matching
   * in-flight records are settled here. Their commands no longer exist at pi,
   * which means neither a late acceptance (which would otherwise wipe the
   * composer because it still equals `textAtSend`) nor an unconfirmed pill may
   * touch the composer again.
   */
  function pullBackTexts(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return 0;
    const returned = new Set(texts.filter((text) => typeof text === "string" && text.trim()));
    if (returned.size === 0) return 0;
    let settled = 0;
    for (const [requestId, record] of [...records]) {
      if (!returned.has(record.text)) continue;
      if (record.timer) {
        clearTimeoutFn(record.timer);
        record.timer = null;
      }
      records.delete(requestId);
      record.pulledBack = true;
      onRecordsChanged(record);
      settled += 1;
    }
    return settled;
  }

  /** Unconfirmed pill click: restore the text without sending. */
  function pullBack(requestId) {
    const record = records.get(requestId);
    if (record?.state !== "unconfirmed") return null;
    record.pulledBack = true;
    return record;
  }

  const hasAwaiting = () => Array.from(records.values()).some((r) => r.state === "awaiting");
  const unconfirmed = () => Array.from(records.values()).filter((r) => r.state === "unconfirmed");
  const get = (requestId) => records.get(requestId) ?? null;

  return { dispatch, rejectByRequestId, pullBack, pullBackTexts, hasAwaiting, unconfirmed, get };
}
