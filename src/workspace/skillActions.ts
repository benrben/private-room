import { api } from "../api";
import { WSState } from "./state";

export function makeSkillActions(s: WSState) {
  async function refreshSkills() {
    try {
      const skills = await api.listSkills();
      s.setSkills(skills);
      if (s.selectedSkillId && !skills.some((x) => x.id === s.selectedSkillId)) {
        s.setSelectedSkillId(null);
      }
    } catch {
      // Room transitions can race a refresh; keep the current list.
    }
  }

  function openSkill(id: string) {
    s.setOpenFile(null);
    s.setSelectedSkillId(id);
    s.setArea("skills");
  }

  return { refreshSkills, openSkill };
}

export type SkillActions = ReturnType<typeof makeSkillActions>;
