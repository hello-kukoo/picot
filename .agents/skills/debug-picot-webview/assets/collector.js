// ABOUTME: Local collector for the Picot WebView diagnostic harness: appends POSTed
// ABOUTME: status lines to a log file the agent can read (run with bun).
const LOG = "/tmp/rail-diag.log";
const PORT = 45799;
Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = await req.text();
    const line = `[${new Date().toISOString()}] ${req.method} ${new URL(req.url).pathname} ${body}\n`;
    await Bun.write(
      Bun.file(LOG),
      (await Bun.file(LOG)
        .text()
        .catch(() => "")) + line,
    );
    return new Response("ok", {
      headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "*" },
    });
  },
});
console.log(`diag collector on ${PORT} -> ${LOG}`);
