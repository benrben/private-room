import type { OllamaToolSpec } from "./toolSpecsTypes.js";

const COLOR_PROPERTIES = Object.fromEntries(
  ["page", "surface", "surfaceRaised", "ink", "inkStrong", "muted", "accent", "accentLift", "rule", "ruleStrong", "success", "warning", "danger", "info"]
    .map((name) => [name, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }]),
);

/** Typed visual-system tools. The renderer validates the same allow-list again
 * before applying a patch; this schema helps the model produce a small patch,
 * but it is not the security boundary. */
export function skinToolsSpecs(): OllamaToolSpec[] {
  const patch = {
    type: "object",
    additionalProperties: false,
    properties: {
      palette: {
        type: "object",
        additionalProperties: false,
        properties: {
          dark: { type: "object", additionalProperties: false, properties: COLOR_PROPERTIES },
          light: { type: "object", additionalProperties: false, properties: COLOR_PROPERTIES },
        },
      },
      typography: {
        type: "object",
        additionalProperties: false,
        properties: {
          uiFont: { type: "string" }, displayFont: { type: "string" }, userFont: { type: "string" }, monoFont: { type: "string" },
          bodySize: { type: "number", minimum: 11, maximum: 24 },
          scale: { type: "number", minimum: 0.8, maximum: 1.5 },
          lineHeight: { type: "number", minimum: 1.2, maximum: 2 },
          bodyTracking: { type: "number", minimum: -0.04, maximum: 0.12 },
          headingTracking: { type: "number", minimum: -0.08, maximum: 0.08 },
          numericTracking: { type: "number", minimum: -0.08, maximum: 0.08 },
        },
      },
      canvas: {
        type: "object", additionalProperties: false,
        properties: {
          texture: { type: "string", enum: ["off", "dots", "grid"] },
          backdrop: { type: "string", enum: ["solid", "glow", "aurora"] },
          intensity: { type: "number", minimum: 0, maximum: 1 },
          gridGap: { type: "number", minimum: 12, maximum: 40 },
          surfaceOpacity: { type: "number", minimum: 0.35, maximum: 1 },
          blur: { type: "number", minimum: 0, maximum: 40 },
          saturation: { type: "number", minimum: 0.5, maximum: 2 },
          scrollFade: { type: "number", minimum: 0, maximum: 48 },
        },
      },
      shape: {
        type: "object", additionalProperties: false,
        properties: {
          radius: { type: "number", minimum: 0, maximum: 28 },
          borderWidth: { type: "number", minimum: 0, maximum: 3 },
          shadow: { type: "number", minimum: 0, maximum: 1 },
          redrawOffset: { type: "number", minimum: 0, maximum: 6 },
          cornerStyle: { type: "string", enum: ["round", "squircle"] },
        },
      },
      spacing: { type: "object", additionalProperties: false, properties: { scale: { type: "number", minimum: 0.75, maximum: 1.4 } } },
      motion: {
        type: "object", additionalProperties: false,
        properties: {
          speed: { type: "number", minimum: 0.5, maximum: 2 },
          reduce: { type: "boolean" },
          pressScale: { type: "number", minimum: 0.94, maximum: 1 },
          curve: { type: "string", enum: ["calm", "snappy", "spring"] },
          overscroll: { type: "string", enum: ["native", "contained", "none"] },
        },
      },
      accessibility: {
        type: "object", additionalProperties: false,
        properties: {
          transparency: { type: "string", enum: ["system", "reduce", "allow"] },
          contrast: { type: "string", enum: ["system", "more", "normal"] },
        },
      },
      layout: {
        type: "object", additionalProperties: false,
        properties: {
          railWidth: { type: "number", minimum: 52, maximum: 112 },
          sidebarWidth: { type: "number", minimum: 210, maximum: 420 },
          agentWidth: { type: "number", minimum: 280, maximum: 560 },
          paneGap: { type: "number", minimum: 0, maximum: 24 },
        },
      },
    },
  };
  return [
    {
      type: "function",
      function: {
        name: "read_skin",
        description: "Read the active visual skin, collaboration mode, exact draft revision, validation result, and recent attributed changes. Always call this before proposing a skin change.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "update_skin_draft",
        description: "Apply one allow-listed visual-system patch to the live draft. Requires the exact revision returned by read_skin and never saves automatically.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            expected_revision: { type: "integer", minimum: 0 },
            label: { type: "string", description: "Short human-readable description of this change" },
            patch,
          },
          required: ["expected_revision", "label", "patch"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "undo_skin_change",
        description: "Undo the latest skin-draft change. Requires the current revision and respects the collaboration mode.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: { expected_revision: { type: "integer", minimum: 0 } },
          required: ["expected_revision"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "validate_skin",
        description: "Validate the current draft ranges, values, and body-text contrast without changing it.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "save_skin",
        description: "Save and activate the current draft only when the user enabled agent save permission. Requires the current revision.",
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            expected_revision: { type: "integer", minimum: 0 },
            name: { type: "string", description: "Name for the saved skin" },
          },
          required: ["expected_revision", "name"],
        },
      },
    },
  ];
}
