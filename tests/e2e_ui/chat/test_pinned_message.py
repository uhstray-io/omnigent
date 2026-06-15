"""Browser e2e for the chat's pinned-message banner + jump-to-message flow.

A pin is a per-session personal bookmark: hovering a committed user
bubble reveals a pin action (``data-testid="pin-user-message"``,
accessible name "Pin to top" / "Unpin from top"); clicking it lifts a
one-line snippet of that message into a banner stuck to the top of the
conversation viewport (``data-testid="pinned-message-banner"``). The
banner body (``data-testid="pinned-message-jump"``) jumps back to the
original message; the ✕ (``aria-label="Unpin message"``) clears it. The
pin is persisted to ``localStorage`` under ``omnigent:pinned-messages``
(``ap-web/src/lib/pinnedMessages.ts``), keyed by conversation id, so it
survives a reload.

The component/unit suites (``PinnedMessageBanner.test.tsx``,
``ChatPage.pinnedMessage.test.tsx``, ``pinnedMessages.test.ts``) cover
the gating rules and the persistence helper in isolation with a mocked
store. These drive the real chain those mocks stand in for:

  - a committed server item id reaching the bubble so the pin action
    appears (optimistic ``pend_*`` sends are not pinnable),
  - the toggle writing through ``localStorage`` so the banner survives a
    page reload + snapshot re-hydration,
  - the banner click running the jump-and-scroll machinery against a
    real, scrolled-away message bubble.

A regression in the item-id promotion, the localStorage round-trip, or
the scroll-into-view jump would surface here end-to-end where the mocked
unit tests cannot see it.
"""

from __future__ import annotations

import uuid

from playwright.sync_api import Locator, Page, expect

_COMPOSER = "Ask the agent anything…"
_ASSISTANT = '[data-testid="message-bubble"][data-role="assistant"]'
_USER = '[data-testid="message-bubble"][data-role="user"]'
_WORKING = '[data-testid="working-indicator"]'
_BANNER = '[data-testid="pinned-message-banner"]'


def _send(page: Page, text: str) -> None:
    """Type *text* into the composer and click Send."""
    composer = page.get_by_placeholder(_COMPOSER)
    expect(composer).to_be_visible()
    composer.fill(text)
    page.get_by_role("button", name="Send", exact=True).click()


def _send_and_settle(page: Page, text: str, *, expected_user_bubbles: int) -> None:
    """Send *text* and wait for the turn to finish streaming.

    Waiting for the shimmer to clear (not just the assistant bubble to
    appear) matters before a jump: while a turn streams, the
    stick-to-bottom scroller keeps yanking the view to the latest token,
    which would fight ``scrollIntoView`` and make the jump assertion racy.

    :param expected_user_bubbles: How many user bubbles should exist once
        this send has rendered — guards that the message actually left the
        composer before we wait on the (slower) assistant turn.
    """
    _send(page, text)
    expect(page.locator(_USER)).to_have_count(expected_user_bubbles, timeout=15_000)
    # 60s budget covers cold-start LLM latency under Databricks routing.
    expect(page.locator(_ASSISTANT)).to_have_count(expected_user_bubbles, timeout=60_000)
    expect(page.locator(_WORKING)).to_have_count(0, timeout=60_000)


def _user_bubble(page: Page, text: str) -> Locator:
    """The user message bubble containing *text* (the pin anchor)."""
    return page.locator(_USER, has_text=text).first


