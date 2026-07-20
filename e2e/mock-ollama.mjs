#!/usr/bin/env node
// Mock Ollama server for Arcelle's HLT-8 end-to-end smoke test.
//
// It replays canned responses for the handful of Ollama endpoints the app
// touches, so `npm run e2e` runs with NO real model and NO network. The app is
// pointed at this server via the ARCELLE_OLLAMA_URL env var (see
// src-tauri/src/ollama.rs :: base_url()).
//
// The interesting part is /api/chat: it emulates one round of tool-calling.
//   Round 1 (no prior tool result in the message list): the "model" emits a
//           single `annotate_file` tool call whose quoted text is a verbatim
//           line from e2e/fixtures/notes.txt. The Rust agent loop executes it,
//           producing the 📍 annotation chip.
//   Round 2 (a message with role:"tool" is now present): the "model" streams a
//           final plain-text answer with no further tool calls, ending the loop.
//
// No dependencies beyond Node's built-in http module.

import http from "node:http";

const PORT = Number(process.env.MOCK_OLLAMA_PORT || 11434);
const MODEL = "qwen3.5:4b"; // matches DEFAULT_MODEL so best_default() selects it

// Must be an exact (case-insensitive, whitespace-collapsed) substring of
// e2e/fixtures/notes.txt, or annotate_file rejects it.
const ANNOTATION_QUOTE = "landed twelve people on the Moon";
const ANNOTATION_FILE = "notes.txt";

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function ndjson(res, lines) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const obj of lines) res.write(JSON.stringify(obj) + "\n");
  res.end();
}

function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "";

  // GET /api/tags — model inventory. One model, named to match DEFAULT_MODEL
  // so the app reports AI "running" and picks it as the default.
  if (req.method === "GET" && url.startsWith("/api/tags")) {
    return json(res, {
      models: [
        {
          name: MODEL,
          model: MODEL,
          size: 4_000_000_000,
          digest: "mockmockmock",
          details: { family: "qwen3", parameter_size: "4B", quantization_level: "Q4_K_M" },
        },
      ],
    });
  }

  // POST /api/chat — streaming chat with tool-calling, the demo path.
  if (req.method === "POST" && url.startsWith("/api/chat")) {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolAlreadyRan = messages.some((m) => m && m.role === "tool");

    if (!toolAlreadyRan) {
      // Round 1: emit the annotate_file tool call, then done.
      return ndjson(res, [
        {
          model: MODEL,
          created_at: new Date().toISOString(),
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "annotate_file",
                  arguments: { name: ANNOTATION_FILE, text: ANNOTATION_QUOTE },
                },
              },
            ],
          },
          done: true,
          done_reason: "stop",
        },
      ]);
    }

    // Round 2: stream a final answer (a few deltas) and finish.
    return ndjson(res, [
      { model: MODEL, message: { role: "assistant", content: "According to your files, " }, done: false },
      { model: MODEL, message: { role: "assistant", content: "Apollo landed twelve people on the Moon " }, done: false },
      { model: MODEL, message: { role: "assistant", content: "between 1969 and 1972." }, done: false },
      { model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
    ]);
  }

  // POST /api/generate — used by warm(); the app ignores the body of the reply.
  if (req.method === "POST" && url.startsWith("/api/generate")) {
    return ndjson(res, [{ model: MODEL, response: "", done: true }]);
  }

  // POST /api/embed — not used by the current app, provided for completeness.
  if (req.method === "POST" && url.startsWith("/api/embed")) {
    return json(res, { model: MODEL, embeddings: [[0, 0, 0, 0]] });
  }

  // POST /api/pull, DELETE /api/delete — cheap success so model management
  // never hangs the UI during a test.
  if (url.startsWith("/api/pull")) {
    return ndjson(res, [{ status: "success" }]);
  }
  if (url.startsWith("/api/delete")) {
    return json(res, {});
  }

  // Everything else: harmless empty 200.
  json(res, {});
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-ollama] listening on http://127.0.0.1:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
