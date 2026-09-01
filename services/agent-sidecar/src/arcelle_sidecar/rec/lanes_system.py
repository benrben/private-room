"""System-audio lane status and microphone-failure messaging."""

from enum import Enum


class SysLane(Enum):
    """The Mac-audio lane state used to explain microphone failures."""

    RECORDING = "recording"
    STARTING = "starting"
    OFF = "off"


def mic_failure_message(sys: SysLane, ever_pushed: bool) -> str:
    """Describe what remains captured after microphone audio stops."""
    lead = (
        "The microphone stopped sending audio"
        if ever_pushed
        else "No microphone audio has arrived"
    )
    advice = (
        "Pause and resume to reconnect the microphone."
        if ever_pushed
        else (
            "Check that a microphone is connected and that Arcelle is allowed to use it "
            "in System Settings → Privacy & Security → Microphone."
        )
    )
    if sys is SysLane.RECORDING:
        return f"{lead} — the Mac's audio keeps recording. {advice}"
    if sys is SysLane.STARTING:
        return f"{lead} — the Mac's audio is still starting up. {advice}"
    return (
        f"{lead}, and the Mac's audio is not being recorded — nothing at all is being "
        f"captured. {advice} If that cannot be fixed, press Stop."
    )
