"""Room-level reduce step for summary one-liners."""

from __future__ import annotations

from . import config
from .chat_docs import parse_string_list
from .llm import LlmError
from .messages import Message
from .model_text import strip_think_spans
from .summarize_chat import ModelClient, _chat_structured

# --- the reduce step: combine_summary (summarize.rs) ------------------------


async def combine_summary(
    client: ModelClient,
    model: str,
    room_name: str,
    memories: list[str],
    file_lines: str,
) -> tuple[str, list[str]]:
    """summarize.rs ``combine_summary``: the "What this room is for" paragraph +
    three suggested questions, from the per-file one-liners Rust gathered.

    TWO single-purpose calls (ADD-22 fix): free-text prose for the purpose (what a
    4B model does most reliably) and a plain string array for the questions. The
    purpose call's errors propagate (Rust ``?``); the questions call swallows
    errors and yields ``[]`` (Rust ``unwrap_or_default``).
    """
    context = f"Room name: {room_name}\n\nFiles and what each is:\n{file_lines}\n"
    if memories:
        context += "\nMemory notes the user saved for this room:\n"
        for m in memories:
            context += f"- {m}\n"

    # Purpose: free-text prose. chat_stream_tools with no tools == a plain no-tools
    # Chat-tier generate; strip any leaked <think> span.
    purpose_messages: list[Message] = [
        {
            "role": "system",
            "content": (
                "You describe what a personal document room is for. In 2-4 "
                "sentences, say what the room is about and the main topics it "
                "covers, based only on the file list. Be specific and concrete. No "
                "preamble, no bullet lists, no file names."
            ),
        },
        {"role": "user", "content": context},
    ]
    purpose_raw = await client.generate(
        model,
        purpose_messages,
        temperature=0.4,
        num_ctx=None,
        keep_alive=config.KEEP_ALIVE_WARM,
    )
    purpose = strip_think_spans(purpose_raw).strip()

    # Questions: a plain string array, schema-constrained at the Chat tier. Errors
    # are swallowed to an empty list (Rust unwrap_or_default).
    questions_messages: list[Message] = [
        {
            "role": "system",
            "content": (
                "You suggest example questions a user could ask about their own "
                "documents. Give exactly three short, specific questions that these "
                "files would actually answer."
            ),
        },
        {"role": "user", "content": context},
    ]
    schema = {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 3}
    try:
        questions_raw = await _chat_structured(
            client, model, questions_messages, 0.4, config.KEEP_ALIVE_WARM, schema
        )
    except LlmError:
        questions_raw = ""
    questions = parse_string_list(questions_raw)[:3]

    return purpose, questions
