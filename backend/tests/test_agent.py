"""The Agents SDK wiring: OpenRouter model, tools, push behaviour, stream adapter."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
import requests
from agents import Agent, FunctionTool, OpenAIChatCompletionsModel
from agents.items import ToolCallItem, ToolCallOutputItem
from agents.stream_events import RawResponsesStreamEvent, RunItemStreamEvent
from openai.types.responses import ResponseFunctionToolCall, ResponseTextDeltaEvent

from app import agent as agent_module
from app.agent import ChatContext, build_agent, notify_owner
from app.config import OPENROUTER_BASE_URL
from app.knowledge import load_knowledge
from app.prompts import push_delivered

from .conftest import make_settings

# Captured at import, before the autouse fixture swaps it for a recorder.
REAL_SEND_PUSHOVER = agent_module.send_pushover


@pytest.fixture(scope="module")
def knowledge():
    return load_knowledge(make_settings().knowledge_dir)


def make_ctx(knowledge, **overrides):
    settings = overrides.pop("settings", make_settings())
    return ChatContext(conversation_id="11111111-2222-3333-4444-555555555555", visitor_name=overrides.pop("visitor_name", "Jordan"),
                       settings=settings, knowledge=knowledge)


# ---------------------------------------------------------------------------
# Agent construction
# ---------------------------------------------------------------------------


def test_agent_uses_openrouter_chat_completions_model(knowledge):
    settings = make_settings(model="openai/gpt-5.4-nano", openrouter_api_key="sk-or-abc")
    agent = build_agent(settings, knowledge)
    assert isinstance(agent, Agent)
    assert isinstance(agent.model, OpenAIChatCompletionsModel)
    assert agent.model.model == "openai/gpt-5.4-nano"  # literal OpenRouter id, prefix kept
    client = agent.model._client
    assert str(client.base_url).rstrip("/") == OPENROUTER_BASE_URL
    assert client.api_key == "sk-or-abc"
    assert {t.name for t in agent.tools} == {"faq_tool", "push_tool"}
    assert all(isinstance(t, FunctionTool) for t in agent.tools)
    assert settings.owner_name in agent.instructions


def test_tracing_is_disabled(knowledge):
    from agents.tracing import get_trace_provider

    build_agent(make_settings(), knowledge)
    provider = get_trace_provider()
    assert getattr(provider, "_disabled", None) is True


def test_tool_schemas_hide_context_parameter(knowledge):
    tools = {t.name: t for t in build_agent(make_settings(), knowledge).tools}
    faq_schema = tools["faq_tool"].params_json_schema
    assert list(faq_schema["properties"]) == ["question_number"]
    assert faq_schema["properties"]["question_number"]["type"] == "integer"
    push_schema = tools["push_tool"].params_json_schema
    assert list(push_schema["properties"]) == ["message"]
    assert "push notification" in tools["push_tool"].description.lower()
    assert "faq" in tools["faq_tool"].description.lower()


def invoke_tool(tool: FunctionTool, ctx: ChatContext, args: dict) -> str:
    from agents.tool_context import ToolContext

    tool_ctx = ToolContext(context=ctx, tool_name=tool.name, tool_call_id="call_x", tool_arguments=json.dumps(args))
    return asyncio.run(tool.on_invoke_tool(tool_ctx, json.dumps(args)))


def test_faq_tool_returns_full_answer(knowledge):
    tools = {t.name: t for t in build_agent(make_settings(), knowledge).tools}
    ctx = make_ctx(knowledge)
    output = invoke_tool(tools["faq_tool"], ctx, {"question_number": 12})
    faq = knowledge.faqs[12]
    assert faq.question in output and faq.answer in output
    assert ctx.pushed is False
    unknown = invoke_tool(tools["faq_tool"], ctx, {"question_number": 404})
    assert "no FAQ entry number 404" in unknown


def test_push_tool_via_sdk_invocation(knowledge, pushover):
    tools = {t.name: t for t in build_agent(make_settings(), knowledge).tools}
    ctx = make_ctx(knowledge)
    output = invoke_tool(tools["push_tool"], ctx, {"message": "Jordan wants to talk (j@x.io)"})
    assert "Notification delivered" in output
    assert ctx.pushed is True
    assert len(pushover.calls) == 1
    call = pushover.calls[0]
    assert "Jordan wants to talk (j@x.io)" in call["message"]
    assert "From: Jordan" in call["message"]
    assert ctx.conversation_id in call["message"]
    assert ctx.tool_log and ctx.tool_log[-1]["name"] == "push_tool"


# ---------------------------------------------------------------------------
# notify_owner edge cases
# ---------------------------------------------------------------------------


def test_push_without_credentials_flags_but_does_not_send(knowledge, pushover, caplog):
    ctx = make_ctx(knowledge, settings=make_settings(pushover_user="", pushover_token=""))
    output = asyncio.run(notify_owner(ctx, "question"))
    assert ctx.pushed is True
    assert pushover.calls == []
    assert "not configured" in output
    assert "flagged" in output
    assert any("Pushover credentials missing" in r.message for r in caplog.records)


def test_push_http_failure(knowledge, pushover):
    pushover.status = 500
    ctx = make_ctx(knowledge)
    output = asyncio.run(notify_owner(ctx, "question"))
    assert ctx.pushed is True
    assert "failed" in output and "500" in output


def test_push_network_error(knowledge, pushover):
    pushover.exc = requests.ConnectionError("unreachable")
    ctx = make_ctx(knowledge)
    output = asyncio.run(notify_owner(ctx, "question"))
    assert ctx.pushed is True
    assert "failed" in output


def test_push_anonymous_visitor(knowledge, pushover):
    ctx = make_ctx(knowledge, visitor_name=None)
    asyncio.run(notify_owner(ctx, "question"))
    assert "anonymous visitor" in pushover.calls[0]["message"]


def test_send_pushover_posts_form_data_with_timeout(monkeypatch):
    captured = {}

    def fake_post(url, data=None, timeout=None):
        captured.update(url=url, data=data, timeout=timeout)
        return SimpleNamespace(status_code=200)

    monkeypatch.setattr(agent_module.requests, "post", fake_post)
    status = REAL_SEND_PUSHOVER("user-1", "token-1", "m" * 5000, title="T")
    assert status == 200
    assert captured["url"] == "https://api.pushover.net/1/messages.json"
    assert captured["timeout"] == 10
    assert captured["data"]["user"] == "user-1" and captured["data"]["token"] == "token-1"
    assert len(captured["data"]["message"]) == 1024
    assert captured["data"]["title"] == "T"


def test_push_does_not_block_event_loop(knowledge, monkeypatch):
    """The blocking HTTP call runs in a worker thread."""
    import threading
    import time

    main_thread = threading.get_ident()
    seen = {}

    def slow_push(user, token, message, title=None):
        seen["thread"] = threading.get_ident()
        time.sleep(0.2)
        return 200

    monkeypatch.setattr(agent_module, "send_pushover", slow_push)

    async def scenario():
        ctx = make_ctx(knowledge)
        ticks = 0

        async def ticker():
            nonlocal ticks
            for _ in range(10):
                await asyncio.sleep(0.01)
                ticks += 1

        await asyncio.gather(notify_owner(ctx, "hi"), ticker())
        return ticks

    ticks = asyncio.run(scenario())
    assert ticks == 10
    assert seen["thread"] != main_thread


# ---------------------------------------------------------------------------
# stream_agent_events adapter (SDK stream -> simplified events), no network
# ---------------------------------------------------------------------------


class FakeRunResult:
    def __init__(self, events, final_output):
        self._events = events
        self.final_output = final_output

    async def stream_events(self):
        for event in self._events:
            yield event


def text_delta(text: str) -> RawResponsesStreamEvent:
    return RawResponsesStreamEvent(
        data=ResponseTextDeltaEvent(
            content_index=0, delta=text, item_id="msg_1", logprobs=[], output_index=0,
            sequence_number=1, type="response.output_text.delta",
        )
    )


def test_stream_adapter_maps_sdk_events(knowledge, monkeypatch):
    agent = build_agent(make_settings(), knowledge)
    raw_call = ResponseFunctionToolCall(
        arguments='{"question_number": 12}', call_id="call_abc", name="faq_tool", type="function_call", id="fc_1",
    )
    events = [
        SimpleNamespace(type="agent_updated_stream_event", new_agent=agent),
        RunItemStreamEvent(name="tool_called", item=ToolCallItem(agent=agent, raw_item=raw_call)),
        RunItemStreamEvent(
            name="tool_output",
            item=ToolCallOutputItem(
                agent=agent,
                raw_item={"type": "function_call_output", "call_id": "call_abc", "output": "FAQ text"},
                output="FAQ text",
            ),
        ),
        text_delta("Hello "),
        text_delta(""),
        text_delta("world"),
        RunItemStreamEvent(name="message_output_created", item=SimpleNamespace()),
    ]
    captured = {}

    def fake_run_streamed(starting_agent, input, context=None, **kwargs):
        captured.update(agent=starting_agent, input=input, context=context)
        return FakeRunResult(events, "Hello world")

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)
    ctx = make_ctx(knowledge)

    async def collect():
        return [e async for e in agent_module.stream_agent_events(agent, "THE PROMPT", ctx)]

    out = asyncio.run(collect())
    assert captured == {"agent": agent, "input": "THE PROMPT", "context": ctx}
    assert out == [
        ("tool_called", {"call_id": "call_abc", "name": "faq_tool", "arguments": '{"question_number": 12}'}),
        ("tool_output", {"call_id": "call_abc", "name": "faq_tool", "output": "FAQ text"}),
        ("delta", {"text": "Hello "}),
        ("delta", {"text": "world"}),
        ("final", {"text": "Hello world"}),
    ]


def test_stream_adapter_propagates_errors(knowledge, monkeypatch):
    agent = build_agent(make_settings(), knowledge)

    class Exploding:
        final_output = None

        async def stream_events(self):
            yield text_delta("partial")
            raise RuntimeError("provider failed")

    monkeypatch.setattr(agent_module.Runner, "run_streamed", lambda *a, **k: Exploding())

    async def collect():
        return [e async for e in agent_module.stream_agent_events(agent, "p", make_ctx(knowledge))]

    with pytest.raises(RuntimeError):
        asyncio.run(collect())


# ---------------------------------------------------------------------------
# Agent construction (additional)
# ---------------------------------------------------------------------------


def test_agent_model_settings_and_client_options(knowledge):
    from app.prompts import build_instructions

    settings = make_settings()
    agent = build_agent(settings, knowledge)
    assert agent.model_settings.reasoning is not None
    assert agent.model_settings.reasoning.effort == "low"
    client = agent.model._client
    assert client.timeout == 90.0
    assert client.max_retries == 2
    assert settings.owner_name in agent.name
    assert agent.instructions == build_instructions(settings, knowledge)
    assert agent.handoffs == []  # one agent, no handoffs


def test_agent_builds_without_api_key_and_warns(knowledge, caplog):
    with caplog.at_level("WARNING", logger="avatar.agent"):
        agent = build_agent(make_settings(openrouter_api_key=""), knowledge)
    assert agent.model._client.api_key == "missing-openrouter-key"
    assert any("OPENROUTER_API_KEY is not set" in r.message for r in caplog.records)


def test_agent_does_not_touch_the_global_openai_client(knowledge):
    """OpenRouter is scoped to this agent's model (no set_default_openai_client)."""
    from agents.models import _openai_shared

    before = _openai_shared.get_default_openai_client()
    build_agent(make_settings(openrouter_api_key="sk-or-scoped"), knowledge)
    assert _openai_shared.get_default_openai_client() is before


