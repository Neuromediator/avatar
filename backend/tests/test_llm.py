"""Real LLM runs through OpenRouter (cheap model). Run with: pytest -m llm

Always forces MODEL=openai/gpt-5.4-nano regardless of .env. Pushover is mocked (the
autouse fixture in conftest). Uses the real Supabase repository when credentials are
available, otherwise the in-memory fake. Visitor names start with "TEST"; each test
deletes exactly the conversations it created (fresh uuid4s) and nothing else.

Assertions check behaviour (which tool ran, what was stored, which facts or language
the reply carries), never exact model wording.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.db import SupabaseRepository
from app.main import create_app

from .conftest import FakeRepository, parse_sse

CHEAP_MODEL = "openai/gpt-5.4-nano"
_env = load_settings()

# How a reply says the owner HAS been told: "passed your question on to", "passed your exact
# question to", "notified", "forwarded", "let him know", "flagged it for", "sent it to", ...
# Only done-or-doing forms count: an offer ("I can pass this to Sergei") after push_tool
# already ran does not tell the visitor it has been done.
PASSED_ON = re.compile(
    r"\bpass(?:ed|ing)\b[^.!?\n]{0,60}?\b(?:on|along|over|to)\b"
    r"|\bnotified\b|\bforward(?:ed|ing)\b|\blet (?:him|her|them|\w+) know\b|\bflagged\b|\bsent\b"
    r"|\bshared (?:it|this|your \w+) with\b|\breached out\b|\balerted\b",
    re.IGNORECASE,
)


pytestmark = [
    pytest.mark.llm,
    pytest.mark.skipif(not _env.openrouter_api_key, reason="OPENROUTER_API_KEY not configured"),
]


@pytest.fixture
def llm_app(tmp_path):
    from dataclasses import replace

    settings = replace(_env, model=CHEAP_MODEL, static_dir=tmp_path / "no-dist", cookie_secure=False)
    if settings.supabase_url and settings.supabase_key:
        repository = SupabaseRepository(settings.supabase_url, settings.supabase_key)
    else:
        repository = FakeRepository()
    app = create_app(settings, repository=repository)
    assert app.state.agent.model.model == CHEAP_MODEL
    created: list[str] = []
    app.state.test_created = created
    try:
        yield app
    finally:
        for cid in created:
            asyncio.run(repository.delete_conversation(cid))


def run_chat(client, cid, message, name=None):
    response = client.post("/api/chat", json={"conversation_id": cid, "message": message, "name": name}, timeout=180)
    assert response.status_code == 200, response.text
    return parse_sse(response.text)


def test_real_streamed_chat_stores_reply(llm_app):
    cid = str(uuid.uuid4())
    llm_app.state.test_created.append(cid)
    with TestClient(llm_app) as client:
        events = run_chat(client, cid, "Hi! In two sentences, what do you work on these days?", name="TEST LLM")
        kinds = [e for e, _ in events]
        assert kinds[0] == "start"
        assert kinds[-1] == "done", events[-1]
        deltas = [d["text"] for e, d in events if e == "delta"]
        assert len(deltas) >= 1
        done = events[-1][1]["message"]
        assert done["role"] == "avatar" and done["content"].strip()

        history = client.get(f"/api/conversations/{cid}").json()
        assert [m["role"] for m in history["messages"]] == ["visitor", "avatar"]
        assert history["messages"][-1]["content"] == done["content"]
        assert history["conversation_name"] == "TEST LLM"


def test_real_chat_uses_faq_tool(llm_app):
    knowledge = llm_app.state.knowledge
    target = next((f for f in knowledge.faqs.values() if "](http" in f.answer), next(iter(knowledge.faqs.values())))
    links = re.findall(r"\]\((https?://[^)\s]+)\)", target.answer)
    cid = str(uuid.uuid4())
    llm_app.state.test_created.append(cid)
    with TestClient(llm_app) as client:
        events = run_chat(client, cid, f"Tell me about this, please: {target.query}")
        assert events[-1][0] == "done", events[-1]
        called = [d for e, d in events if e == "tool_called"]
        faq_calls = [json.loads(c["arguments"]) for c in called if c["name"] == "faq_tool"]
        assert any(a.get("question_number") == target.number for a in faq_calls), called
        assert [e for e, _ in events].count("tool_output") >= 1
        stored = events[-1][1]["message"]
        assert stored["tool_calls"] and stored["tool_calls"][0]["type"] == "function"
        if links:
            assert any(link in stored["content"] for link in links), stored["content"]


def test_real_contact_capture_pushes_and_flags(llm_app, pushover):
    cid = str(uuid.uuid4())
    llm_app.state.test_created.append(cid)
    with TestClient(llm_app) as client:
        events = run_chat(
            client, cid,
            f"I'd like to discuss a possible AI engineering role with {_env.owner_first_name}. "
            "Please pass on my email: llm-test@example.com",
            name="TEST Recruiter",
        )
        assert events[-1][0] == "done", events[-1]
        called = [d["name"] for e, d in events if e == "tool_called"]
        assert "push_tool" in called, called
        assert len(pushover.calls) >= 1
        assert "llm-test@example.com" in pushover.calls[0]["message"]
        assert cid in pushover.calls[0]["message"]

        # The admin view shows the conversation as needing attention.
        client.post("/admin/login", json={"password": _env.admin_password})
        inbox = client.get("/admin/api/conversations").json()["conversations"]
        mine = [c for c in inbox if c["conversation_id"] == cid]
        assert mine and mine[0]["needs_attention"] is True


def new_conversation(app) -> str:
    cid = str(uuid.uuid4())
    app.state.test_created.append(cid)
    return cid


def tool_names(events) -> list[str]:
    return [d["name"] for e, d in events if e == "tool_called"]


def test_real_qn_shortcut_makes_no_llm_call(llm_app, monkeypatch):
    from app import agent as agent_module

    real_stream = agent_module.stream_agent_events
    runs = []

    async def spy(agent, prompt, context):
        runs.append(prompt)
        async for item in real_stream(agent, prompt, context):
            yield item

    monkeypatch.setattr(agent_module, "stream_agent_events", spy)
    knowledge = llm_app.state.knowledge
    cid = new_conversation(llm_app)
    with TestClient(llm_app) as client:
        events = run_chat(client, cid, "Q2", name="TEST Instant")
        assert [e for e, _ in events] == ["start", "instant", "delta", "done"]
        faq = knowledge.faqs[2]
        assert events[-1][1]["message"]["content"] == f"**Q2:** {faq.question}\n\n{faq.answer}"
        assert runs == []  # the shortcut never reached the agent
        # The spy does see a normal message, so the zero above is meaningful.
        events = run_chat(client, cid, "Thanks! Could you say that again in one short sentence?", name="TEST Instant")
        assert events[-1][0] == "done", events[-1]
        assert len(runs) == 1
        assert "instant FAQ answer Q2" in runs[0]  # the later prompt records the instant answer


def test_real_unknown_question_pushes_the_owner(llm_app, pushover):
    knowledge = llm_app.state.knowledge
    if "favourite programming language" in knowledge.profile.lower():
        pytest.skip("the profile answers this question")
    cid = new_conversation(llm_app)
    with TestClient(llm_app) as client:
        events = run_chat(client, cid, "What is your favourite programming language, and why?", name="TEST Unknown")
        assert events[-1][0] == "done", events[-1]
        assert "push_tool" in tool_names(events), (tool_names(events), events[-1][1]["message"]["content"])
        assert len(pushover.calls) >= 1 and cid in pushover.calls[0]["message"]
        assert "programming language" in pushover.calls[0]["message"].lower()
        outputs = [d for e, d in events if e == "tool_output" and d["name"] == "push_tool"]
        assert outputs and outputs[0]["ok"] is True
        stored = client.get(f"/api/conversations/{cid}").json()["messages"][-1]
        assert any(c["name"] == "push_tool" for c in stored["tool_calls"])
        # The reply tells the visitor, in the chat, that the question went to the owner
        # (SPEC reference push.py; ux-flows.md F2), naming the owner like the two-turn test.
        reply = events[-1][1]["message"]["content"]
        assert _env.owner_first_name in reply, reply
        assert PASSED_ON.search(reply), reply


def test_real_two_turn_contact_capture_asks_for_email_then_pushes(llm_app, pushover):
    first = _env.owner_first_name
    email = "test-llm-contact@example.com"
    cid = new_conversation(llm_app)
    with TestClient(llm_app) as client:
        events = run_chat(client, cid, f"Hi, I'd like to get in touch with {first} about a freelance AI project.",
                          name="TEST Contact")
        assert events[-1][0] == "done", events[-1]
        reply = events[-1][1]["message"]["content"].lower()
        assert "email" in reply or "e-mail" in reply, reply  # asks for the email address

        events = run_chat(client, cid, f"Sure, my email is {email}", name="TEST Contact")
        assert events[-1][0] == "done", events[-1]
        assert any(email in call["message"] for call in pushover.calls), pushover.calls
        assert any(cid in call["message"] for call in pushover.calls)
        reply = events[-1][1]["message"]["content"]
        assert first in reply  # tells the visitor the owner has been notified


def test_real_owner_message_in_transcript_is_respected(llm_app):
    repo = llm_app.state.repository
    owner, first = _env.owner_name, _env.owner_first_name
    cid = new_conversation(llm_app)
    asyncio.run(repo.insert_message(cid, "visitor", "Could we set up a short call?", conversation_name="TEST Owner"))
    asyncio.run(repo.insert_message(cid, "avatar", f"I have passed your request on to {first}."))
    asyncio.run(repo.insert_message(cid, "human", f"Hi, {owner} here. Thursday afternoon works best for me for the call.",
                                    read=True))
    with TestClient(llm_app) as client:
        events = run_chat(client, cid, "Great. Which day works for the call?", name="TEST Owner")
        assert events[-1][0] == "done", events[-1]
        reply = events[-1][1]["message"]["content"]
        assert "thursday" in reply.lower(), reply
        rows = client.get(f"/api/conversations/{cid}").json()["messages"]
        assert [m["role"] for m in rows] == ["visitor", "avatar", "human", "visitor", "avatar"]


def test_real_faq_answer_is_translated_when_the_style_guide_allows(llm_app):
    """The language rules live in style.md; a question in an allowed language gets the FAQ
    answer translated into it (prose and link labels), with every URL kept."""
    knowledge = llm_app.state.knowledge
    if "russian" not in knowledge.language_rules.lower():
        pytest.skip("the style guide does not allow Russian replies")
    # A prose answer with a bold project title and labelled links (e.g. a project entry).
    target = next((f for f in knowledge.faqs.values()
                   if re.match(r"\*\*[^*]+\*\*", f.answer) and re.search(r"\[[^\]]+\]\(https?://", f.answer)), None)
    if target is None:
        pytest.skip("no FAQ entry with a bold title and links")
    project = re.match(r"\*\*([^*]+)\*\*", target.answer).group(1)
    urls = re.findall(r"\]\((https?://[^)\s]+)\)", target.answer)
    labels = re.findall(r"\[([^\]]+)\]\(https?://", target.answer)
    cid = new_conversation(llm_app)
    with TestClient(llm_app) as client:
        events = run_chat(client, cid, f"Расскажи, пожалуйста, про проект {project}", name="TEST Язык")
        assert events[-1][0] == "done", events[-1]
        faq_calls = [json.loads(d["arguments"]) for e, d in events if e == "tool_called" and d["name"] == "faq_tool"]
        assert any(a.get("question_number") == target.number for a in faq_calls), faq_calls
        reply = events[-1][1]["message"]["content"]
        for url in urls:
            assert url in reply, reply  # links kept
        # Link labels are translated too (nano occasionally leaves one, so not all must be).
        untranslated = [label for label in labels if f"[{label}](" in reply]
        assert len(untranslated) < len(labels), reply
        # The prose is in Russian: an untranslated paste scores near 0, a translation ~0.75
        # (technology names such as "FastAPI" stay in Latin script).
        prose = re.sub(r"\(https?://[^)\s]+\)", "", reply).replace(project, "")
        letters = [ch for ch in prose if ch.isalpha()]
        cyrillic = [ch for ch in letters if "\u0400" <= ch <= "\u04ff"]
        assert len(cyrillic) > 0.5 * len(letters), reply
