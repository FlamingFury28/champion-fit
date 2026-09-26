"""Offline, outcome-independent champion classes and curated play styles.

The catalog is pinned to Data Dragon 16.13.1. Riot supplies the champion IDs,
names and broad classes; this project curates styles and compatible positions.
Returned dictionaries are independent copies so consumers may attach statistics
without changing later classifications.
"""

from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import unquote, urlsplit


CATALOG_PATH = Path(__file__).with_name("champion_archetypes.json")
SOURCE_VERSION = "16.13.1"


def _display_value(value: object) -> str:
    if value is None:
        return ""
    return " ".join(unicodedata.normalize("NFC", str(value)).split())


def _alias_key(value: str) -> str:
    return "".join(
        character for character in unicodedata.normalize("NFKD", value).casefold()
        if character.isalnum()
    )


@lru_cache(maxsize=1)
def _catalog_state() -> tuple[dict, dict[str, dict], dict[str, str]]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    if catalog.get("source_version") != SOURCE_VERSION:
        raise ValueError("Champion catalog must declare its pinned Data Dragon version.")
    entries = catalog.get("champions", [])
    by_id = {entry["id"]: entry for entry in entries}
    if len(by_id) != 173 or len(entries) != 173:
        raise ValueError("Champion catalog must contain the 173 distinct pinned champions.")
    aliases = {}
    for entry in entries:
        for alias in (entry["id"], entry["name"], *entry.get("aliases", [])):
            key = _alias_key(str(alias))
            if not key:
                continue
            previous = aliases.setdefault(key, entry["id"])
            if previous != entry["id"]:
                raise ValueError(f"Ambiguous champion alias: {alias}")
    return catalog, by_id, aliases


def load_catalog() -> dict:
    """Return the complete versioned catalog with criteria and source URLs."""
    return deepcopy(_catalog_state()[0])


def canonical_champion(value: object) -> str:
    """Resolve exact normalized names/IDs/assets; preserve unknown names.

    Case, accents, spaces and punctuation are ignored for lookup only. Official
    numeric keys and localized names are catalog aliases. Common square/splash
    asset paths are accepted without fetching them. Unknown values retain their
    spelling after Unicode/whitespace normalization and never gain categories.
    """
    original = _display_value(value)
    if not original:
        return ""
    aliases = _catalog_state()[2]
    direct = aliases.get(_alias_key(original))
    if direct:
        return direct
    # Inspect only the final component of an asset path, without accessing it.
    try:
        component = unquote(urlsplit(original.replace("\\", "/")).path.rsplit("/", 1)[-1])
    except ValueError:
        return original
    component = re.sub(r"\.(?:png|jpe?g|webp|json)$", "", component, flags=re.IGNORECASE)
    component = re.sub(r"_\d+$", "", component)
    return aliases.get(_alias_key(component), original)


def champion_entry(value: object) -> dict | None:
    """Return an independent catalog entry, or None for an unknown champion."""
    entry = _catalog_state()[1].get(canonical_champion(value))
    return deepcopy(entry) if entry is not None else None


def champion_categories(value: object) -> list[str]:
    """Return class IDs followed by curated style IDs, or [] when unknown."""
    entry = _catalog_state()[1].get(canonical_champion(value))
    return [*entry["classes"], *entry["tags"]] if entry is not None else []
