"""Pure text/time overlap helpers for recording echo detection."""


def _words_of(text: str) -> set[str]:
    words: set[str] = set()
    current: list[str] = []
    for char in text.lower():
        if char.isalnum():
            current.append(char)
        elif current:
            words.add("".join(current))
            current = []
    if current:
        words.add("".join(current))
    return words


def text_overlap(first: str, second: str) -> float:
    first_words, second_words = _words_of(first), _words_of(second)
    smaller = min(len(first_words), len(second_words))
    if smaller == 0:
        return 0.0
    return len(first_words & second_words) / smaller


def time_overlap(first: tuple[int, int], second: tuple[int, int]) -> float:
    shared = max(0, min(first[1], second[1]) - max(first[0], second[0]))
    shorter = max(1, min(first[1] - first[0], second[1] - second[0]))
    return shared / shorter
