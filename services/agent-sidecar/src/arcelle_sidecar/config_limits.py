"""Shared runtime limits for sidecar request models and agent execution."""

AGENT_ROUND_BACKSTOP: int = 10_000
TURN_ROUND_BACKSTOP: int = 400
NO_PROGRESS_ROUNDS: int = 3
CLOUD_WORKER_PARALLEL: int = 4
KEEP_ALIVE_WARM: str = "30m"
KEEP_ALIVE_SHORT: str = "2m"
