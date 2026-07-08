use super::*;

// ---- D11: roles catalog -----------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoomRole {
    pub id: String,
    pub name: String,
    pub blurb: String,
    pub instructions: String,
    pub prompts: Vec<String>,
    pub commands: Vec<String>,
}

pub(crate) fn role(
    id: &str,
    name: &str,
    blurb: &str,
    instructions: &str,
    prompts: &[&str],
    commands: &[&str],
) -> RoomRole {
    RoomRole {
        id: id.into(),
        name: name.into(),
        blurb: blurb.into(),
        instructions: instructions.into(),
        prompts: prompts.iter().map(|s| s.to_string()).collect(),
        commands: commands.iter().map(|s| s.to_string()).collect(),
    }
}

/// D11: the static catalog of room "roles" (a persona + suggested prompts). Apply
/// is data-only — the app saves `set_setting('room_role', id)` and injects the
/// role's `instructions` into custom instructions. Pure, so it is unit-testable.
#[tauri::command]
pub fn list_roles() -> Vec<RoomRole> {
    vec![
        role(
            "default",
            "Assistant",
            "A calm, careful helper grounded in your files.",
            "",
            &["Summarize this room", "What should I look at first?"],
            &["summarize", "find"],
        ),
        role(
            "tutor",
            "Tutor",
            "Explains patiently and checks your understanding.",
            "You are a patient tutor. Explain concepts step by step in plain language, check \
             understanding with short questions, and ground every explanation in the room's files.",
            &[
                "Teach me the key ideas in this room",
                "Quiz me on @file",
                "Explain @file like I'm new to it",
            ],
            &["summarize", "research"],
        ),
        role(
            "critic",
            "Critic",
            "Pushes back and finds the weak points.",
            "You are a sharp but fair critic. Point out weaknesses, unstated assumptions, and gaps, \
             and suggest concrete improvements — always grounded in the room's files, never harsh \
             for its own sake.",
            &["What's weak about @file?", "Poke holes in this argument"],
            &["compare", "find"],
        ),
        role(
            "opposing-counsel",
            "Opposing counsel",
            "Argues the other side to stress-test your case.",
            "You act as opposing counsel. Make the strongest good-faith case AGAINST the user's \
             position, cite the room's documents for every point, and flag the risks they would \
             face — so they can prepare. You are not their lawyer and give no legal advice.",
            &["Argue against @contract", "Where is my case weakest?"],
            &["compare", "extract"],
        ),
        role(
            "scribe",
            "Scribe",
            "Turns discussion into tidy notes and minutes.",
            "You are a meticulous scribe. Capture decisions, action items, and open questions in \
             clean, well-structured notes, using only what the room's files and this conversation \
             contain.",
            &["Take minutes from @recording", "Write up what we decided"],
            &["minutes", "to-sheet"],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_roles_static_catalog() {
        // D11: the five personas the UI offers, apply-by-setting only.
        let roles = list_roles();
        let ids: Vec<&str> = roles.iter().map(|r| r.id.as_str()).collect();
        for want in ["default", "tutor", "critic", "opposing-counsel", "scribe"] {
            assert!(ids.contains(&want), "missing role {want}");
        }
        // A persona injects instructions; the plain default injects nothing.
        let tutor = roles.iter().find(|r| r.id == "tutor").unwrap();
        assert!(!tutor.instructions.is_empty());
        let def = roles.iter().find(|r| r.id == "default").unwrap();
        assert!(def.instructions.is_empty());
    }
}
