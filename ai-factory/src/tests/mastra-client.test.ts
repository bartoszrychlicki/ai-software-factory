import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { MastraWorkflowClient } from "../sources/mastra-client";

test("klient używa nieblokujących tras sterujących i sprawdza HTTP", async () => {
  const requests: { method?: string; url?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      if (req.url?.endsWith("/create-run")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ runId: "r/1" }));
      } else if (req.url?.includes("/runs/r%2F1") && req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "suspended" }));
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: "ok" }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new MastraWorkflowClient(`http://127.0.0.1:${address.port}/api`, "ticketPipeline");
  try {
    const runId = await client.createRun();
    await client.startRun(runId, { id: "T-1" });
    await client.resumeRun(runId, ["nested", "gate"], { approved: true });
    await client.getRun(runId);
    await client.cancelRun(runId);
  } finally {
    server.close();
    await once(server, "close");
  }

  assert.ok(requests.some((r) => r.url?.includes("/start?runId=r%2F1")));
  assert.ok(requests.some((r) => r.url?.includes("/resume-no-wait?runId=r%2F1")));
  assert.ok(requests.some((r) => r.url?.endsWith("/runs/r%2F1/cancel")));
  assert.ok(requests.every((r) => !r.url?.includes("start-async") && !r.url?.includes("resume-async")));
});

test("odpowiedź HTTP spoza 2xx jest błędem, nie cichym sukcesem", async () => {
  const server = createServer((_req, res) => { res.statusCode = 503; res.end("offline"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new MastraWorkflowClient(`http://127.0.0.1:${address.port}/api`, "ticketPipeline");
  try {
    await assert.rejects(client.startRun("r", {}), /Mastra HTTP 503/);
  } finally {
    server.close();
    await once(server, "close");
  }
});
