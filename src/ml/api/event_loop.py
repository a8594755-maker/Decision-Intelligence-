"""
event_loop.py — Event-Driven Background Processor

Polls the event_queue table for pending events, matches them against
event_rules, and creates tasks via the JS orchestrator (through HTTP).

Runs as a FastAPI background task, polling every 30-60 seconds.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("di.event_loop")

# Configuration
EVENT_POLL_INTERVAL = int(os.getenv("DI_EVENT_POLL_INTERVAL", "30"))  # seconds
EVENT_BATCH_SIZE = int(os.getenv("DI_EVENT_BATCH_SIZE", "20"))


class EventLoopProcessor:
    """
    Background processor that:
    1. Polls event_queue for pending events
    2. Loads enabled event_rules
    3. Matches events against rules
    4. Creates Decision Work Orders for matched events
    5. Updates event status
    """

    def __init__(self, supabase_client):
        self.supabase = supabase_client
        self.running = False
        self.last_poll_at: Optional[str] = None
        self.stats = {
            "polls": 0,
            "events_processed": 0,
            "events_matched": 0,
            "events_ignored": 0,
            "events_failed": 0,
            "last_error": None,
        }

    async def start(self):
        """Start the polling loop."""
        self.running = True
        logger.info(
            "[EventLoop] Starting event processor (poll every %ds, batch %d)",
            EVENT_POLL_INTERVAL, EVENT_BATCH_SIZE,
        )
        while self.running:
            try:
                await self._poll_once()
            except Exception as e:
                self.stats["last_error"] = str(e)
                logger.error("[EventLoop] Poll error: %s", e)
            await asyncio.sleep(EVENT_POLL_INTERVAL)

    async def stop(self):
        """Stop the polling loop."""
        self.running = False
        logger.info("[EventLoop] Stopped")

    async def _poll_once(self):
        """Single poll iteration."""
        self.stats["polls"] += 1
        self.last_poll_at = datetime.now(timezone.utc).isoformat()

        # 1. Fetch pending events
        result = self.supabase.table("event_queue") \
            .select("*") \
            .eq("status", "pending") \
            .order("created_at") \
            .limit(EVENT_BATCH_SIZE) \
            .execute()

        pending_events = result.data or []
        if not pending_events:
            return

        # 2. Fetch enabled rules
        rules_result = self.supabase.table("event_rules") \
            .select("*") \
            .eq("enabled", True) \
            .order("priority", desc=True) \
            .execute()

        rules = rules_result.data or []
        if not rules:
            # No rules — mark all as ignored
            for event in pending_events:
                await self._update_event_status(event["id"], "ignored")
                self.stats["events_ignored"] += 1
            return

        # 3. Fetch recent processed events for cooldown check (last 24h)
        recent_result = self.supabase.table("event_queue") \
            .select("id,event_type,status,processed_at,created_at") \
            .in_("status", ["processed", "matched"]) \
            .order("created_at", desc=True) \
            .limit(200) \
            .execute()

        recent_events = recent_result.data or []

        # 4. Process each pending event
        for event in pending_events:
            try:
                await self._process_event(event, rules, recent_events)
                self.stats["events_processed"] += 1
            except Exception as e:
                logger.error("[EventLoop] Failed to process event %s: %s", event["id"], e)
                await self._update_event_status(
                    event["id"], "failed", error_message=str(e)
                )
                self.stats["events_failed"] += 1

    async def _process_event(self, event, rules, recent_events):
        """Process a single event against rules."""
        # Match against rules (using simple Python matching — mirrors JS eventRuleEngine)
        matched_rule = self._match_rules(event, rules, recent_events)

        if not matched_rule:
            await self._update_event_status(event["id"], "ignored")
            self.stats["events_ignored"] += 1
            return

        # Mark as matched
        await self._update_event_status(
            event["id"], "matched",
            worker_id=matched_rule.get("target_worker_id"),
        )
        self.stats["events_matched"] += 1

        # Build DWO metadata (the JS side handles actual task creation)
        dwo_context = {
            "event_id": event["id"],
            "event_type": event["event_type"],
            "source_system": event.get("source_system", "internal"),
            "payload": event.get("payload", {}),
            "rule_id": matched_rule["id"],
            "rule_name": matched_rule["name"],
            "intent_type": matched_rule.get("intent_type"),
            "business_domain": matched_rule.get("business_domain", "supply_planning"),
        }

        # Store the DWO context in the event for the JS side to pick up
        self.supabase.table("event_queue").update({
            "status": "processed",
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "worker_id": matched_rule.get("target_worker_id"),
            "payload": {
                **event.get("payload", {}),
                "_dwo_context": dwo_context,
                "_matched_rule": {
                    "id": matched_rule["id"],
                    "name": matched_rule["name"],
                    "task_template_id": matched_rule.get("task_template_id"),
                },
            },
        }).eq("id", event["id"]).execute()

        logger.info(
            "[EventLoop] Event %s matched rule '%s' → worker %s",
            event["id"], matched_rule["name"],
            matched_rule.get("target_worker_id", "unassigned"),
        )

    def _match_rules(self, event, rules, recent_events):
        """Match an event against rules (Python port of matchEventRule)."""
        event_type = event.get("event_type", "")
        payload = event.get("payload", {})

        for rule in rules:
            if not rule.get("enabled", True):
                continue

            # 1. Type pattern match
            pattern = rule.get("event_type_pattern", "")
            if not self._match_type(event_type, pattern):
                continue

            # 2. Condition check
            condition = rule.get("condition_json", {})
            if not self._check_condition(payload, condition):
                continue

            # 3. Cooldown check
            cooldown = rule.get("cooldown_seconds", 300)
            if self._is_in_cooldown(rule, recent_events, cooldown):
                continue

            return rule

        return None

    def _match_type(self, event_type: str, pattern: str) -> bool:
        """Simple glob matching for event types."""
        if pattern == "*":
            return True
        if pattern == event_type:
            return True
        # Simple wildcard: supplier_* matches supplier_delay
        if "*" in pattern:
            import fnmatch
            return fnmatch.fnmatch(event_type, pattern)
        return False

    def _check_condition(self, payload: dict, condition: dict) -> bool:
        """Check payload against conditions."""
        if not condition:
            return True
        for key, expected in condition.items():
            actual = self._get_nested(payload, key)
            if isinstance(expected, dict):
                for op, val in expected.items():
                    if op == "$gt" and not (actual is not None and actual > val):
                        return False
                    if op == "$gte" and not (actual is not None and actual >= val):
                        return False
                    if op == "$lt" and not (actual is not None and actual < val):
                        return False
                    if op == "$in" and actual not in val:
                        return False
            else:
                if actual != expected:
                    return False
        return True

    def _get_nested(self, obj, path):
        """Get nested value via dot notation."""
        for key in path.split("."):
            if isinstance(obj, dict):
                obj = obj.get(key)
            else:
                return None
        return obj

    def _is_in_cooldown(self, rule, recent_events, cooldown_seconds):
        """Check if rule is in cooldown."""
        if cooldown_seconds <= 0:
            return False
        pattern = rule.get("event_type_pattern", "")
        matching = [
            e for e in recent_events
            if self._match_type(e.get("event_type", ""), pattern)
            and e.get("status") in ("processed", "matched")
        ]
        if not matching:
            return False
        last_time_str = matching[0].get("processed_at") or matching[0].get("created_at")
        if not last_time_str:
            return False
        from datetime import datetime as dt
        last_time = dt.fromisoformat(last_time_str.replace("Z", "+00:00"))
        now = dt.now(timezone.utc)
        elapsed = (now - last_time).total_seconds()
        return elapsed < cooldown_seconds

    async def _update_event_status(self, event_id, status, **kwargs):
        """Update an event's status."""
        update = {"status": status}
        if status in ("processed", "matched", "failed"):
            update["processed_at"] = datetime.now(timezone.utc).isoformat()
        if "error_message" in kwargs:
            update["error_message"] = kwargs["error_message"]
        if "worker_id" in kwargs and kwargs["worker_id"]:
            update["worker_id"] = kwargs["worker_id"]
        self.supabase.table("event_queue").update(update).eq("id", event_id).execute()

    def get_status(self):
        """Return processor status for the /events/status endpoint."""
        return {
            "running": self.running,
            "last_poll_at": self.last_poll_at,
            "poll_interval_seconds": EVENT_POLL_INTERVAL,
            "stats": self.stats,
        }


# ── Module-level singleton ───────────────────────────────────────────────────

_processor: Optional[EventLoopProcessor] = None


def get_event_processor(supabase_client=None) -> EventLoopProcessor:
    """Get or create the singleton event processor."""
    global _processor
    if _processor is None:
        if supabase_client is None:
            raise RuntimeError("EventLoopProcessor requires a supabase client on first init")
        _processor = EventLoopProcessor(supabase_client)
    return _processor
