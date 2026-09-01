"""Pure value-shape coverage for the privacy placeholder mechanics."""

from __future__ import annotations

from arcelle_sidecar.privacy import PrivacyPolicy


def _policy() -> PrivacyPolicy:
    return PrivacyPolicy(
        rules=[
            ("Doctor Alice", "[Person A]"),
            ("Alice", "[Person B]"),
            ("42 Harbor Road", "[Address A]"),
        ]
    )


def test_restore_value_recurses_without_rewriting_mapping_keys() -> None:
    value = {
        "[Person A]": "[person a] met [PERSON B]",
        "nested": ["At [address a]", {"answer": "[Person A]"}],
    }

    restored = _policy().restore_value(value)

    assert restored == {
        "[Person A]": "Doctor Alice met Alice",
        "nested": ["At 42 Harbor Road", {"answer": "Doctor Alice"}],
    }
    assert value == {
        "[Person A]": "[person a] met [PERSON B]",
        "nested": ["At [address a]", {"answer": "[Person A]"}],
    }
    assert restored is not value
    assert restored["nested"] is not value["nested"]


def test_redact_value_recurses_and_counts_only_matched_value_text() -> None:
    policy = _policy()
    value = {
        "Doctor Alice": "Doctor Alice",
        "items": ["alice", {"address": "42 HARBOR ROAD"}],
    }

    redacted = policy.redact_value(value)

    assert redacted == {
        "Doctor Alice": "[Person A]",
        "items": ["[Person B]", {"address": "[Address A]"}],
    }
    assert value["items"][1]["address"] == "42 HARBOR ROAD"
    assert policy.report.replacements == 3
    assert policy.report.entities_hidden == 3


def test_redact_text_uses_literal_longest_matches_and_counts_across_calls() -> None:
    policy = PrivacyPolicy(
        rules=[
            ("Ben Reich", "[Person A]"),
            ("Ben", "[Person B]"),
            ("A+B", "[Code A]"),
        ]
    )

    assert policy.redact_text("Ben Reich / BEN / ben / [Person A] / A+B / A?B") == (
        "[Person A] / [Person B] / [Person B] / [Person A] / [Code A] / A?B"
    )
    assert policy.report.replacements == 4
    assert policy.report.entities_hidden == 3

    assert policy.redact_text("BEN again") == "[Person B] again"
    assert policy.report.replacements == 5
    assert policy.report.entities_hidden == 3


def test_redact_text_recovers_from_an_empty_fast_lookup_with_its_rules() -> None:
    policy = _policy()
    policy._by_real.clear()

    assert policy.redact_text("DOCTOR ALICE and alice") == "[Person A] and [Person B]"
    assert policy.report.replacements == 2
    assert policy.report.entities_hidden == 2


def test_redact_value_leaves_non_json_values_untraversed() -> None:
    policy = _policy()
    opaque = object()
    value = [None, False, 7, opaque, ("Doctor Alice",)]

    redacted = policy.redact_value(value)

    assert redacted is not value
    assert redacted[:3] == [None, False, 7]
    assert redacted[3] is opaque
    assert redacted[4] is value[4]
    assert policy.report.replacements == 0
    assert policy.report.entities_hidden == 0


def test_add_rules_ignores_empty_and_existing_values_then_recompiles() -> None:
    policy = PrivacyPolicy(rules=[("Alice", "[Person A]")])
    original_rules = policy.rules

    policy.add_rules([])
    assert policy.rules is original_rules

    policy.add_rules(
        [
            ("ALICE", "[Wrong duplicate]"),
            (" Bob ", " [Person B] "),
            ("", "[Dropped]"),
            ("Cara", " "),
        ]
    )

    assert policy.rules == [("Alice", "[Person A]"), ("Bob", "[Person B]")]
    assert policy.redact_text("ALICE and bob and Cara") == "[Person A] and [Person B] and Cara"
    assert policy.restore_text("[person b] met [PERSON A]") == "Bob met Alice"


def test_add_rules_keeps_existing_replacement_counters() -> None:
    policy = PrivacyPolicy(rules=[("Alice", "[Person A]")])

    assert policy.redact_text("Alice") == "[Person A]"
    policy.add_rules([("Bob", "[Person B]")])
    assert policy.redact_text("Bob") == "[Person B]"

    assert policy.report.replacements == 2
    assert policy.report.entities_hidden == 2


def test_restore_value_leaves_unknown_placeholders_and_non_json_values_alone() -> None:
    policy = _policy()
    opaque = object()
    tuple_value = ("[Person A]", "not traversed")

    assert policy.restore_value("[Unknown] with [Person A]") == "[Unknown] with Doctor Alice"
    assert policy.restore_value(opaque) is opaque
    assert policy.restore_value(tuple_value) is tuple_value
    assert policy.restore_value(None) is None
    assert policy.restore_value(7) == 7


def test_restore_value_with_no_usable_rules_is_a_safe_no_op() -> None:
    policy = PrivacyPolicy(rules=[("", "[Dropped]"), ("Ignored", " ")])
    value = {"result": ["[Person A]", "ordinary text"]}

    assert policy.rules == []
    assert policy.restore_value(value) == value
    assert policy.restore_text("") == ""