def test_model_id_comes_from_settings(knowledge):
    agent = build_agent(make_settings(model="openai/gpt-5.6-luna"), knowledge)
    assert agent.model.model == "openai/gpt-5.6-luna"


# ---------------------------------------------------------------------------
# Tools and Pushover (additional)
# ---------------------------------------------------------------------------


def test_faq_tool_logs_and_never_flags(knowledge, pushover):
    tools = {t.name: t for t in build_agent(make_settings(), knowledge).tools}
    ctx = make_ctx(knowledge)
    invoke_tool(tools["faq_tool"], ctx, {"question_number": 3})
    assert ctx.tool_log == [{"name": "faq_tool", "question_number": 3}]
    assert ctx.pushed is False and pushover.calls == []


def test_push_titles(knowledge, pushover):
    asyncio.run(notify_owner(make_ctx(knowledge, visitor_name="TEST Kim"), "hello"))
    asyncio.run(notify_owner(make_ctx(knowledge, visitor_name=None), "hello"))
    assert pushover.calls[0]["title"] == "Avatar: TEST Kim"
    assert pushover.calls[1]["title"] == "Avatar: new visitor request"


def test_push_body_layout(knowledge, pushover):
    ctx = make_ctx(knowledge, visitor_name="TEST Kim")
    asyncio.run(notify_owner(ctx, "  wants to talk about a role  "))
    assert pushover.calls[0]["message"] == (
        f"wants to talk about a role\n\nFrom: TEST Kim\nConversation: {ctx.conversation_id}"
    )


