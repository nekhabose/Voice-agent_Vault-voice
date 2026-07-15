"""Performing ``Effect[]`` — the seam the plan describes in §10.4.

This module is the audio side of the boundary. It does **not** own control flow:
it never decides what to say next, never plans a sequence, never asks a model
whether it is time to move on. It receives an ``Effect`` (produced by the
TypeScript ``CallRuntime``, generated into Pydantic in ``contracts.py``) and does
the one dumb thing that effect names.

Deliberately not built here (see README): the LiveKit room, the SIP trunk, and
the realtime model. ``FakeVoiceSession`` stands in for the audio layer exactly as
the tested TypeScript ``FakeVoiceSession`` does, so the dispatch is exercised the
same way on both sides of the boundary. Task 4.2 gives it a microphone; task 4.6
gives it a voice behind a provider boundary.
"""

from __future__ import annotations

from typing import Protocol

# Generated from ../contracts.schema.json by `npm run gen:pydantic`. Never
# hand-edited (plan.md, §10.4). Absent until the generator has run in an
# environment with datamodel-code-generator installed.
from .contracts import Effect, PendingBooking  # type: ignore[import-not-found]


class VoiceSession(Protocol):
    """The three things the audio layer can do that our own code cannot."""

    async def say(self, text: str) -> None: ...
    async def transfer(self, reason: str) -> None: ...
    async def hang_up(self) -> None: ...


class Utterer(Protocol):
    """Turns an effect into words from the committed catalog (never a runtime model)."""

    def say(self, effect: Effect) -> str: ...


class BookingSink(Protocol):
    """Where a finished call posts its PendingBooking. Never the CRM directly."""

    async def submit(self, payload: PendingBooking) -> None: ...


async def perform_effect(
    effect: Effect,
    *,
    voice: VoiceSession,
    utterer: Utterer,
    booking_sink: BookingSink,
    pending_booking: PendingBooking | None = None,
) -> None:
    """Perform exactly one effect. The machine already decided; we just do it."""
    kind = effect.type  # the discriminant of the generated union

    if kind == "GREET":
        # The opening, the AI disclosure verbatim, the invitation — in that order,
        # and before anything else on the call (compliance, not courtesy).
        await voice.say(utterer.say(effect))

    elif kind == "ASK_FOR":
        await voice.say(utterer.say(effect))
        # The caller runtime arms the extractor for effect.key on the next final.

    elif kind == "READ_BACK":
        # This *is* the verification step. The value is spoken from the catalog,
        # never paraphrased by a model — a normalised read-back gets a cheerful
        # "yes" to an address the caller never gave (principle #3).
        await voice.say(utterer.say(effect))

    elif kind == "ESCALATE":
        # Guidance first (read to someone who may be standing in gas), then the
        # hand-off. DECLINE is a courteous close, not a human transfer.
        await voice.say(utterer.say(effect))
        if effect.action == "DECLINE":
            await voice.hang_up()
        else:  # WARM_TRANSFER, DIAL_911_GUIDANCE
            await voice.transfer(effect.reason)

    elif kind == "SAY_FILLER":
        # Spoken *before* the FAQ lookup runs, which is the whole of "never blocks
        # the audio path": the caller hears something the moment they stop talking,
        # and the retrieval happens inside the silence it buys. It says nothing,
        # deliberately — we do not yet know whether we have an answer.
        await voice.say(utterer.say(effect))

    elif kind == "ANSWER_FAQ":
        # The contractor's own committed answer, word for word, or the catalog's
        # "someone will call you back" when nothing they wrote covers it. A model
        # selected this sentence; no model wrote it (plan, §6 call site #3).
        await voice.say(utterer.say(effect))

    elif kind == "CREATE_PENDING_BOOKING":
        await voice.say(utterer.say(effect))
        if pending_booking is not None:
            # POST to the control plane, which starts the durable workflow. Do not
            # wait on Housecall Pro — nothing reaches the CRM from inside the call.
            await booking_sink.submit(pending_booking)

    else:  # pragma: no cover - the union is closed; a new variant is a codegen change
        raise ValueError(f"unknown effect: {kind!r}")


class FakeVoiceSession:
    """Records what it was told to do — the Python mirror of the tested TS fake."""

    def __init__(self) -> None:
        self.spoken: list[str] = []
        self.transfers: list[str] = []
        self.hung_up = False

    async def say(self, text: str) -> None:
        self.spoken.append(text)

    async def transfer(self, reason: str) -> None:
        self.transfers.append(reason)

    async def hang_up(self) -> None:
        self.hung_up = True
