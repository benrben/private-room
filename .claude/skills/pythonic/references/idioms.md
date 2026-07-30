# Idiom catalog

Before/after pairs for the patterns that come up most, each tagged with the Zen
principle it serves — the goal is recognizing the *category* of problem later,
not memorizing fifty rewrites. Targets Python 3.10+.

(Voice reminder while you're here: whatever you learn from this file, deliver
it lazy-senior style — short, plain, one drop of dry humor. SKILL.md has the
rules.)

## Contents

1. [Looping](#1-looping)
2. [Building collections](#2-building-collections)
3. [Generators and laziness](#3-generators-and-laziness)
4. [Conditionals and truthiness](#4-conditionals-and-truthiness)
5. [Unpacking and multiple values](#5-unpacking-and-multiple-values)
6. [Strings](#6-strings)
7. [Dicts](#7-dicts)
8. [Sorting and selecting](#8-sorting-and-selecting)
9. [Resources and context managers](#9-resources-and-context-managers)
10. [EAFP vs LBYL](#10-eafp-vs-lbyl)
11. [Functions and signatures](#11-functions-and-signatures)
12. [Classes and data](#12-classes-and-data)
13. [Designing exceptions](#13-designing-exceptions)
14. [Standard library you're probably reimplementing](#14-standard-library-youre-probably-reimplementing)
15. [Modern syntax: walrus and match](#15-modern-syntax-walrus-and-match)
16. [Files and paths](#16-files-and-paths)
17. [Small marks of fluency](#17-small-marks-of-fluency)

---

## 1. Looping

*One obvious way; readability counts.* Python's `for` iterates over things, not
indices. Index arithmetic is where off-by-one bugs live.

```python
# No
for i in range(len(items)):
    print(items[i])

# Yes
for item in items:
    print(item)
```

Need the index, parallel sequences, reverse order, sorted order — each has a
name:

```python
for i, item in enumerate(items, start=1):
    print(f"{i}. {item}")

for name, score in zip(names, scores, strict=True):   # strict: length mismatch raises
    ...

for item in reversed(items):
    ...

for name in sorted(names, key=str.lower):
    ...
```

Tells: a hand-rolled counter (`i = 0` … `i += 1`) wanted `enumerate`; iterating
one list to index into another wanted `zip`. And `zip`'s default of silently
truncating at the shorter input is a quiet data-loss bug — pass `strict=True`
whenever the lengths *should* match (*errors should never pass silently*).

Never mutate a list while iterating it; build a new one, or iterate a copy.

## 2. Building collections

*Sparse but not dense; flat is better than nested.* A comprehension replaces the
three-line append ritual — while it stays one thought.

```python
# No
squares = []
for n in numbers:
    if n % 2 == 0:
        squares.append(n * n)

# Yes
squares = [n * n for n in numbers if n % 2 == 0]
```

Dict and set comprehensions complete the family:

```python
by_id = {user.id: user for user in users}
domains = {email.split("@")[1] for email in emails}
```

Know when to stop. Two `for` clauses plus a filter plus a conditional expression
is a puzzle, not a line:

```python
# Too dense — unroll this one back into a loop.
labels = [fmt(c) if c.active else "-" for row in grid for c in row if c.visible]
```

The rule of thumb: a comprehension earns its place while you can read it aloud
as one English sentence. Past that, the loop you were avoiding was the readable
version all along.

One repetition trap: `*` copies *references*, so multiplying a list of mutables
gives you N aliases of the same object:

```python
grid = [[0] * 3] * 3        # No — three names for ONE row
grid[0][0] = 1              # ...and all three "rows" change

grid = [[0] * 3 for _ in range(3)]   # Yes — three distinct rows
```

`[0] * 3` itself is fine — ints are immutable, so sharing can't hurt you. The
bug needs both the `*` and a mutable element.

## 3. Generators and laziness

*Simple is better than complex.* A generator expression is a comprehension that
never materializes the list — for aggregation or one-pass consumption, it's the
same code minus the memory:

```python
total = sum(line.cost for line in invoice)        # no intermediate list
has_admin = any(u.is_admin for u in users)        # stops at the first hit
first_error = next((r for r in results if r.failed), None)
```

A `yield` function turns an accumulate-and-return into a stream — callers start
consuming immediately, memory stays flat, and `for` loops over it like any
sequence:

```python
def read_records(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                yield parse(line)
```

When a generator delegates to another iterable, `yield from source` replaces
the `for item in source: yield item` loop — same behavior, one line, and it
composes generators cleanly.

Two cautions, both explicitness (*in the face of ambiguity…*): a generator is
single-use — iterating it a second time silently yields nothing, so if the
caller needs multiple passes, return a list; and laziness defers errors to
consumption time, so validate arguments eagerly *before* the first `yield` if
you want bad input to fail at the call site.

## 4. Conditionals and truthiness

*Explicit is better than implicit — and to a Python reader, the idiomatic
emptiness check* is *the explicit form.*

| Instead of | Write |
| --- | --- |
| `if len(items) == 0:` | `if not items:` |
| `if x == True:` | `if x:` |
| `if x != None:` | `if x is not None:` |
| `if b: return True` / `else: return False` | `return b` |

`is None`, never `== None`: identity is the intended test, and `==` can be
overloaded to lie.

The one real trap: `if not count:` is true for both `0` and `None`. The moment
those mean different things — "zero items" vs "not yet loaded" — test
`is None` explicitly. Same for `""` vs `None` in text fields.

Chained comparisons and membership read like the math they encode:

```python
if 0 <= index < len(items):
    ...
if status in {"active", "trialing"}:     # set literal: O(1) and reads as a set
    ...
```

A dict beats an `elif` ladder when you're mapping values to values or handlers
(*flat is better than nested*):

```python
HANDLERS = {"created": on_create, "updated": on_update, "deleted": on_delete}
handler = HANDLERS.get(event.kind, on_unknown)
handler(event)
```

## 5. Unpacking and multiple values

*Beautiful is better than ugly.*

```python
a, b = b, a                                  # swap, no temp
first, *rest = parts                         # star-unpacking
lo, *_, hi = sorted(samples)                 # _ marks the deliberately ignored
for key, value in mapping.items():
    ...
name, _, domain = email.partition("@")       # always 3 parts, unlike split
```

Returning several values: a plain tuple is fine for two; past that, callers are
memorizing positions. Give the fields names:

```python
from typing import NamedTuple

class ParseResult(NamedTuple):
    value: float
    unit: str
    confidence: float
```

`NamedTuple` when the result is a value (immutable, unpackable, zero ceremony);
a `dataclass` when it's an object with identity or behavior (§12).

## 6. Strings

*One obvious way.* f-strings are the way.

```python
# No
msg = "Hello " + name + ", you have " + str(n) + " messages"
msg = "Hello %s, you have %d messages" % (name, n)

# Yes
msg = f"Hello {name}, you have {n} messages"
```

Formatting lives in the braces — `f"{price:,.2f}"`, `f"{ratio:.1%}"`,
`f"{name!r}"` — and `f"{expr=}"` prints both the expression and its value, which
makes debug output self-labeling.

Two exceptions that are correctness, not taste:

```python
logger.info("Processing %s items for %s", n, user)   # lazy: no format cost when filtered
cursor.execute("SELECT * FROM t WHERE id = ?", (user_id,))   # params — f-string SQL is injection
```

Concatenating in a loop is quadratic; join once:

```python
report = "\n".join(f"{k}: {v}" for k, v in rows)
```

And reach for `str` methods before `re`: `removeprefix`, `removesuffix`,
`partition`, `casefold`, `startswith(("a", "b"))` cover most "simple regex" jobs
with no pattern language to misread (*simple is better than complex*).

Finally, keep the `str`/`bytes` boundary at the edges of the program: decode
input once on the way in (`data.decode("utf-8")`), work in `str` everywhere,
encode once on the way out. Mixing the two mid-pipeline is where
`UnicodeDecodeError` at 2am comes from (*explicit is better than implicit*).

## 7. Dicts

*Errors should never pass silently* — but "missing key" is often not an error.
Choose the tool by what absence *means*:

```python
value = config.get("timeout", 30)      # absence expected, sensible default
value = config["timeout"]              # absence is a bug — let KeyError name the key

from collections import defaultdict, Counter
by_owner = defaultdict(list)
by_owner[owner].append(task)           # beats setdefault for repeated grouping

freq = Counter(words)
freq.most_common(3)
```

A crash with the key name in it beats a defaulted `None` that detonates 200
lines later — `.get()` everywhere is silence wearing a convenience costume.

Merging and iterating:

```python
merged = defaults | overrides          # 3.9+; right side wins
for key, value in mapping.items():     # not `for key in mapping: mapping[key]`
    ...
```

## 8. Sorting and selecting

*One obvious way.* Everything routes through `key=` — a function from item to
sort value. Never write a comparator.

```python
users.sort(key=lambda u: u.last_name)              # in place
ranked = sorted(users, key=lambda u: u.score, reverse=True)   # new list

from operator import attrgetter, itemgetter
rows.sort(key=itemgetter(2))
users.sort(key=attrgetter("last_name", "first_name"))   # multi-level in one call
```

Mixed directions: sort in passes, most-significant last — Python's sort is
stable, so earlier orderings survive within equal keys:

```python
users.sort(key=attrgetter("name"))                  # tiebreaker first
users.sort(key=attrgetter("score"), reverse=True)   # primary last
```

Top-N without sorting everything, and min/max with keys:

```python
import heapq
top = heapq.nlargest(5, users, key=attrgetter("score"))
oldest = min(users, key=attrgetter("created_at"))
```

## 9. Resources and context managers

*Errors should never pass silently.* A `with` block releases the resource even
when the body raises; a manual `.close()` does not.

```python
# No
f = open(path)
data = f.read()
f.close()          # skipped entirely if read() raises

# Yes
with open(path, encoding="utf-8") as f:
    data = f.read()
```

Always pass `encoding=` on text I/O: the platform default differs across
machines, which makes the resulting bug unreproducible on yours.

Multiple resources, and writing your own:

```python
with open(src, encoding="utf-8") as fin, open(dst, "w", encoding="utf-8") as fout:
    fout.write(transform(fin.read()))

from contextlib import contextmanager

@contextmanager
def timed(label):
    start = time.perf_counter()
    try:
        yield
    finally:
        logger.info("%s took %.2fs", label, time.perf_counter() - start)
```

The `try/finally` is the entire point: cleanup must run on the failure path too.
Any paired acquire/release in your codebase — locks, temp dirs, feature flags,
DB transactions — wants this shape, so callers *can't* forget the release.

## 10. EAFP vs LBYL

*Easier to Ask Forgiveness than Permission* — Python's default grain. The
check-then-use shape is often both slower and racy, because the world can change
between the check and the use:

```python
# LBYL — racy: the file can vanish between exists() and open()
if os.path.exists(path):
    with open(path) as f:
        ...

# EAFP — one atomic attempt, and the failure has a name
try:
    with open(path, encoding="utf-8") as f:
        ...
except FileNotFoundError:
    logger.warning("Missing %s", path)
```

The same reasoning picks `dict.get`/`defaultdict` over `if key in d`, and
`suppress(FileNotFoundError)` over `exists()`-then-delete.

LBYL still wins when the check is cheap, race-free, and failure would be
expensive or ambiguous — validating user input before a long batch job, say.
Choose per case; *practicality beats purity* in both directions.

## 11. Functions and signatures

*Explicit; refuse to guess.*

The mutable-default trap — the default is created once, at `def` time, and
shared by every call:

```python
# No — the list accumulates across calls
def add(item, target=[]):
    target.append(item)
    return target

# Yes — the sentinel is None, the fresh list is per-call
def add(item, target=None):
    if target is None:
        target = []
    target.append(item)
    return target
```

Keyword-only arguments (everything after `*`) make call sites self-describing
and un-swappable:

```python
def export(rows, *, include_header=True, delimiter=","):
    ...

export(rows, include_header=False)     # a bare positional True is now impossible
```

Type hints put the contract in the signature, where it can't drift:

```python
def parse_rows(path: Path, limit: int | None = None) -> list[Record]:
    ...
```

Accept broad, return narrow: take `Iterable[str]` if you only iterate — callers
can pass a list, a generator, a file — but return the concrete `list[Record]`
so callers know exactly what they hold.

And the flag-parameter smell: a boolean that switches a function between two
behaviors is usually two functions wearing a trenchcoat (*special cases aren't
special enough*). `render(data, as_html=True)` → `render_html(data)` /
`render_text(data)`.

When you write a decorator, `functools.wraps` is not optional — without it the
wrapped function loses its name, docstring, and signature, which breaks
introspection, `help()`, and any debugging that relies on knowing what actually
ran (*errors should never pass silently*, applied to identity):

```python
from functools import wraps

def logged(func):
    @wraps(func)                      # preserves func's name and docstring
    def wrapper(*args, **kwargs):
        logger.info("calling %s", func.__name__)
        return func(*args, **kwargs)
    return wrapper
```

## 12. Classes and data

*Simple is better than complex.* A class that is only fields wants to be a
`dataclass`; a class with one method and no state wants to be a function; a
"manager" that wraps one dict wants to be the dict.

```python
from dataclasses import dataclass, field

@dataclass(frozen=True, slots=True)
class Invoice:
    number: str
    total: Decimal
    tags: list[str] = field(default_factory=list)   # never `= []`
```

`frozen=True` whenever the value shouldn't change after construction:
immutability deletes the entire "who mutated this?" class of bugs, and frozen
instances are hashable — usable as dict keys and set members. `slots=True` is a
free memory/typo win. You also get `__repr__` and `__eq__` for free, which is
most of what hand-written boilerplate classes were doing.

Related constants belong in an `Enum`, not loose module strings (*namespaces are
one honking great idea*):

```python
from enum import Enum

class Status(Enum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
```

Now the type says exactly which values exist, `Status("active")` validates
input at the boundary, and a typo'd status is an immediate error instead of a
string that silently matches nothing.

No Java-style getters and setters. Public attributes are fine; `@property`
exists so that *if* you later need computation or validation behind the same
name, you can add it without changing a single call site — which is precisely
why the ceremonial getters were never needed.

Prefer composition to inheritance for reuse; inherit only for genuine is-a with
substitutability. And `__repr__` is for the 2am reader: make it show what
matters, ideally round-trippable — dataclasses already do this, which is one
more reason to use them.

Duck typing is the flip side of `isinstance` chains: depend on what an object
*does*, not what it *is*. Accept anything with a `.read()` if reading is all
you do — and when you want that contract checkable, name it with
`typing.Protocol` instead of forcing callers into your inheritance tree
(*practicality beats purity*):

```python
from typing import Protocol

class Readable(Protocol):
    def read(self) -> str: ...

def load(source: Readable) -> Config:
    return parse(source.read())      # files, StringIO, sockets — all welcome
```

## 13. Designing exceptions

*Errors should never pass silently* has a design side: raising well.

- Raise the built-in that fits — `ValueError` for bad values, `TypeError` for
  bad types, `KeyError`/`LookupError` for missing things. Callers already know
  how to catch these.
- Define custom exceptions when callers need to catch *your* failures
  distinctly from everyone else's — and give your package one base:

```python
class BillingError(Exception):
    """Base for all billing failures."""

class InvoiceNotFound(BillingError):
    pass

class PaymentDeclined(BillingError):
    def __init__(self, code: str, retriable: bool):
        super().__init__(f"payment declined ({code})")
        self.code = code
        self.retriable = retriable
```

One base means callers choose their granularity: `except PaymentDeclined` for
the specific, `except BillingError` for the family — and never a broad
`except Exception` that also eats typos.

- Put the useful facts in the message *and* as attributes: the message serves
  the log line, the attributes serve the handler.
- Chain, don't replace: `raise BillingError("charge failed") from exc` keeps
  the original traceback — the 2am reader's only map.
- Exceptions are for the exceptional. An expected, common outcome ("no results")
  is a return value (`None`, `[]`), not an exception — flow control via `except`
  hides the actual logic (*explicit is better than implicit*).

## 14. Standard library you're probably reimplementing

*That way may not be obvious at first* — check here before hand-rolling.

| Need | Use |
| --- | --- |
| Count occurrences | `collections.Counter` |
| Default value per key | `collections.defaultdict` |
| Fast queue / fixed-size window | `collections.deque(maxlen=n)` |
| Chunking, pairing, grouping, flattening | `itertools`: `pairwise`, `groupby`, `chain`, `batched` (3.12+) |
| Memoize a pure function | `functools.cache` / `lru_cache` |
| Plain record types | `dataclasses`, `typing.NamedTuple` |
| Fixed set of named values | `enum.Enum` |
| Paths | `pathlib.Path` |
| Cleanup, sanctioned silencing | `contextlib`: `contextmanager`, `suppress`, `closing` |
| Binary search / sorted insert | `bisect` |
| Top-N without full sort | `heapq.nlargest` |
| Money, exact decimals | `decimal.Decimal` (never float) |
| Timezone-aware times | `datetime` with `tz=` + `zoneinfo` |
| Temp files that clean up | `tempfile` |
| Sane CLI parsing | `argparse` |

`contextlib.suppress` deserves its note as the sanctioned form of *unless
explicitly silenced* — it names the exception being ignored, making the silence
a visible decision:

```python
from contextlib import suppress

with suppress(FileNotFoundError):
    stale_cache.unlink()
```

## 15. Modern syntax: walrus and match

Two features whose *restraint* is the idiom.

**Walrus (`:=`)** earns its place where it removes a genuine duplication or an
awkward loop shape:

```python
while chunk := stream.read(8192):        # the classic use
    process(chunk)

if (n := len(errors)) > THRESHOLD:       # bind and test, use n in the body
    alert(f"{n} errors")
```

Outside those shapes, it usually just makes a line denser (*sparse is better
than dense*). If you're squinting at operator precedence, use two lines.

**`match`** shines when you're destructuring *structure* — shapes of nested
data, tagged unions — not when you're comparing one value (that's `if`/`elif`
or a dict dispatch):

```python
match event:
    case {"type": "click", "pos": (x, y)}:
        handle_click(x, y)
    case {"type": "key", "key": k} if k.isprintable():
        insert(k)
    case _:
        raise ValueError(f"unknown event: {event!r}")
```

The `case _` that raises is the *refuse to guess* clause: an unmatched shape is
a bug you want named now, not a silent fall-through.

## 16. Files and paths

*One obvious way.* `pathlib` over `os.path` string surgery.

```python
from pathlib import Path

config = Path.home() / ".config" / "app" / "settings.toml"
if config.exists():
    text = config.read_text(encoding="utf-8")

for py_file in Path("src").rglob("*.py"):
    print(py_file.stem, py_file.suffix, py_file.parent)
```

`read_text`/`write_text` replace the whole open/read/close dance for small
files; `with` (§9) remains right for streaming and large ones.

## 17. Small marks of fluency

The little habits that signal — and produce — well-kept Python:

```python
if __name__ == "__main__":       # importable module, runnable script
    main()
```

- `_` for values you're required to receive but don't use: `for _ in range(3)`.
- Constants in `UPPER_SNAKE` at module top; magic numbers get a name the first
  time they appear twice.
- `assert` is for internal invariants — states you believe impossible — never
  for validating input: `python -O` strips every assert, so validation by
  assertion is validation that vanishes in production. Bad input gets a
  `raise`; impossible states get an `assert`.
- Slicing fluency: `items[-1]` for the last element (no `len()` arithmetic),
  `items[:]` or `list(items)` for a copy, `items[::-1]` for reversed-as-a-list.
  Don't combine start, stop, *and* stride in one slice — that's dense enough to
  deserve two steps.
- Empty containers by literal: `[]`, `{}`, `()` — not `list()`, `dict()`,
  `tuple()`. Shorter, faster, and reads as the value it is.
- `for`/`else` is legal but widely misread (the `else` runs on *no break*);
  prefer extracting the search into a function that returns early, or
  `next(..., default)`.
- Comments are a last resort: if one is needed to say *what* the code does,
  rename or extract until it isn't, then delete it. The survivors explain *why*
  — a constraint, a workaround, a rejected alternative. Docstrings are separate:
  they're the caller-facing contract (what, args, returns, raises), not
  commentary on the body.
- Imports at the top, three groups (stdlib / third-party / local), no wildcard.
  A function-local import is a smell with two excuses: breaking an import cycle
  (fix the cycle) or a genuinely heavy optional dependency.
- `float` never touches money; `datetime.now()` without `tz=` is a naive time
  bomb; `time.perf_counter()` for measuring, not `time.time()`.
- When you need randomness for security — tokens, resets — `secrets`, never
  `random`.
