"""Project-wide queue policy for Champion Fit."""

from __future__ import annotations


# Only Summoner's Rift queues used for the competitive role model are valid.
# 430 is Blind Pick ("scelta segreta"), 490 is Quickplay.
SUPPORTED_QUEUE_IDS = {"400", "420", "430", "440", "480", "490", "700"}
SUPPORTED_QUEUE_NAMES = {
    "DRAFT PICK", "NORMAL DRAFT", "BLIND PICK", "NORMAL BLIND",
    "QUICKPLAY", "NORMAL QUICKPLAY", "RANKED SOLO", "RANKED SOLO/DUO",
    "RANKED FLEX",
}


def normalized_queue(queue: object) -> str:
    return str(queue or "").strip().upper().replace(" ", "")


def is_supported_queue(queue: object) -> bool:
    """Return whether a match belongs to the project's supported SR queues."""
    raw = str(queue or "").strip().upper()
    normalized = normalized_queue(queue)
    if raw in SUPPORTED_QUEUE_NAMES:
        return True
    if normalized in SUPPORTED_QUEUE_IDS:
        return True
    return normalized.startswith("QUEUE") and normalized[5:] in SUPPORTED_QUEUE_IDS


def is_urf_queue(queue: object) -> bool:
    normalized = normalized_queue(queue)
    ids = {"76", "83", "318", "900", "1010", "1900"}
    return normalized == "URF" or normalized in ids or (normalized.startswith("QUEUE") and normalized[5:] in ids)


def is_aram_queue(queue: object) -> bool:
    normalized = normalized_queue(queue)
    ids = {"65", "67", "100", "300", "450", "720", "2400"}
    return normalized == "ARAM" or normalized in ids or (normalized.startswith("QUEUE") and normalized[5:] in ids)
