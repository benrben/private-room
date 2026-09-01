import { useEffect, useMemo, useState } from "react";
import { api, formatSize } from "../api";
import type { PrivacyPreview } from "../apiTypes";

type CloudPart = { text: string; mark: boolean };

type CloudPreviewState = {
  preview: PrivacyPreview | null;
  doorOn: boolean | null;
  error: string | null;
};

/** Wire size of the text a cloud model would receive, in BYTES.
 *
 * It used to count JavaScript string length — UTF-16 code units — and call the
 * result KB. Every non-Latin script pays 2–3 bytes per character in UTF-8, so a
 * Hebrew, Arabic, Russian or Chinese document shown as "40 KB" was really 80 KB
 * or more. This screen exists to be believed about what leaves the Mac, so the
 * headline number is measured, not guessed. Still "~": the sentence that
 * actually travels is this text inside a request, not this text alone. */
function encodedSize(text: string): string {
  return `~${formatSize(new TextEncoder().encode(text).length)}`;
}

/** PRIV-1 — the reader's "blocked version": this file's text exactly as a
 * non-local model receives it, placeholders and all. Seeing the door's output
 * with your own eyes is the trust mechanism — no AI judgment to believe, just
 * text to read. It also states the door state (protected vs raw) and the
 * estimated size, so the preview never *looks* protected when the door is off. */
export default function CloudView({ fileId }: { fileId: string }) {
  const state = useCloudPreview(fileId);
  const parts = useMemo(() => cloudParts(state.preview), [state.preview]);

  if (state.error) {
    return <div className="cloudview-empty">Could not build the cloud view: {state.error}</div>;
  }
  if (!state.preview) {
    return <div className="cloudview-empty">Preparing the cloud view…</div>;
  }
  return <CloudPayload doorOn={state.doorOn} parts={parts} preview={state.preview} />;
}

function useCloudPreview(fileId: string): CloudPreviewState {
  const [preview, setPreview] = useState<PrivacyPreview | null>(null);
  const [doorOn, setDoorOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    api
      .privacyPreview(fileId)
      .then((nextPreview) => {
        if (live) setPreview(nextPreview);
      })
      .catch((nextError) => {
        if (live) setError(String(nextError));
      });
    api
      .privacyStatus()
      .then((status) => {
        if (live) setDoorOn(status.effectiveOn);
      })
      .catch(() => {
        if (live) setDoorOn(null);
      });
    return () => {
      live = false;
    };
  }, [fileId]);

  return { preview, doorOn, error };
}

/** Split the redacted text on the placeholders present so each shows as a
 * blackout chip. Longest-first so "[Person AB]" never splits on "[Person A]". */
function cloudParts(preview: PrivacyPreview | null): CloudPart[] {
  if (!preview) return [];
  const placeholders = sortedPlaceholders(preview.present);
  if (placeholders.length === 0) return [{ text: preview.text, mark: false }];
  return placeholderParts(preview, placeholders);
}

function sortedPlaceholders(placeholders: string[]): string[] {
  return [...placeholders].sort((left, right) => right.length - left.length);
}

function placeholderParts(preview: PrivacyPreview, placeholders: string[]): CloudPart[] {
  const expression = new RegExp(`(${placeholders.map(escapePlaceholder).join("|")})`, "g");
  return preview.text
    .split(expression)
    .filter((segment) => segment !== "")
    .map((text) => ({ text, mark: preview.present.includes(text) }));
}

function escapePlaceholder(placeholder: string): string {
  return placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function CloudPayload({
  doorOn,
  parts,
  preview,
}: {
  doorOn: boolean | null;
  parts: CloudPart[];
  preview: PrivacyPreview;
}) {
  const raw = doorOn === false;
  return (
    <div className={`cloudview${raw ? " cloudview-raw" : ""}`}>
      <CloudPayloadHead raw={raw} size={encodedSize(preview.text)} />
      <CloudPayloadRibbon preview={preview} raw={raw} />
      <CloudPayloadText parts={parts} raw={raw} />
    </div>
  );
}

function CloudPayloadHead({ raw, size }: { raw: boolean; size: string }) {
  return (
    <div className="cloudview-head">
      <span className={`cloudview-badge ${raw ? "danger" : "protected"}`}>
        {raw ? "Raw cloud payload" : "Protected cloud payload"}
      </span>
      <span className="cloudview-size">{size}</span>
    </div>
  );
}

function CloudPayloadRibbon({
  preview,
  raw,
}: {
  preview: PrivacyPreview;
  raw: boolean;
}) {
  if (raw) return <RawPayloadRibbon preview={preview} />;
  if (preview.replacements > 0) return <ProtectedPayloadRibbon preview={preview} />;
  return <div className="cloudview-ribbon" role="status">This is exactly what a cloud model receives — nothing here is marked private.</div>;
}

function RawPayloadRibbon({ preview }: { preview: PrivacyPreview }) {
  return (
    <div className="cloudview-ribbon" role="status">
      The privacy door is <b>OFF</b> for this room, so a cloud model receives this file's <b>real content</b> — full names and details.
      <RawHiddenExplanation preview={preview} />
    </div>
  );
}

function RawHiddenExplanation({ preview }: { preview: PrivacyPreview }) {
  if (preview.replacements === 0) return null;
  return (
    <>
      {" "}
      The {preview.entitiesHidden} highlighted item
      {preview.entitiesHidden === 1 ? "" : "s"} below (shown as placeholders) would be hidden if you turned protection on in Settings → Cloud privacy; right now their real values leave instead.
    </>
  );
}

function ProtectedPayloadRibbon({ preview }: { preview: PrivacyPreview }) {
  return (
    <div className="cloudview-ribbon" role="status">
      This is exactly what a cloud model receives —{" "}
      <b>
        {preview.replacements} mention
        {preview.replacements === 1 ? "" : "s"} of{" "}
        {preview.entitiesHidden} private detail
        {preview.entitiesHidden === 1 ? "" : "s"}
      </b>{" "}
      {preview.replacements === 1 ? "stays" : "stay"} on this Mac.
    </div>
  );
}

function CloudPayloadText({ parts, raw }: { parts: CloudPart[]; raw: boolean }) {
  return (
    <pre className="cloudview-text">
      {parts.map((part, index) => <CloudPayloadPart key={index} part={part} raw={raw} />)}
    </pre>
  );
}

function CloudPayloadPart({ part, raw }: { part: CloudPart; raw: boolean }) {
  if (!part.mark) return <span>{part.text}</span>;
  return <mark className={`cloudview-mark${raw ? " exposed" : ""}`}>{part.text}</mark>;
}
