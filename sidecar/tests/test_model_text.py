"""The shared model-reply recovery helpers (model_text.py, ollama.rs parity).

These two functions used to be copied into file_pass / vision / chat_docs /
summarize / ai_actions / external_llm — six spellings of one idea. This file is
the corpus that pinned all six as equivalent before they were deleted, so it is
the regression net for every structured caller at once: a change here changes how
EVERY feature reads a model's reply.
"""

from __future__ import annotations

import json

import pytest

from arcelle_sidecar import external_llm, model_text
from arcelle_sidecar.model_text import prime_schema, recover_json, strip_think_spans

# --- strip_think_spans ------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        # No span at all: untouched.
        ("plain answer", "plain answer"),
        ("", ""),
        # One span, and the span at either end.
        ("<think>hmm</think>answer", "answer"),
        ("a<think>x</think>b", "ab"),
        ("answer<think>hmm</think>", "answer"),
        # Several spans, all dropped.
        ("a<think>x</think>b<think>y</think>c", "abc"),
        # An UNTERMINATED <think> truncates everything after it: that text is
        # unclosed reasoning, not answer.
        ("visible<think>leaked", "visible"),
        ("<think>no end", ""),
        ("keep<think>drop the rest", "keep"),
        # A NESTED open tag is not a nesting grammar: the outer <think> is matched
        # to the FIRST </think>, so the tail after it survives as answer text and
        # the now-orphaned closing tag is left in place (all five pre-2026-07-30
        # copies behaved this way — pinned so nobody "fixes" it into a parser).
        ("<think>outer<think>inner</think>tail</think>x", "tail</think>x"),
        # A stray closing tag BEFORE the opening one is not a match — the
        # unterminated <think> still truncates.
        ("</think>abc<think>x", "</think>abc"),
    ],
)
def test_strip_think_spans(raw: str, want: str) -> None:
    assert strip_think_spans(raw) == want


# --- recover_json -----------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        # Bare JSON from a model that honours `format`: a no-op.
        ('{"a":1}', '{"a":1}'),
        ("[1,2,3]", "[1,2,3]"),
        # A ```json fence (Ollama :cloud models ignore `format`).
        ('```json\n{"a":1}\n```', '{"a":1}'),
        ("```json\n[1,2]\n```", "[1,2]"),
        ('```\n{"a":1}\n```', '{"a":1}'),
        # A <think> preamble, then the payload.
        ('<think>reasoning</think>{"a":2}', '{"a":2}'),
        ("<think>hmm</think>  [1,2]  ", "[1,2]"),
        ('<think>one</think><think>two</think>{"a":3}', '{"a":3}'),
        # Trailing prose after the payload.
        ('noise {"a":1} tail', '{"a":1}'),
        ('<think>x</think> ["a","b"] trailing', '["a","b"]'),
        # No bracket pair: trimmed, otherwise unchanged. The caller's json.loads
        # then fails exactly as it would have on the raw reply.
        ("plain text", "plain text"),
        ("no json here", "no json here"),
        ("  spaced  ", "spaced"),
        ("", ""),
        ("   ", ""),
        # A stray bracket with no partner is left alone (b is None / b < a).
        ("here is a { but nothing else", "here is a { but nothing else"),
        ("trailing } only", "trailing } only"),
        ("} {", "} {"),
        ("{", "{"),
        # An unterminated <think> truncates the reply, so nothing is left to slice.
        ("<think>no end", ""),
        ("<think>only reasoning</think>", ""),
        # A brace INSIDE a think span is dropped with the span, so the real
        # payload after it is what gets recovered — not the reasoning's brace.
        ('<think>maybe {"a":0} is right</think>{"b":9}', '{"b":9}'),
        # ...and when the span is unterminated, its brace goes with it: nothing.
        ('<think>maybe {"a":0}\n{"b":9}', ""),
        # A think span INSIDE the payload is spliced out, leaving valid JSON.
        ('{"a": <think>hmm</think> 1}', '{"a":  1}'),
    ],
)
def test_recover_json(raw: str, want: str) -> None:
    assert recover_json(raw) == want


def test_recover_json_output_parses() -> None:
    """The point of the helper: the slice is what ``json.loads`` accepts."""
    assert json.loads(recover_json('```json\n{"a":1}\n```')) == {"a": 1}
    assert json.loads(recover_json('<think>reasoning</think>{"a":2}')) == {"a": 2}
    assert json.loads(recover_json('{"a": <think>hmm</think> 1}')) == {"a": 1}
    assert json.loads(recover_json('{"a":3}')) == {"a": 3}


def test_recover_json_never_raises_and_always_returns_str() -> None:
    """Contract: no exception, no None — the caller decides what unparseable means."""
    for raw in ("", "   ", "prose", "{", "] [", "<think>x", '{"a":1}'):
        assert isinstance(recover_json(raw), str)


