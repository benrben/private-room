"""Host-authoritative routing request shape and lane resolution helpers."""

from collections.abc import Callable

from pydantic import BaseModel, ConfigDict


class Routing(BaseModel):
    """Routing decisions the Rust host already computed."""

    model_config = ConfigDict(extra="ignore")

    write: bool | None = None
    ui: bool | None = None
    jobs: bool | None = None
    skills: bool | None = None
    connectors: bool | None = None


RoutingOverrides = tuple[bool | None, bool | None, bool | None, bool | None, bool | None]
RoutingClassifier = Callable[[str], bool]


def routing_overrides(routing: Routing | None) -> RoutingOverrides:
    """Return host routing decisions in the public lane order."""
    if routing is None:
        return None, None, None, None, None
    return (
        routing.write,
        routing.ui,
        routing.jobs,
        routing.skills,
        routing.connectors,
    )


def resolved_routing_lane(
    host_decision: bool | None,
    question: str,
    classifier: RoutingClassifier,
) -> bool:
    """Prefer the host's decision; otherwise classify the question locally."""
    if host_decision is not None:
        return host_decision
    return classifier(question)
