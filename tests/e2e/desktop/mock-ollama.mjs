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
// No dependencies beyond Node built-ins.

import { createHash } from "node:crypto";
import http from "node:http";
import { inflateSync } from "node:zlib";

const PORT = Number(process.env.MOCK_OLLAMA_PORT || 11434);
const MODEL = "qwen3.5:4b"; // matches DEFAULT_MODEL so best_default() selects it
const BLIND_MODEL = "qwen3.5-blind:4b";

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

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function decodePngCenter(base64) {
  const bytes = Buffer.from(base64.replace(/^data:image\/png;base64,/, ""), "base64");
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < signature.length || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("provider image was not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error("provider PNG had a truncated chunk");
    if (type === "IHDR") {
      width = bytes.readUInt32BE(start);
      height = bytes.readUInt32BE(start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      interlace = bytes[start + 12];
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(start, end));
    }
    offset = end + 4;
    if (type === "IEND") break;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!width || !height || bitDepth !== 8 || channels === 0 || interlace !== 0 || idat.length === 0) {
    throw new Error(
      `provider PNG shape unsupported: ${width}x${height}, depth=${bitDepth}, color=${colorType}, interlace=${interlace}`,
    );
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (inflated.length !== height * (stride + 1)) {
    throw new Error(`provider PNG scanline size disagreed: ${inflated.length}`);
  }
  const decoded = Buffer.alloc(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source++];
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[source++];
      const left = x >= channels ? decoded[row + x - channels] : 0;
      const up = y > 0 ? decoded[previous + x] : 0;
      const upLeft = y > 0 && x >= channels ? decoded[previous + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paethPredictor(left, up, upLeft);
      else throw new Error(`provider PNG used unknown filter ${filter}`);
      decoded[row + x] = value & 0xff;
    }
  }
  const center = (Math.floor(height / 2) * stride) + (Math.floor(width / 2) * channels);
  return {
    bytes,
    width,
    height,
    red: decoded[center],
    green: decoded[center + 1],
    blue: decoded[center + 2],
  };
}

