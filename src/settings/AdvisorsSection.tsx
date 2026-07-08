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
  return (
    <section id="set-advisors">
      <h3>AI advisors (advanced)</h3>
            <p className="settings-hint">
              Let your <strong>local</strong> AI hand off one genuinely hard
              subtask — deep research, complex reasoning, difficult code — to a
              powerful cloud AI (<code>consult_advisor</code>), using the cloud
              CLIs already installed on this Mac. Off by default. While off, the
              tool is not even offered to the model, so nothing can leave this
              Mac on the model's own initiative.
            </p>
            <p className="settings-hint">
              <AlertIcon size={13} className="warn-ic" /> When on, the local AI may decide — on its own, mid-answer — to
              send the subtask it writes to Claude or Codex through your cloud
              account. That text leaves this Mac. Each consult is shown as a
              step while it happens, and it's capped at one per question.
            </p>
            {ai && ai.external.length > 0 ? (
              <>
                <label className="settings-label">
                  <input
                    type="checkbox"
                    checked={advisorsOn}
                    onChange={onAdvisorsToggle}
                  />{" "}
                  Enable AI advisors ({ai.external
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
                    <p className="settings-hint">
                      When consulted, the advisor can list, search, open and
                      edit this room's files — and drive any Connected tools
                      (MCP) below — through a private, one-question-long local
                      bridge. A second, separate way for content to leave this
                      Mac.
                    </p>
                  </>
                )}
              </>
            ) : (
              <p className="settings-hint">
                No cloud AI CLIs (Claude Code, Codex) were detected on this Mac.
                Install one and reopen Settings to enable advisors.
              </p>
            )}
    </section>
  );
}