def test_pin_shows_banner_and_persists_across_reload(
    page: Page,
    seeded_session: tuple[str, str],
) -> None:
    """Pinning a user message banners its snippet, and the pin survives reload.

    The reload is the load-bearing part: it destroys the SPA's in-memory
    state, so a banner that re-appears could only have come from
    ``localStorage`` (``omnigent:pinned-messages``) — proving the toggle
    persisted rather than living in React state for the page's lifetime.
    Unpinning through the banner ✕ and reloading again proves the clear
    is persisted too (a one-way pin that "unpins" only in memory would
    resurrect the banner on the second reload).

    :param page: Playwright page fixture (fresh context per test).
    :param seeded_session: ``(base_url, session_id)`` for a pre-created
        runner-bound session.
    """
    base_url, session_id = seeded_session
    token = f"pin-me-{uuid.uuid4().hex[:8]}"
    page.goto(f"{base_url}/c/{session_id}")

    # A committed user message is the prerequisite for the pin action —
    # optimistic pend_* sends aren't pinnable, so wait for the turn to
    # round-trip and promote the bubble to its server item id.
    _send_and_settle(page, f"Remember this marker verbatim: {token}", expected_user_bubbles=1)

    # No pin yet → no banner.
    expect(page.locator(_BANNER)).to_have_count(0)

    bubble = _user_bubble(page, token)
    bubble.hover()
    pin_action = bubble.get_by_test_id("pin-user-message")
    expect(pin_action).to_have_accessible_name("Pin to top")
    pin_action.click()

    # The banner appears with the message's snippet, and the bubble's own
    # action flips to its unpin affordance — both prove the toggle ran
    # through the real pin state, not a local no-op.
    banner = page.locator(_BANNER)
    expect(banner).to_be_visible()
    expect(banner).to_contain_text(token)
    expect(_user_bubble(page, token).get_by_test_id("pin-user-message")).to_have_accessible_name(
        "Unpin from top"
    )

    # Reload kills in-memory state; a banner that re-renders proves the pin
    # was persisted to localStorage and re-read on mount.
    page.reload()
    banner = page.locator(_BANNER)
    expect(banner).to_be_visible()
    expect(banner).to_contain_text(token)

    # Unpin via the banner's ✕ — the banner clears immediately...
    page.get_by_role("button", name="Unpin message").click()
    expect(page.locator(_BANNER)).to_have_count(0)

    # ...and the clear is persisted: it stays gone after another reload.
    page.reload()
    expect(_user_bubble(page, token)).to_be_visible(timeout=15_000)
    expect(page.locator(_BANNER)).to_have_count(0)


def test_pinned_banner_jumps_to_scrolled_away_message(
    page: Page,
    seeded_session: tuple[str, str],
) -> None:
    """Clicking the banner scrolls the original message back into view.

    Pins the first message, then sends a tall second message so the
    stick-to-bottom scroller pushes the pinned message off the top of the
    viewport. Clicking the banner must scroll it back — the jump-to-message
    flow the unit tests can only assert against a jsdom layout that never
    actually scrolls.

    :param page: Playwright page fixture (fresh context per test).
    :param seeded_session: ``(base_url, session_id)`` for a pre-created
        runner-bound session.
    """
    base_url, session_id = seeded_session
    token = f"jump-target-{uuid.uuid4().hex[:8]}"
    # A short viewport keeps the scroll deterministic: even a modest
    # conversation overflows it, so the pinned message is reliably off-screen
    # once a taller message lands below it.
    page.set_viewport_size({"width": 1280, "height": 500})
    page.goto(f"{base_url}/c/{session_id}")

    # Turn 1: the message we'll pin. Short, so it's visible to pin before
    # the second turn pushes it away.
    _send_and_settle(page, f"This is the pinned anchor: {token}", expected_user_bubbles=1)

    bubble = _user_bubble(page, token)
    bubble.hover()
    bubble.get_by_test_id("pin-user-message").click()
    expect(page.locator(_BANNER)).to_be_visible()

    # Turn 2: a tall multi-line message. User text renders as markdown with
    # `breaks` (ChatPage.tsx), so each newline is a rendered line — the
    # bubble alone overflows the short viewport and the stick-to-bottom
    # scroller leaves the turn-1 anchor above the fold.
    filler = "\n".join(f"padding line {i}" for i in range(1, 31))
    _send_and_settle(page, f"Reply with only the word 'ok'.\n{filler}", expected_user_bubbles=2)

    # Precondition for a meaningful jump: the anchor scrolled out of view.
    anchor = _user_bubble(page, token)
    expect(anchor).not_to_be_in_viewport()

    # The banner click jumps back to (and centers) the original message.
    page.locator('[data-testid="pinned-message-jump"]').click()
    expect(anchor).to_be_in_viewport()
