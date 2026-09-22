"""The Avatar agent: OpenAI Agents SDK over OpenRouter, its tools, and streaming.

How the SDK is used (openai-agents 0.17.4, following the official docs):

* **OpenRouter as the provider.** The Models guide, section "Non-OpenAI models"
  (https://openai.github.io/openai-agents-python/models/#non-openai-models), lists the
  built-in integration points for an OpenAI-compatible endpoint and shows the canonical
  snippet::

      set_tracing_disabled(disabled=True)
      client = AsyncOpenAI(api_key="Api_Key", base_url="Base URL of Provider")
      model = OpenAIChatCompletionsModel(model="Model_Name", openai_client=client)
      agent = Agent(name=..., instructions=..., model=model)

  We have exactly one agent and one provider, so we use the per-agent path
  (``Agent.model``, see examples/model_providers/custom_example_agent.py): an
  ``AsyncOpenAI(base_url="https://openrouter.ai/api/v1", api_key=OPENROUTER_API_KEY)``
  client wrapped in ``OpenAIChatCompletionsModel(model=settings.model, ...)``. The
  Chat Completions model is used because, per the docs' note and the "Responses API
  support" troubleshooting section, many providers do not support the Responses API.
  The literal OpenRouter model id (e.g. ``openai/gpt-5.4-nano``) is passed straight
  through as the ``model`` field; nothing strips the ``openai/`` prefix on this path.
  This scopes OpenRouter to this agent and leaves the SDK's global OpenAI defaults
  untouched (unlike ``set_default_openai_client``).
* **Tracing disabled.** Traces upload to OpenAI and we have no platform.openai.com
  key, so per "Troubleshooting non-OpenAI providers > Tracing client error 401" and
  https://openai.github.io/openai-agents-python/tracing/ we call
  ``set_tracing_disabled(True)``.
* **Streaming.** ``Runner.run_streamed(...)`` + ``result.stream_events()``
  (https://openai.github.io/openai-agents-python/streaming/): ``raw_response_event``
  whose ``data`` is a ``ResponseTextDeltaEvent`` carries text deltas;
  ``run_item_stream_event`` named ``tool_called`` / ``tool_output`` carries tool
  activity (call_id / name / arguments from the raw tool call item). The stream is
  consumed to the end, then ``result.final_output`` is the reply.
* **Model settings.** ``ModelSettings(reasoning=Reasoning(effort="low"))`` (Models guide,
  "Common advanced ModelSettings options"); on the Chat Completions path the SDK sends it
  as ``reasoning_effort``, which OpenRouter accepts for OpenAI models.
* **Tools and context.** ``@function_tool`` async functions with Google-style
  docstrings (https://openai.github.io/openai-agents-python/tools/); ``push_tool``
  takes ``RunContextWrapper[ChatContext]`` as its first parameter to reach the local
  run context (https://openai.github.io/openai-agents-python/context/ - the context
  object is never sent to the LLM).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import requests
from agents import (
    Agent,
    ModelSettings,
    OpenAIChatCompletionsModel,
    RunContextWrapper,
    Runner,
    function_tool,
    set_tracing_disabled,
)
from openai import AsyncOpenAI
from openai.types.responses import ResponseTextDeltaEvent
from openai.types.shared import Reasoning

from .config import OPENROUTER_BASE_URL, Settings
from .knowledge import Knowledge, faq_tool_output
from .prompts import build_instructions

logger = logging.getLogger("avatar.agent")

PUSHOVER_URL = "https://api.pushover.net/1/messages.json"
PUSHOVER_TIMEOUT_SECONDS = 10
PUSHOVER_MAX_MESSAGE = 1024

AgentEvent = tuple[str, dict[str, Any]]


@dataclass
class ChatContext:
    """Local run context shared with the tools (never sent to the LLM)."""

    conversation_id: str
    visitor_name: str | None
    settings: Settings
    knowledge: Knowledge
    pushed: bool = False
    tool_log: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Pushover
# ---------------------------------------------------------------------------


def send_pushover(user: str, token: str, message: str, title: str | None = None) -> int:
    """POST a Pushover notification (blocking). Returns the HTTP status code."""
    payload = {"user": user, "token": token, "message": message[:PUSHOVER_MAX_MESSAGE]}
    if title:
        payload["title"] = title[:250]
    response = requests.post(PUSHOVER_URL, data=payload, timeout=PUSHOVER_TIMEOUT_SECONDS)
    return response.status_code


async def notify_owner(ctx: ChatContext, message: str) -> str:
    """Send ``message`` to the owner via Pushover without blocking the event loop.

    Always flags the conversation (``ctx.pushed``) so the admin dashboard marks it as
    needing attention, even when the push itself cannot be delivered.
    """
    ctx.pushed = True
    first = ctx.settings.owner_first_name
    who = ctx.visitor_name or "an anonymous visitor"
    body = f"{message.strip()}\n\nFrom: {who}\nConversation: {ctx.conversation_id}"
    title = f"Avatar: {ctx.visitor_name}" if ctx.visitor_name else "Avatar: new visitor request"

    # The tool output is the last thing the model reads before it writes, so it also says
    # what the reply must tell the visitor (SPEC: mention in the chat that it's done that).
    flagged_only = (
        f"Tell the visitor in your reply that you have flagged this for {first}, who will see it in the dashboard; "
        "do not claim a phone notification."
    )
    user, token = ctx.settings.pushover_user, ctx.settings.pushover_token
    if not user or not token:
        logger.warning("Pushover credentials missing; conversation %s flagged only.", ctx.conversation_id)
        result = (
            f"Push notifications are not configured, so no phone notification was sent. "
            f"The conversation has been flagged for {first} in the admin dashboard. {flagged_only}"
        )
    else:
        try:
            status = await asyncio.to_thread(send_pushover, user, token, body, title)
        except requests.RequestException as exc:
            logger.warning("Pushover request failed for %s: %s", ctx.conversation_id, exc)
            status = None
        if status == 200:
            result = (
                f"Notification delivered to {first}. The conversation is flagged in the admin dashboard. "
                f"Tell the visitor in your reply that you have passed this on to {first}."
            )
        else:
            logger.warning("Pushover returned status %s for %s", status, ctx.conversation_id)
            result = (
                f"The push notification failed (status {status}). "
                f"The conversation is still flagged for {first} in the admin dashboard. {flagged_only}"
            )
    ctx.tool_log.append({"name": "push_tool", "message": message, "result": result})
    return result


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@function_tool
async def faq_tool(wrapper: RunContextWrapper[ChatContext], question_number: int) -> str:
    """Retrieve a frequently asked question and the owner's own answer by its number.

    Use it whenever the visitor's question matches an entry in the numbered FAQ list,
    then relay the answer faithfully in its original markdown, keeping every link,
    translated into your reply language if it is written in another language.

    Args:
        question_number: The FAQ number from the list in your instructions (e.g. 12).
    """
    ctx = wrapper.context
    output = faq_tool_output(ctx.knowledge, question_number, ctx.settings.owner_first_name)
    ctx.tool_log.append({"name": "faq_tool", "question_number": question_number})
    return output


@function_tool
async def push_tool(wrapper: RunContextWrapper[ChatContext], message: str) -> str:
    """Send a push notification to the real owner's phone and flag this conversation.

    Use it when the visitor wants to get in touch (after they give their email), when
    they mention a job, project or collaboration, when they ask something you cannot
    answer from your knowledge, or when they ask for the real person. The visitor's
    name and the conversation id are attached automatically.

    Args:
        message: A short, self-contained note for the owner: who the visitor is, what
            they want, their email if given, and their question quoted.
    """
    return await notify_owner(wrapper.context, message)


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


def build_model(settings: Settings) -> OpenAIChatCompletionsModel:
    """OpenRouter through the SDK's documented OpenAI-compatible path."""
    if not settings.openrouter_api_key:
        logger.warning("OPENROUTER_API_KEY is not set; LLM calls will fail.")
    client = AsyncOpenAI(
        base_url=OPENROUTER_BASE_URL,
        api_key=settings.openrouter_api_key or "missing-openrouter-key",
        timeout=90.0,
        max_retries=2,
    )
    return OpenAIChatCompletionsModel(model=settings.model, openai_client=client)


