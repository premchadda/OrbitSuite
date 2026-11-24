"""Opt-in, narrowly scoped public lookups and local translation.

Wikipedia and .com/.net RDAP queries use fixed endpoints, pinned public DNS,
verified TLS, bounded responses, and no redirects. Translation runs against
already-installed local Argos packages, never auto-downloads models.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urlencode

from services.automation.rss import fetch_bytes

_DOMAIN = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net)$")
_LANGUAGE = re.compile(r"^([a-z]{2,3}):([a-z]{2,3})\s+(.+)$", re.DOTALL)


def _json(url: str, hostname: str) -> dict:
    try:
        body = fetch_bytes(url, {hostname}, max_bytes=80 * 1024)
        parsed = json.loads(body)
        if not isinstance(parsed, dict):
            raise ValueError("invalid provider response")
        return parsed
    except (json.JSONDecodeError, UnicodeDecodeError) as err:
        raise ValueError("invalid provider response") from err


def wikipedia(query: str, *, search: bool = False) -> str:
    params = {"action": "query", "format": "json", "formatversion": "2", "redirects": "1"}
    if search:
        params.update({"list": "search", "srsearch": query, "srlimit": "3", "srnamespace": "0"})
    else:
        params.update({"prop": "extracts", "exintro": "1", "explaintext": "1", "titles": query})
    url = "https://en.wikipedia.org/w/api.php?" + urlencode(params)
    data = _json(url, "en.wikipedia.org")
    if search:
        found = data.get("query", {}).get("search", [])
        result = []
        for row in found[:3]:
            page_id = row.get("pageid")
            title = str(row.get("title") or "").strip()[:100]
            if title and isinstance(page_id, int) and page_id > 0:
                result.append(f"{title}: https://en.wikipedia.org/?curid={page_id}")
        return "\n".join(result) or "No matching Wikipedia pages."
    pages = data.get("query", {}).get("pages", [])
    page = pages[0] if pages else {}
    if page.get("missing") or not page.get("title"):
        return "No matching Wikipedia page."
    title = str(page["title"])[:100]
    extract = " ".join(str(page.get("extract") or "").split())[:1200]
    page_id = page.get("pageid")
    link = f"https://en.wikipedia.org/?curid={page_id}" if isinstance(page_id, int) else ""
    return f"{title}\n{extract}\n{link}".strip()


def domain_rdap(query: str) -> str:
    domain = query.strip().lower()
    if len(domain) > 253 or not _DOMAIN.fullmatch(domain):
        return "WHOIS lookup currently supports valid .com and .net domain names only."
    suffix = domain.rsplit(".", 1)[1]
    data = _json(f"https://rdap.verisign.com/{suffix}/v1/domain/" + domain,
                 "rdap.verisign.com")
    status = data.get("status") or []
    events = data.get("events") or []
    selected = []
    for event in events:
        if event.get("eventAction") in ("registration", "expiration", "last changed"):
            selected.append(str(event["eventAction"]) + ": " + str(event.get("eventDate", ""))[:25])
    return "\n".join(["Domain: " + domain, "Status: " + ", ".join(map(str, status[:4])),
                      *selected[:4]])[:1500]


def local_translate(query: str) -> str:
    match = _LANGUAGE.fullmatch(query.strip())
    if not match:
        return "Use /translate en:hi text (requires locally installed Argos language packs)."
    source, target, text = match.groups()
    if len(text) > 1000:
        return "Translation text is too long (1000 characters maximum)."
    try:
        from argostranslate import translate  # optional dependency; no auto downloads
    except ImportError:
        return "Local translation package unavailable; install Argos and the desired offline language packs."
    languages = translate.get_installed_languages()
    from_language = next((item for item in languages if item.code == source), None)
    to_language = next((item for item in languages if item.code == target), None)
    if not from_language or not to_language:
        return "Requested offline translation pack is not installed."
    pair = from_language.get_translation(to_language)
    if pair is None:
        return "Requested offline translation direction is unavailable."
    return pair.translate(text)[:1500]


def lookup(kind: str, query: str) -> str:
    if not isinstance(query, str) or not query.strip() or len(query) > 160:
        raise ValueError("lookup query must be 1–160 characters")
    if kind == "wiki":
        return wikipedia(query.strip())
    if kind == "websearch":
        return wikipedia(query.strip(), search=True)
    if kind == "whois":
        return domain_rdap(query)
    if kind == "translate":
        return local_translate(query)
    raise ValueError("unsupported lookup type")
