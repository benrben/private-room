import type { OllamaToolSpec } from "./toolSpecsTypes.js";

export function mediaToolsSpecs(): OllamaToolSpec[] {
  return uiToolsSpecs().filter((s) => s.function.name === "view_media_frame");
}

/**
 * Wave 1a: the model `local_generate` runs on. Ported verbatim from
 * `resolve_local_generate_model`. `runsOnThisMac`/`bestLocalDefault` are
 * injected — the model-capability/Ollama-registry lookups they wrap are a
 * separate, not-yet-ported system (`ollama.rs`).
 */
export function resolveLocalGenerateModel(
  explicit: string | undefined,
  models: readonly string[],
  runsOnThisMac: (model: string) => boolean,
  bestLocalDefault: (models: readonly string[]) => string
): string {
  if (explicit !== undefined && runsOnThisMac(explicit)) {
    return explicit;
  }
  return bestLocalDefault(models);
}

/**
 * BROWSE-2 (D17): the download/save tools. Ported verbatim from
 * `download_tools_specs`.
 */
export function downloadToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "save_link",
        description:
          "Save a web page into this room as a readable Markdown file (title, source URL, readable text). A YouTube link saves the video's transcript instead. Use when the user asks to save, keep or bookmark a link.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Full http(s) URL" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "download_url",
        description:
          "Download the file at a URL (PDF, CSV, image, archive, …) into this room. Up to 64 MB arrives immediately; a bigger file continues as a background job — report the job id and track it with job_status. Not for web pages (save_link) or videos on streaming sites (download_media).",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Full http(s) URL of the file" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "download_media",
        description:
          "Download the video/audio from a media page (YouTube and most video sites) into this room as a background job. Returns the job id — track it with job_status. After it arrives the file is transcribed on this Mac with speakers separated; that is a second pass, so the transcript appears on the file some minutes after the job ends, and not at all if no speech model is installed.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Full http(s) URL of the video page" } },
          required: ["url"],
        },
      },
    },
  ];
}

/** ADD-25: the UI/perception tool specs. Ported verbatim from
 * `ui_tools_specs`. */
export function uiToolsSpecs(): OllamaToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "ui_snapshot",
        description:
          "List every clickable/typable control currently visible in the app as numbered marks (role, label, region). Call this FIRST when asked to open or use an app surface — the Room Map (the Map toggle), the Memory panel, Studio buttons (Flashcards, Mind map, Podcast script), a viewer tab, or History. Those are app controls, NOT files: never search_room for them. Take a fresh snapshot before each ui_act — marks go stale when the screen changes. Consent-sensitive controls (settings, approvals) are never listed.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "ui_act",
        description:
          'Operate one control from the latest ui_snapshot by its mark number. The user watches every action. Example: {"mark": 12, "action": "click"}',
        parameters: {
          type: "object",
          properties: {
            mark: { type: "integer", description: "Mark number from the latest ui_snapshot" },
            action: {
              type: "string",
              enum: ["click", "type", "set", "scroll"],
              description:
                "click a control; type appends text into a field; set replaces the field's text; scroll moves the element's pane (text: \"up\" or \"down\")",
            },
            text: {
              type: "string",
              description: 'For type/set: the text. For scroll: "up" or "down".',
            },
          },
          required: ["mark", "action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "view_screenshot",
        description:
          "Capture what the user currently sees in the app window and look at it. Use when the words in the transcript aren't enough and you need the actual pixels (layout, an open image or PDF page, a chart).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "view_media_frame",
        description:
          'Grab one frame from a video file in the room at a timestamp and look at it. Pair with the transcript\'s [m:ss] stamps to inspect the exact moment. Example: {"name": "lecture.mp4", "at": "12:34"}',
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Video file name or a distinctive part of it" },
            at: {
              type: "string",
              description:
                'Timestamp like "1:23" or "1:02:03", or plain seconds like "75"',
            },
          },
          required: ["name", "at"],
        },
      },
    },
  ];
}

/**
 * PRIV-4: the refusal a URL-taking tool owes the model when the address
 * itself carries a protected name, or `null` when it carries none. Ported
 * verbatim from `outbound_url_refusal`. `outboundUrlHides` is injected — the
 * room's protected-name scan (`privacy.rs`) is a separate, not-yet-ported
 * system; a real implementation is TODO for that future privacy batch.
 */
export function outboundUrlRefusal(
  url: string,
  outboundUrlHides: (url: string) => number | null
): string | null {
  const hidden = outboundUrlHides(url);
  if (hidden === null) {
    return null;
  }
  return (
    `Not fetched: this URL carries ${hidden} protected name(s) from this room's block list, ` +
    `and Cloud privacy is on, so it must not leave this Mac (Settings → Cloud privacy). ` +
    `Tell the user rather than retrying.`
  );
}

// -------------------------------------------------------- outbound-arg masking

/**
 * Whether one connector call's arguments get masked on the way out. Ported
 * verbatim from `masks_outbound_args`.
 */
export function masksOutboundArgs(remote: boolean, unmaskOutbound: boolean): boolean {
  return remote && !unmaskOutbound;
}

/**
 * What to tell the agent when the outbound seam actually rewrote something.
 * Ported verbatim from `masked_args_note`, including its exact wording.
 */
export function maskedArgsNote(server: string, entitiesHidden: number): string | null {
  if (entitiesHidden === 0) {
    return null;
  }
  const n = entitiesHidden;
  const plural = n === 1 ? "value" : "values";
  return (
    `\n\n[This room hid ${n} protected ${plural} in what it sent, so "${server}" was asked ` +
    `about placeholders, not the real text. If the answer above is empty or off-target, ` +
    `that is very likely why — tell the user, and that Connectors → "Send remote ` +
    `connectors real values" is what would send the real ones.]`
  );
}