def test_push_result_texts_name_the_owner_from_config(knowledge, pushover):
    settings = make_settings(owner_name="Grace Hopper")
    ctx = make_ctx(knowledge, settings=settings)
    assert asyncio.run(notify_owner(ctx, "x")) == (
        "Notification delivered to Grace. The conversation is flagged in the admin dashboard. "
        "Tell the visitor in your reply that you have passed this on to Grace."
    )


FLAGGED_ONLY = (
    "Tell the visitor in your reply that you have flagged this for Grace, who will see it in the dashboard; "
    "do not claim a phone notification."
)


@pytest.mark.parametrize("case", ["not configured", "http error", "network error"])
def test_push_result_tells_the_model_what_to_say_to_the_visitor(knowledge, pushover, case):
    """SPEC reference push.py: after pushing, the Avatar mentions in the chat that it has done
    so. The tool output (the last thing the model reads) says what to tell the visitor, and
    never lets an undelivered push be described as a phone notification (Docker/LLM finding,
    2026-09-22: without it nano left the mention out of 7 of 20 replies)."""
    overrides = {"owner_name": "Grace Hopper"}
    if case == "not configured":
        overrides.update(pushover_user="", pushover_token="")
    elif case == "http error":
        pushover.status = 500
    else:
        pushover.exc = requests.ConnectionError("unreachable")
    ctx = make_ctx(knowledge, settings=make_settings(**overrides))
    output = asyncio.run(notify_owner(ctx, "x"))
    assert output.endswith(FLAGGED_ONLY)
    assert "passed this on" not in output
    assert push_delivered(output) is False


