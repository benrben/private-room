import { useEffect, useState } from "react";
import type React from "react";
import { api } from "../api";

/** ADD-21: "AI advisors" — let the local model delegate a hard subtask to a
 * cloud CLI, and (sub-option) give that advisor the room's connected tools. */
export function useAdvisors() {
  const [advisorsOn, setAdvisorsOn] = useState(false);
  const [advisorToolsOn, setAdvisorToolsOn] = useState(false);

  useEffect(() => {
    api.getSetting("advisors_enabled").then((v) => setAdvisorsOn(v === "on"));
    api
      .getSetting("advisor_tools_enabled")
      .then((v) => setAdvisorToolsOn(v === "on"));
  }, []);

  const onAdvisorsToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAdvisorsOn(e.target.checked);
    api.setSetting("advisors_enabled", e.target.checked ? "on" : "off");
    // Turning the feature off also disables the sub-option.
    if (!e.target.checked && advisorToolsOn) {
      setAdvisorToolsOn(false);
      api.setSetting("advisor_tools_enabled", "off");
    }
  };
  const onAdvisorToolsToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAdvisorToolsOn(e.target.checked);
    api.setSetting("advisor_tools_enabled", e.target.checked ? "on" : "off");
  };

  return {
    advisorsOn,
    advisorToolsOn,
    onAdvisorsToggle,
    onAdvisorToolsToggle,
  };
}
