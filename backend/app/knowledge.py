"""Owner knowledge loaded from ``knowledge/``: profile, style guide and numbered FAQ.

Also implements the FAQ lookups shared by the ``faq_tool`` and the ``Qn``
instant-answer shortcut (which answers with no LLM call).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

INSTANT_PATTERN = re.compile(r"^[qQ](\d{1,2})$")

# Appended after each faq_tool answer, right where the model starts writing: small models
# otherwise paste a FAQ answer untranslated. Nothing here names a language: which
# languages the twin may reply in is the owner's call, made in the "## Language" section
# of knowledge/style.md (quoted after this note when present).
FAQ_LANGUAGE_NOTE = (
    "Write your reply in the language of the visitor's latest message, judged from the visitor's own "
    "words rather than any project or product names in it. If this answer is written in a different "
    "language from your reply, translate the whole answer into the reply language: the bold title line "
    '(dates included), the prose and every link label. Link labels such as "Live demo" or "Code on '
    'GitHub" are ordinary words, not names, so they are translated too. Keep the same facts, markdown '
    "and URLs; project and product names stay as they are."
)
LANGUAGE_HEADING = "Language"
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


@dataclass(frozen=True)
class FAQ:
    number: int
    question: str
    answer: str
    query: str


@dataclass(frozen=True)
class Knowledge:
    profile: str
    style: str
    faqs: dict[int, FAQ] = field(default_factory=dict)

    @property
    def faq_numbers(self) -> list[int]:
        return sorted(self.faqs)

    @property
    def language_rules(self) -> str:
        """The "## Language" section of style.md ('' when the style guide has none)."""
        return markdown_section(self.style, LANGUAGE_HEADING)

    def faq_range_text(self) -> str:
        numbers = self.faq_numbers
        if not numbers:
            return "no FAQ entries"
        return f"Q{numbers[0]} to Q{numbers[-1]}"


def markdown_section(text: str, heading: str) -> str:
    """The body of the first markdown section titled ``heading`` (case-insensitive).

    The body runs to the next heading of the same or a higher level; '' when absent.
    """
    lines = text.splitlines()
    for start, line in enumerate(lines):
        match = _HEADING.match(line.strip())
        if not match or match.group(2).strip().lower() != heading.strip().lower():
            continue
        level = len(match.group(1))
        body: list[str] = []
        for following in lines[start + 1 :]:
            nested = _HEADING.match(following.strip())
            if nested and len(nested.group(1)) <= level:
                break
            body.append(following)
        return "\n".join(body).strip()
    return ""


def faq_language_note(knowledge: Knowledge) -> str:
    """The language reminder that follows every faq_tool answer.

    Quotes the style guide's Language rules, so the concrete languages are right next to
    the answer, while the code itself stays owner-agnostic. The rules come first and the
    generic reminder last: ending on the owner's own words (which list the languages the
    owner speaks) made the small model answer a question in one of those languages instead
    of the visitor's (9% of runs on openai/gpt-5.4-nano, 2% with this order).
    """
    rules = " ".join(knowledge.language_rules.split())
    if not rules:
        return FAQ_LANGUAGE_NOTE
    return f"The Language rules in the style guide: {rules}\n{FAQ_LANGUAGE_NOTE}"


def load_faqs(path: Path) -> dict[int, FAQ]:
    faqs: dict[int, FAQ] = {}
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                number = int(row["faq"])
                faqs[number] = FAQ(
                    number=number,
                    question=str(row["question"]).strip(),
                    answer=str(row["answer"]).strip(),
                    query=str(row.get("query") or row["question"]).strip(),
                )
            except (ValueError, KeyError, TypeError) as exc:
                raise ValueError(f"{path}:{line_number}: invalid FAQ row ({exc})") from exc
    return dict(sorted(faqs.items()))


def load_knowledge(directory: Path) -> Knowledge:
    """Read knowledge.md, style.md and faq.jsonl from ``directory``."""
    directory = Path(directory)
    return Knowledge(
        profile=(directory / "knowledge.md").read_text(encoding="utf-8").strip(),
        style=(directory / "style.md").read_text(encoding="utf-8").strip(),
        faqs=load_faqs(directory / "faq.jsonl"),
    )


def parse_instant_request(message: str) -> int | None:
    """Return n if the message is a bare ``Qn`` (e.g. "Q2", " q16 "), else None."""
    match = INSTANT_PATTERN.match(message.strip())
    return int(match.group(1)) if match else None


def instant_answer(knowledge: Knowledge, number: int) -> str:
    """Content for the ``Qn`` shortcut: the full original question, then the answer."""
    faq = knowledge.faqs.get(number)
    if faq is None:
        return (
            f"There is no **Q{number}** in my FAQ. Questions "
            f"**{knowledge.faq_range_text()}** are available: type one (for example `Q2`) "
            "for an instant answer, or just ask me in your own words."
        )
    return f"**Q{faq.number}:** {faq.question}\n\n{faq.answer}"


def faq_tool_output(knowledge: Knowledge, number: int, owner_first_name: str) -> str:
    """What ``faq_tool`` returns to the model: the full original question and answer."""
    faq = knowledge.faqs.get(number)
    if faq is None:
        return (
            f"There is no FAQ entry number {number}. Valid numbers are "
            f"{knowledge.faq_range_text().replace('Q', '')}."
        )
    return (
        f"### FAQ {faq.number} - question:\n{faq.question}\n\n"
        f"### {owner_first_name}'s answer (relay it faithfully; keep the markdown and every link, and "
        f"translate it into your reply language if it is written in another one):\n{faq.answer}\n\n"
        f"### Language\n{faq_language_note(knowledge)}"
    )
