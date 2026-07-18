import { api, Message } from "../api";
import { splitMarkupBlocks } from "./markup";
import * as voice from "./voice";
import { WSState } from "./state";

/** Idea 3: the spoken-voice handlers — per-message Play/Stop and the two
 * chat-header toggles (auto-speak, hands-free). The DSP/config half lives in
 * the voice singleton; these only bridge it to workspace state + settings. */
export function makeVoiceActions(s: WSState) {
  function speakMessage(m: Message) {
    if (s.speakingMsgId === m.id) {
      voice.cancelAll();
      s.setSpeakingMsgId(null);
      return;
    }
    // The click IS the gesture — unlock before any audio is scheduled.
    voice.ensureUnlocked();
    const text = m.effects ? m.content : splitMarkupBlocks(m.content).text;
    s.setSpeakingMsgId(m.id);
    voice.speakText(text, {
      onState: (playing) => {
        if (!playing) s.setSpeakingMsgId(null);
      },
    });
  }

  function stopSpeaking() {
    voice.cancelAll();
    s.setSpeakingMsgId(null);
  }

  function toggleAutoSpeak() {
    voice.ensureUnlocked();
    const next = !s.autoSpeak;
    s.setAutoSpeak(next);
    voice.configure({ autoSpeak: next });
    api.setSetting("voice_autospeak", next ? "1" : "0").catch(() => {});
  }

  function toggleHandsFree() {
    const next = !s.handsFree;
    s.setHandsFree(next);
    api.setSetting("voice_handsfree", next ? "1" : "0").catch(() => {});
  }

  return { speakMessage, stopSpeaking, toggleAutoSpeak, toggleHandsFree };
}
