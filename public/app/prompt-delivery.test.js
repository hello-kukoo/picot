import { describe, expect, test, vi } from "vitest";
import { createPromptDelivery } from "./prompt-delivery.js";

function makeHarness({ timeoutMs = 8000 } = {}) {
  const callbacks = {
    accept: vi.fn(),
    reject: vi.fn(),
    unconfirmed: vi.fn(),
    changed: vi.fn(),
  };
  let pending = null; // { resolve, reject }
  const send = vi.fn(() => {
    let resolve;
    let reject;
    const response = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending = { resolve, reject };
    return { requestId: "req-1", response };
  });

  const timers = new Map();
  let now = 0;
  const setTimeoutFn = (fn, ms) => {
    const id = timers.size + 1;
    timers.set(id, { fn, at: now + ms });
    return id;
  };
  const clearTimeoutFn = (id) => timers.delete(id);
  const advance = (ms) => {
    now += ms;
    for (const [id, entry] of [...timers]) {
      if (entry.at <= now) {
        timers.delete(id);
        entry.fn();
      }
    }
  };
  // Promise callbacks land on microtasks; flush twice so then-handlers (and
  // their synchronous callback chains) have run before assertions.
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const delivery = createPromptDelivery({
    send,
    onAccept: callbacks.accept,
    onReject: callbacks.reject,
    onUnconfirmed: callbacks.unconfirmed,
    onRecordsChanged: callbacks.changed,
    timeoutMs,
    setTimeoutFn,
    clearTimeoutFn,
  });

  return { delivery, callbacks, send, getPending: () => pending, advance, flush };
}

const CMD = { type: "prompt", message: "hi" };