function messageImages(messages) {
  return messages.flatMap((message) => Array.isArray(message?.images) ? message.images : [])
    .filter((image) => typeof image === "string" && image.length > 0);
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "";

  if (req.method === "GET" && url === "/__e2e/stats") {
    return json(res, { activeStalls, unknownRequests });
  }

  // GET /api/tags — model inventory. The first model matches DEFAULT_MODEL so
  // the app reports AI "running" and picks it by default. The second keeps tool
  // calling but authoritatively lacks vision, for the live fail-closed test.
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
        {
          name: BLIND_MODEL,
          model: BLIND_MODEL,
          size: 4_000_000_000,
          digest: "mockmockblind",
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

    // ARC-011/024: this is an ordinary-language Main turn, not a direct *video
    // tag. MAIN_OK can only be produced after Main delegates through
    // ask_file_agent, the resolved Video child captures a real frame, this
    // provider independently verifies its PNG, and Main receives that child's
    // PIXELS_OK report for synthesis.
    if (allText.includes("ARC_GOLDEN_VIDEO")) {
      const toolTexts = messages
        .filter((message) => message?.role === "tool" && typeof message.content === "string")
        .map((message) => message.content);
      const verifiedChild = toolTexts.find((content) =>
        content.includes("ARC_GOLDEN_VIDEO_PIXELS_OK"));
      if (verifiedChild) {
        const result = verifiedChild.match(
          /ARC_GOLDEN_VIDEO_PIXELS_OK timestamp=([0-9.]+) sha256=([a-f0-9]{64}) dimensions=(\d+)x(\d+) center=(\d+),(\d+),(\d+)/,
        );
        if (!result) {
          return answer(res, "ARC_GOLDEN_VIDEO_FAIL Main received a malformed child marker", streams);
        }
        return answer(
          res,
          `ARC_GOLDEN_VIDEO_MAIN_OK timestamp=${result[1]} sha256=${result[2]} dimensions=${result[3]}x${result[4]} center=${result[5]},${result[6]},${result[7]}`,
          streams,
        );
      }
      const receipt = messages
        .filter((message) => message?.role === "tool" && typeof message.content === "string")
        .map((message) => message.content)
        .find((content) => content.includes("Frame receipt:"));
      if (!receipt && offered.has("ask_file_agent")) {
        if (toolAlreadyRan) {
          return answer(res, "ARC_GOLDEN_VIDEO_FAIL Main did not receive a verified Video child report", streams);
        }
        return toolCall(res, "ask_file_agent", {
          instruction: "ARC_GOLDEN_VIDEO inspect ARC Golden Video/timestamp-colors.mp4 at 1.05 seconds and report what color fills the visible frame.",
        });
      }
      if (!receipt && offered.has("view_media_frame")) {
        return toolCall(res, "view_media_frame", {
          name: "ARC Golden Video/timestamp-colors.mp4",
          at: "1.05",
        });
      }
      if (!receipt) {
        return answer(
          res,
          "ARC_GOLDEN_VIDEO_FAIL neither Main delegation nor the Video frame tool was offered",
          streams,
        );
      }
      try {
        const images = messageImages(messages);
        if (images.length !== 1) throw new Error(`expected one provider image, received ${images.length}`);
        const frame = decodePngCenter(images[0]);
        const match = receipt.match(
          /at ([0-9.]+)s; SHA-256 ([a-f0-9]{64}); (\d+)×(\d+) PNG/,
        );
        if (!match) throw new Error(`receipt was malformed: ${receipt}`);
        const actualSeconds = Number(match[1]);
        const receiptHash = match[2];
        const receiptWidth = Number(match[3]);
        const receiptHeight = Number(match[4]);
        const actualHash = createHash("sha256").update(frame.bytes).digest("hex");
        if (receiptHash !== actualHash) throw new Error("receipt SHA-256 did not bind the provider PNG");
        if (receiptWidth !== frame.width || receiptHeight !== frame.height) {
          throw new Error(`receipt dimensions ${receiptWidth}x${receiptHeight} did not bind ${frame.width}x${frame.height}`);
        }
        if (frame.width !== 1280 || frame.height !== 720) {
          throw new Error(`expected capped 1280x720 PNG, received ${frame.width}x${frame.height}`);
        }
        if (Math.abs(actualSeconds - 1.05) > 0.35) {
          throw new Error(`presented timestamp ${actualSeconds}s was outside codec tolerance`);
        }
        if (!(frame.red < 60 && frame.green < 60 && frame.blue > 190)) {
          throw new Error(`expected blue pixels at 1.05s, received ${frame.red},${frame.green},${frame.blue}`);
        }
        return answer(
          res,
          `ARC_GOLDEN_VIDEO_PIXELS_OK timestamp=${actualSeconds.toFixed(3)} sha256=${actualHash} dimensions=${frame.width}x${frame.height} center=${frame.red},${frame.green},${frame.blue}`,
          streams,
        );
      } catch (error) {
        return answer(res, `ARC_GOLDEN_VIDEO_FAIL ${error?.message ?? error}`, streams);
      }
    }

    // A model that can call Main's delegation tools but cannot accept images
    // must fail before Video launches. A File child, frame-tool offer, or image
    // payload is an immediate regression rather than a plausible-looking reply.
    if (allText.includes("ARC_BLIND_VIDEO")) {
      const images = messageImages(messages);
      if (images.length > 0) {
        return answer(res, `ARC_BLIND_VIDEO_FAIL received ${images.length} image payload(s)`, streams);
      }
      if (offered.has("view_media_frame")) {
        return answer(res, "ARC_BLIND_VIDEO_FAIL view_media_frame reached the blind model", streams);
      }
      const toolTexts = messages
        .filter((message) => message?.role === "tool" && typeof message.content === "string")
        .map((message) => message.content);
      const refusal = toolTexts.find((content) => content.includes("Video agent cannot inspect"));
      if (refusal) {
        for (const required of [
          "no usable video-image channel",
          "Do not substitute the File agent",
        ]) {
          if (!refusal.includes(required)) {
            return answer(res, `ARC_BLIND_VIDEO_FAIL refusal omitted: ${required}`, streams);
          }
        }
        return answer(res, "ARC_BLIND_VIDEO_REFUSED_OK no-frame no-image no-file-substitution", streams);
      }
      if (toolAlreadyRan) {
        return answer(res, "ARC_BLIND_VIDEO_FAIL delegation returned no Video refusal", streams);
      }
      if (!offered.has("ask_file_agent")) {
        return answer(res, "ARC_BLIND_VIDEO_FAIL Main was not offered ask_file_agent", streams);
      }
      return toolCall(res, "ask_file_agent", {
        instruction: "ARC_BLIND_VIDEO inspect ARC Golden Video/timestamp-colors.mp4 at 1.05 seconds and describe only the visible frame.",
      });
    }

    // ARC-005/023: the live Electron regression asks the Studio specialist to
    // author flashcards. This is the nested structured generation call made by
    // the real Studio tool after the outer agent selected it.
    if (allText.includes("interactive flashcards study page")) {
      return answer(
        res,
        JSON.stringify({
          html: "<!doctype html><html><head><meta charset=\"utf-8\"><title>ARC flashcards</title></head><body><main><h1>ARC flashcards</h1><article><h2>Question</h2><p>What evidence belongs to this room?</p><h2>Answer</h2><p>Only the explicitly attached fixture.</p></article></main></body></html>",
        }),
        streams,
      );
    }

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

    if (
      offered.has("search_room")
      && !offered.has("studio_flashcards")
      && !allText.includes("ARCELLE_ARTIFACT_RECEIPT")
      && !allText.includes("List and exactly read arc-cross-assigned")
    ) {
      if (!toolAlreadyRan) return toolCall(res, "search_room", { query: "Apollo Moon" });
      return answer(
        res,
        "FOUND: Apollo landed twelve people on the Moon between 1969 and 1972. Source: notes.txt.",
        streams,
      );
    }

    if (
      offered.has("studio_flashcards")
      || allText.includes("ARCELLE_ARTIFACT_RECEIPT")
      || allText.includes("*studio Create flashcards from arc-evidence.txt")
    ) {
      const studioResultIndex = messages.findIndex(
        (message) => message?.role === "tool"
          && typeof message.content === "string"
          && message.content.includes("ARCELLE_ARTIFACT_RECEIPT"),
      );
      const studioResult = studioResultIndex >= 0 ? messages[studioResultIndex] : undefined;
      if (!studioResult && offered.has("studio_flashcards")) {
        return toolCall(res, "studio_flashcards", {
          instructions: "Create a small grounded deck and save it.",
          refs: ["arc-evidence.txt"],
        });
      }
      const receipt = typeof studioResult?.content === "string" ? studioResult.content : "";
      const receiptMatch = receipt.match(/ARCELLE_ARTIFACT_RECEIPT\s+(\{[^\n]+\})/);
      let artifactName = "";
      try {
        artifactName = receiptMatch ? String(JSON.parse(receiptMatch[1]).name ?? "") : "";
      } catch {
        artifactName = "";
      }
      const opened = studioResultIndex >= 0 && messages.slice(studioResultIndex + 1).some(
        (message) => message?.role === "tool",
      );
      // The Sidecar's post-write verifier deliberately treats a commit receipt
      // as insufficient proof. Exercise its real correction contract by reading
      // the exact receipt-named file before the model claims Studio succeeded.
      if (artifactName && offered.has("open_file") && !opened) {
        return toolCall(res, "open_file", { name: artifactName });
      }
      return answer(
        res,
        receipt ? `Studio artifact verified. ${receipt}` : "Studio failed: no readable artifact receipt was returned.",
        streams,
      );
    }

    if (allText.includes("List and exactly read arc-cross-assigned")) {
      if (!toolAlreadyRan) return toolCall(res, "list_skills", {});
      const toolText = messages
        .filter((message) => message?.role === "tool" && typeof message.content === "string")
        .map((message) => message.content)
        .join("\n");
      const listed = toolText.includes("arc-cross-assigned");
      const exactlyRead = toolText.includes("# Skill: arc-cross-assigned")
        && toolText.includes("Return the exact cross-assignment marker.");
      if (listed && offered.has("read_skill") && !exactlyRead) {
        return toolCall(res, "read_skill", { skill: "arc-cross-assigned" });
      }
      return answer(
        res,
        listed && exactlyRead
          ? "ARC_SKILL_FOUND:arc-cross-assigned"
          : "ARC_SKILL_MISSING:arc-cross-assigned",
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
    const body = await readBody(req);
    const requestedModel = String(body?.model ?? body?.name ?? "");
    return json(res, {
      capabilities: requestedModel === BLIND_MODEL
        ? ["completion", "tools"]
        : ["completion", "tools", "vision"],
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