def build_agent(settings: Settings, knowledge: Knowledge) -> Agent[ChatContext]:
    """Build the Avatar agent once at startup (the knowledge is static)."""
    set_tracing_disabled(True)
    return Agent[ChatContext](
        name=f"{settings.owner_name} digital twin",
        instructions=build_instructions(settings, knowledge),
        model=build_model(settings),
        # A little reasoning makes tool use (FAQ routing, push on unknowns) markedly more
        # reliable on small models, for ~1 s of extra latency.
        model_settings=ModelSettings(reasoning=Reasoning(effort="low")),
        tools=[faq_tool, push_tool],
    )


def _arguments_text(raw_arguments: Any) -> str:
    if raw_arguments is None:
        return "{}"
    if isinstance(raw_arguments, str):
        return raw_arguments
    return json.dumps(raw_arguments, ensure_ascii=False)


def _raw_field(raw_item: Any, name: str) -> Any:
    if isinstance(raw_item, dict):
        return raw_item.get(name)
    return getattr(raw_item, name, None)


async def stream_agent_events(
    agent: Agent[ChatContext], prompt: str, context: ChatContext
) -> AsyncIterator[AgentEvent]:
    """Run the agent and yield simplified events.

    Yields ``("tool_called", {call_id, name, arguments})``,
    ``("tool_output", {call_id, name, output})``, ``("delta", {text})`` and finally
    ``("final", {text})``. This is the single seam tests replace with a fake stream.
    """
    result = Runner.run_streamed(agent, input=prompt, context=context)
    names: dict[str, str] = {}
    async for event in result.stream_events():
        if event.type == "raw_response_event":
            if isinstance(event.data, ResponseTextDeltaEvent) and event.data.delta:
                yield "delta", {"text": event.data.delta}
        elif event.type == "run_item_stream_event":
            if event.name == "tool_called":
                raw = event.item.raw_item
                call_id = str(_raw_field(raw, "call_id") or _raw_field(raw, "id") or "")
                name = str(_raw_field(raw, "name") or getattr(event.item, "tool_name", "") or "tool")
                names[call_id] = name
                yield "tool_called", {
                    "call_id": call_id,
                    "name": name,
                    "arguments": _arguments_text(_raw_field(raw, "arguments")),
                }
            elif event.name == "tool_output":
                call_id = str(getattr(event.item, "call_id", None) or "")
                yield "tool_output", {
                    "call_id": call_id,
                    "name": names.get(call_id, "tool"),
                    "output": str(getattr(event.item, "output", "")),
                }
    final = result.final_output
    yield "final", {"text": final if isinstance(final, str) else str(final or "")}