describe("createPromptDelivery", () => {
  test("success acceptance fires onAccept; failure fires onReject", async () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "hi" });
    h.getPending().resolve({ success: true });
    await h.flush();
    expect(h.callbacks.accept).toHaveBeenCalledOnce();
    expect(h.callbacks.accept.mock.calls[0][1]).toEqual({ late: false, reply: { success: true } });

    const h2 = makeHarness();
    h2.delivery.dispatch(CMD, { text: "hi" });
    h2.getPending().resolve({ success: false, error: "no route" });
    await h2.flush();
    expect(h2.callbacks.reject).toHaveBeenCalledOnce();
    expect(h2.callbacks.reject.mock.calls[0][1]).toEqual({ message: "no route" });
  });

  test("pullBackTexts settles the matching record so its reply cannot touch the composer", async () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "queued steer" });
    expect(h.delivery.hasAwaiting()).toBe(true);

    expect(h.delivery.pullBackTexts(["queued steer"])).toBe(1);
    // The record is gone: no awaiting state, no pill, no pending timer.
    expect(h.delivery.hasAwaiting()).toBe(false);
    expect(h.delivery.get("req-1")).toBe(null);
    expect(h.delivery.unconfirmed()).toHaveLength(0);

    // pi's acceptance still arrives, but it must be ignored: the text is
    // already back in the composer, so clearing it would lose it.
    h.getPending().resolve({ success: true });
    await h.flush();
    expect(h.callbacks.accept).not.toHaveBeenCalled();
    h.advance(8000);
    expect(h.callbacks.unconfirmed).not.toHaveBeenCalled();
  });

  test("pullBackTexts ignores non-matching and empty input", async () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "kept" });

    expect(h.delivery.pullBackTexts(["other"])).toBe(0);
    expect(h.delivery.pullBackTexts([])).toBe(0);
    expect(h.delivery.pullBackTexts(null)).toBe(0);
    expect(h.delivery.pullBackTexts(["   "])).toBe(0);
    // The unmatched record stays live and still settles normally.
    expect(h.delivery.hasAwaiting()).toBe(true);
    h.getPending().resolve({ success: true });
    await h.flush();
    expect(h.callbacks.accept).toHaveBeenCalledOnce();
  });

  test("the record hands the captured images and sources to the callbacks", async () => {
    // C3 owns attachment ownership: acceptance may consume exactly the captured
    // set, rejection must hand the same set back. Nothing else pins this.
    const images = [{ type: "image", data: "AAA", mimeType: "image/png" }];
    const imageSources = [{ data: "AAA", mimeType: "image/png" }];

    const accepted = makeHarness();
    accepted.delivery.dispatch(
      { type: "prompt", message: "hi", images },
      { text: "hi", images, imageSources },
    );
    accepted.getPending().resolve({ success: true });
    await accepted.flush();
    const [acceptRecord] = accepted.callbacks.accept.mock.calls[0];
    expect(acceptRecord.images).toEqual(images);
    expect(acceptRecord.imageSources).toEqual(imageSources);

    const rejected = makeHarness();
    rejected.delivery.dispatch(
      { type: "prompt", message: "hi", images },
      { text: "hi", images, imageSources },
    );
    rejected.getPending().resolve({ success: false, error: "nope" });
    await rejected.flush();
    const [rejectRecord] = rejected.callbacks.reject.mock.calls[0];
    expect(rejectRecord.images).toEqual(images);
    expect(rejectRecord.imageSources).toEqual(imageSources);
  });

  test("pullBackTexts also settles an unconfirmed record (Esc while its pill shows)", async () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "pill text" });
    h.advance(8000);
    expect(h.delivery.unconfirmed()).toHaveLength(1);

    expect(h.delivery.pullBackTexts(["pill text"])).toBe(1);
    expect(h.delivery.unconfirmed()).toHaveLength(0);
    expect(h.delivery.get("req-1")).toBe(null);

    // A late reply for a settled record must not reach the composer code.
    h.getPending().resolve({ success: true });
    await h.flush();
    expect(h.callbacks.accept).not.toHaveBeenCalled();
  });

  test("a malformed or missing success reply rejects, never accepts", async () => {
    // Regression: only reply.success === true is acceptance. Undefined,
    // null, shape-invalid, or truthy-but-not-true replies must reject so a
    // corrupted frame can never clear the composer.
    const cases = [
      undefined,
      null,
      {},
      { success: undefined },
      { data: "looks fine" },
      { success: "true" },
      { success: 1 },
    ];
    for (const reply of cases) {
      const h = makeHarness();
      h.delivery.dispatch(CMD, { text: "hi" });
      h.getPending().resolve(reply);
      await h.flush();
      expect(h.callbacks.accept).not.toHaveBeenCalled();
      expect(h.callbacks.reject).toHaveBeenCalledOnce();
      expect(h.callbacks.reject.mock.calls[0][1].message).toBe("malformed reply");
    }
  });

  test("requestId correlation: dispatch records carry the send requestId", async () => {
    const h = makeHarness();
    const record = h.delivery.dispatch(CMD, { text: "hi" });
    expect(record.requestId).toBe("req-1");
    expect(h.delivery.get("req-1")).toBe(record);
    h.getPending().resolve({ success: true });
    await h.flush();
    expect(h.delivery.get("req-1")).toBeNull(); // record removed on settle
  });

  test("8000ms without a reply moves the record to unconfirmed; never auto-resends", () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "hi" });
    h.advance(7999);
    expect(h.callbacks.unconfirmed).not.toHaveBeenCalled();
    h.advance(1);
    expect(h.callbacks.unconfirmed).toHaveBeenCalledOnce();
    expect(h.delivery.unconfirmed()).toHaveLength(1);
    expect(h.send).toHaveBeenCalledOnce(); // no auto-resend
  });

  test("late success after unconfirmed settles as late acceptance", async () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "hi" });
    h.advance(8000);
    h.getPending().resolve({ success: true });
    await h.flush();
    expect(h.callbacks.accept).toHaveBeenCalledOnce();
    expect(h.callbacks.accept.mock.calls[0][1].late).toBe(true);
    expect(h.delivery.unconfirmed()).toHaveLength(0);
  });

  test("late rejection after unconfirmed follows the rejection path", async () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "hi" });
    h.advance(8000);
    h.getPending().reject(new Error("command_undeliverable"));
    await h.flush();
    expect(h.callbacks.reject).toHaveBeenCalledOnce();
    expect(h.delivery.unconfirmed()).toHaveLength(0);
  });

  test("transport timeout with no reply keeps the unconfirmed pill", async () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "hi" });
    h.advance(8000); // → unconfirmed
    h.getPending().reject(new Error("Runtime command timed out"));
    await h.flush();
    // No runtime_response ever arrived: the pill stays; nothing rejects.
    expect(h.callbacks.reject).not.toHaveBeenCalled();
    expect(h.delivery.unconfirmed()).toHaveLength(1);
  });

  test("pullBack marks the record so a late accept cannot clear the composer", async () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "hi" });
    h.advance(8000);
    const record = h.delivery.pullBack("req-1");
    expect(record.pulledBack).toBe(true);
    h.getPending().resolve({ success: true });
    await h.flush();
    expect(h.callbacks.accept.mock.calls[0][1].late).toBe(true);
  });

  test("rejectByRequestId settles a broker runtimeError correlation", () => {
    const h = makeHarness();
    h.delivery.dispatch(CMD, { text: "hi" });
    h.delivery.rejectByRequestId("req-1", { code: "command_undeliverable", message: "no route" });
    expect(h.callbacks.reject).toHaveBeenCalledOnce();
    expect(h.delivery.get("req-1")).toBeNull();
  });

  test("not connected rejects immediately without a record", () => {
    const callbacks = { accept: vi.fn(), reject: vi.fn(), unconfirmed: vi.fn(), changed: vi.fn() };
    const delivery = createPromptDelivery({
      send: () => ({ requestId: null, response: Promise.resolve(null) }),
      onAccept: callbacks.accept,
      onReject: callbacks.reject,
      onUnconfirmed: callbacks.unconfirmed,
      onRecordsChanged: callbacks.changed,
    });
    const record = delivery.dispatch(CMD, { text: "hi" });
    expect(record.state).toBe("rejected");
    expect(callbacks.reject).toHaveBeenCalledOnce();
  });

  test("hasAwaiting tracks the awaiting window", async () => {
    const h = makeHarness();
    expect(h.delivery.hasAwaiting()).toBe(false);
    h.delivery.dispatch(CMD, { text: "hi" });
    expect(h.delivery.hasAwaiting()).toBe(true);
    h.getPending().resolve({ success: true });
    await h.flush();
    expect(h.delivery.hasAwaiting()).toBe(false);
  });
});
