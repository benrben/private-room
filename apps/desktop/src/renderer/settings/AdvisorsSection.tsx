import type { AiStatus, IconComponent } from "./types";

interface Props {
  ai: AiStatus | null;
  advisorsOn: boolean;
  onAdvisorsToggle: (e: React.ChangeEvent<HTMLInputElement>) => void;
  advisorToolsOn: boolean;
  onAdvisorToolsToggle: (e: React.ChangeEvent<HTMLInputElement>) => void;
  ENGINE_LABELS: Record<string, string>;
  AlertIcon: IconComponent;
}

export default function AdvisorsSection({
  ai,
  advisorsOn,
  onAdvisorsToggle,
  advisorToolsOn,
  onAdvisorToolsToggle,
  ENGINE_LABELS,
  AlertIcon,
}: Props) {
  // `ai.external` is not the advisor list: `ai_status` appends "openrouter" to
  // it whenever a key is saved, while `consult_advisor` is only ever offered for
  // the CLIs `detected_advisors` finds on PATH (claude-cli / codex-cli). Reading
  // it raw put a live switch labelled "Enable AI advisors (OpenRouter)" in front
  // of a Mac with no CLI at all, and turning it on bought nothing — no advisor
  // step can ever run. Ask only about the CLIs.
  const advisorClis = (ai?.external ?? []).filter((e) => e !== "openrouter");
  return (
    <section id="set-advisors">
      <h3>AI advisors (advanced)</h3>
            <p className="settings-hint">
              Let your selected AI model hand off one genuinely hard
              subtask — deep research, complex reasoning, difficult code — to a
              powerful cloud AI (<code>consult_advisor</code>), using the cloud
              CLIs already installed on this Mac. Off by default. While off, the
              tool is not even offered to the model, so nothing can leave this
              Mac on the model's own initiative.
            </p>
            {/* The model deciding on its own to send text off this Mac is the
                consequence the whole section turns on, so it is a marked note
                at lead size rather than the third 12px paragraph in a row. */}
            <p className="set-note set-note--flag set-note--lead nb-sem-urgent">
              <AlertIcon size={16} className="warn-ic" /> When on, the selected model may decide — on its own, mid-answer — to
              send the subtask it writes to Claude or Codex through your cloud
              account. That text leaves this Mac. Each consult is shown as a
              step while it happens, and it's capped at one per question.
            </p>
            {advisorClis.length > 0 ? (
              <>
                <label className="settings-label">
                  <input
                    type="checkbox"
                    checked={advisorsOn}
                    onChange={onAdvisorsToggle}
                  />{" "}
                  Enable AI advisors ({advisorClis
                    .map((e) => ENGINE_LABELS[e] ?? e)
                    .join(", ")})
                </label>
                {advisorsOn && (
                  <>
                    <label className="settings-label">
                      <input
                        type="checkbox"
                        checked={advisorToolsOn}
                        onChange={onAdvisorToolsToggle}
                      />{" "}
                      Let a Claude advisor use this room's tools
                    </label>
                    {/* "A second, separate way for content to leave this Mac"
                        is a consequence, and it only appears once the switch
                        above it is on — so it is attached to that switch. */}
                    <p className="set-note set-note--flag nb-sem-urgent">
                      When consulted, the advisor can list, search, open and
                      edit this room's files — and drive any connector you have
                      turned on (Connectors, in the sidebar) — through a
                      private, one-question-long local bridge. A second,
                      separate way for content to leave this Mac.
                    </p>
                  </>
                )}
              </>
            ) : (
              <p className="settings-hint">
                No cloud AI CLIs (Claude Code, Codex, Antigravity) were detected on this Mac.
                Install one and reopen Settings to enable advisors.
              </p>
            )}
    </section>
  );
}