# --- prime_schema (the outbound half of chat_structured) --------------------

_SCHEMA = {"type": "object", "properties": {"markdown": {"type": "string"}}}


def test_prime_schema_appends_to_the_last_user_turn() -> None:
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "a"},
        {"role": "user", "content": "u2"},
    ]
    out = prime_schema(msgs, _SCHEMA)
    assert out[1]["content"] == "u1"  # earlier user turn untouched
    assert out[3]["content"] == "u2" + model_text.SCHEMA_PRIMER + json.dumps(
        _SCHEMA, ensure_ascii=False, separators=(",", ":")
    )


def test_prime_schema_is_non_mutating() -> None:
    msgs = [{"role": "user", "content": "u"}]
    prime_schema(msgs, _SCHEMA)
    assert msgs == [{"role": "user", "content": "u"}]


def test_prime_schema_no_user_turn_is_a_passthrough_copy() -> None:
    msgs = [{"role": "system", "content": "s"}]
    out = prime_schema(msgs, _SCHEMA)
    assert out == msgs
    assert out[0] is not msgs[0]


def test_prime_schema_tolerates_a_missing_content_key() -> None:
    # A user turn built without `content` must not raise (the old
    # ``m.get("content", "") + primer`` would have if content were None).
    assert prime_schema([{"role": "user"}], _SCHEMA)[0]["content"].startswith(
        model_text.SCHEMA_PRIMER
    )


# --- external_llm._recover_object rides on the shared helper ----------------


def test_recover_object_contract_preserved() -> None:
    """Parsed value, or None for empty / bracketless / unparseable text."""
    assert external_llm._recover_object('{"a":1}') == {"a": 1}
    assert external_llm._recover_object('noise {"a":1} tail') == {"a": 1}
    assert external_llm._recover_object("[1,2]") == [1, 2]
    assert external_llm._recover_object("") is None
    assert external_llm._recover_object("   ") is None
    assert external_llm._recover_object("just prose") is None
    assert external_llm._recover_object("{") is None  # bracket, but not JSON
    assert external_llm._recover_object("} {") is None  # close before open
    # Bare scalars have no brackets, so they stay None rather than becoming a
    # parsed 42 / "hello" / None-from-null that the (A) branch would inspect.
    for scalar in ("null", "42", '"hello"', "true"):
        assert external_llm._recover_object(scalar) is None


def test_recover_object_no_longer_reads_json_out_of_a_think_span() -> None:
    """2026-07-30: the bug the shared helper fixes.

    ``_recover_object`` used to scan brackets on the RAW reply. A harness engine's
    reasoning preamble routinely contains a brace, so a tool call the model only
    THOUGHT about was sliced out of the think span and dispatched for real.
    """
    fabricated = '<think>{"tool_calls":[{"name":"ghost","arguments":{}}]}</think>The answer is 4.'
    assert external_llm._recover_object(fabricated) is None
    assert external_llm.parse_tool_calls(fabricated) == []

    considered = '<think>I could call {"name":"send","arguments":{"to":"x"}}</think>I will not.'
    assert external_llm._recover_object(considered) is None
    assert external_llm.parse_tool_calls(considered, {"send"}) == []


def test_recover_object_now_finds_a_call_after_a_brace_bearing_preamble() -> None:
    """The other direction of the same bug: a REAL envelope was being dropped."""
    reply = '<think>I will call {tool}</think>{"tool_calls":[{"name":"x","arguments":{}}]}'
    assert external_llm._recover_object(reply) == {
        "tool_calls": [{"name": "x", "arguments": {}}]
    }
    calls = external_llm.parse_tool_calls(reply)
    assert [c.name for c in calls] == ["x"]


def test_recover_object_never_rewrites_an_envelope_that_already_parses() -> None:
    """A ``<think>`` tag INSIDE an argument is payload, not reasoning.

    2026-07-30 review catch: recovering a reply that already parses can only
    damage it. The closed span was being deleted from the argument text, and the
    unterminated one truncated the envelope so the call disappeared with no error
    — a dropped call reading as "nothing happened".
    """
    closed = (
        '{"name":"note_create","arguments":'
        '{"body":"The tag <think>hidden</think> is stripped."}}'
    )
    assert external_llm._recover_object(closed)["arguments"]["body"] == (
        "The tag <think>hidden</think> is stripped."
    )
    calls = external_llm.parse_tool_calls(closed, {"note_create"})
    assert [c.arguments["body"] for c in calls] == [
        "The tag <think>hidden</think> is stripped."
    ]

    unterminated = '{"name":"note_create","arguments":{"body":"Write about the <think> tag."}}'
    calls = external_llm.parse_tool_calls(unterminated, {"note_create"})
    assert [c.arguments["body"] for c in calls] == ["Write about the <think> tag."]
