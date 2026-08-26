#!/usr/bin/env node
// Deterministic Ollama server for Arcelle's Electron end-to-end tests.
//
// It replays canned responses for the handful of Ollama endpoints the app
// touches, so `npm run e2e` runs with NO real model and NO network. The app is
// pointed at this server via the ARCELLE_OLLAMA_URL env var (see
// Electron's engine-routing base URL).
//
// /api/chat understands the tools offered on each round. It exercises the real
// v3 route instead of pretending the supervisor owns room tools:
//
//   Main agent -> ask_file_agent -> File agent -> search_room -> reports -> Main
//
// Tool-less calls receive a small deterministic answer, which also keeps model
// preflights and command error-path tests local and repeatable.
//
// No dependencies beyond Node's built-in http module.

import http from "node:http";

const PORT = Number(process.env.MOCK_OLLAMA_PORT || 11434);
const MODEL = "qwen3.5:4b"; // matches DEFAULT_MODEL so best_default() selects it

let nextToolCall = 1;
let activeStalls = 0;
let unknownRequests = 0;

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

function toolNames(body) {
  return new Set(
    (Array.isArray(body.tools) ? body.tools : [])
      .map((tool) => tool?.function?.name)
      .filter((name) => typeof name === "string"),
  );
}

function toolCall(res, name, args) {
  return ndjson(res, [
    {
      model: MODEL,
      created_at: new Date().toISOString(),
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: `mock-call-${nextToolCall++}`,
            function: { name, arguments: args },
          },
        ],
      },
      done: true,
      done_reason: "stop",
    },
  ]);
}

function answer(res, content, stream = true) {
  if (!stream) {
    return json(res, {
      model: MODEL,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content },
      done: true,
      done_reason: "stop",
    });
  }
  const midpoint = Math.max(1, Math.floor(content.length / 2));
  return ndjson(res, [
    { model: MODEL, message: { role: "assistant", content: content.slice(0, midpoint) }, done: false },
    { model: MODEL, message: { role: "assistant", content: content.slice(midpoint) }, done: false },
    { model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
  ]);
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "";

  if (req.method === "GET" && url === "/__e2e/stats") {
    return json(res, { activeStalls, unknownRequests });
  }

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

  // GET /api/version — Ollama SDK reachability probe used before agent turns.
  if (req.method === "GET" && url.startsWith("/api/version")) {
    return json(res, { version: "0.0.0-arcelle-e2e" });
  }

  // POST /api/chat — streaming chat with real supervisor/specialist routing.
  if (req.method === "POST" && url.startsWith("/api/chat")) {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const allText = messages
      .map((message) => (typeof message?.content === "string" ? message.content : ""))
      .join("\n");
    const streams = body.stream !== false;
    if (messages.some((message) => typeof message?.content === "string" && message.content.includes("E2E_STALL"))) {
      activeStalls += 1;
      const finish = () => { activeStalls = Math.max(0, activeStalls - 1); };
      req.once("aborted", finish);
      res.once("close", finish);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      return;
    }
    const toolAlreadyRan = messages.some((m) => m && m.role === "tool");
    const offered = toolNames(body);

    // Structured AI actions use Ollama's non-streaming form. The deep double
    // used to answer every request as two NDJSON records, so JSON-mode calls
    // failed with "Extra data" even though the shipping provider contract was
    // fine. Keep one deterministic durable-memory answer for the manual GH #19
    // journey and a plain response for every other structured action.
    if (allText.includes("long-term memory") && allText.includes("durable fact")) {
      return answer(
        res,
        JSON.stringify({
          worth_remembering: true,
          fact: "The manual QA user prefers concise status updates.",
        }),
        streams,
      );
    }

    // Manual GH #28 journey: route a direct File-agent request into a real
    // edit tool so the renderer displays its genuine before/after approval.
    if (allText.includes("E2E_EDIT_APPROVAL") && offered.has("write_file")) {
      if (!toolAlreadyRan) {
        return toolCall(res, "write_file", {
          name: "Note",
          content: "The sky is blue.\nThe approval journey reached the real edit tool.\n",
        });
      }
      return answer(res, "Updated the QA note after approval.", streams);
    }

    if (offered.has("ask_file_agent")) {
      if (!toolAlreadyRan) {
        return toolCall(res, "ask_file_agent", {
          instruction: "Search this room for the Apollo fact and report the exact wording and source file.",
        });
      }
      return answer(res, "According to notes.txt, Apollo landed twelve people on the Moon between 1969 and 1972.", streams);
    }

    if (offered.has("search_room")) {
      if (!toolAlreadyRan) return toolCall(res, "search_room", { query: "Apollo Moon" });
      return answer(
        res,
        "FOUND: Apollo landed twelve people on the Moon between 1969 and 1972. Source: notes.txt.",
        streams,
      );
    }

    return answer(res, "Arcelle deterministic end-to-end model response.", streams);
  }

  // POST /api/show — a model's metadata, WITHOUT loading it. The sidecar's
  // `capabilities()` reads `capabilities` from here and the Settings badges
  // follow; an empty 200 (what the catch-all below used to answer) reads as a
  // model that can do nothing at all, which is a lie about the demo model —
  // the whole smoke test is one round of tool-calling.
  if (req.method === "POST" && url.startsWith("/api/show")) {
    return json(res, {
      capabilities: ["completion", "tools"],
      details: { family: "qwen3", parameter_size: "4B", quantization_level: "Q4_K_M" },
      model_info: { "general.parameter_count": 4_000_000_000, "qwen3.context_length": 32768 },
      parameters: "stop \"<|im_end|>\"",
      template: "{{ .Prompt }}",
    });
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

  // Everything else: harmless empty 200 — but SAID OUT LOUD. A silent `{}` for
  // an endpoint nobody faked is how /api/show came to report a model with no
  // capabilities: the call succeeded, the answer was empty, and nothing in the
  // run mentioned it.
  console.warn(`[mock-ollama] NO FIXTURE for ${req.method} ${url} — answering {}`);
  unknownRequests += 1;
  json(res, {});
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-ollama] listening on http://127.0.0.1:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