def test_delivered_push_result_is_classified_as_delivered(knowledge, pushover):
    ctx = make_ctx(knowledge)
    output = asyncio.run(notify_owner(ctx, "x"))
    assert "Tell the visitor in your reply that you have passed this on to" in output
    assert push_delivered(output) is True


def test_send_pushover_without_title_and_long_title(monkeypatch):
    captured = []
    monkeypatch.setattr(agent_module.requests, "post",
                        lambda url, data=None, timeout=None: captured.append(data) or SimpleNamespace(status_code=429))
    assert REAL_SEND_PUSHOVER("u", "t", "m") == 429
    assert "title" not in captured[0]
    REAL_SEND_PUSHOVER("u", "t", "m", title="T" * 400)
    assert len(captured[1]["title"]) == 250


def test_push_timeout_is_reported_as_failure(knowledge, pushover):
    pushover.exc = requests.Timeout("slow")
    ctx = make_ctx(knowledge)
    output = asyncio.run(notify_owner(ctx, "question"))
    assert ctx.pushed is True
    assert "failed" in output and "still flagged" in output


# ---------------------------------------------------------------------------
# Stream adapter (additional)
# ---------------------------------------------------------------------------


def test_stream_adapter_handles_dict_raw_items_and_missing_final(knowledge, monkeypatch):
    agent = build_agent(make_settings(), knowledge)
    raw_call = {"type": "function_call", "id": "fc_9", "name": "push_tool", "arguments": {"message": "hi"}}
    events = [
        RunItemStreamEvent(name="tool_called", item=SimpleNamespace(raw_item=raw_call)),
        RunItemStreamEvent(name="tool_output", item=SimpleNamespace(call_id="fc_9", output="Notification delivered")),
    ]
    monkeypatch.setattr(agent_module.Runner, "run_streamed", lambda *a, **k: FakeRunResult(events, None))

    async def collect():
        return [e async for e in agent_module.stream_agent_events(agent, "p", make_ctx(knowledge))]

    out = asyncio.run(collect())
    assert out == [
        ("tool_called", {"call_id": "fc_9", "name": "push_tool", "arguments": '{"message": "hi"}'}),
        ("tool_output", {"call_id": "fc_9", "name": "push_tool", "output": "Notification delivered"}),
        ("final", {"text": ""}),
    ]
