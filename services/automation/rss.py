"""A deliberately small, optional and SSRF-guarded RSS/Atom parser service.

Requires explicit ORBIT_RSS_HOSTS allowlist. Refuses redirects, unsafe DNS
answers, credentials, non-HTTPS URLs, and >256 KiB responses. TLS connects to
the vetted IP itself (while preserving hostname certificate verification),
preventing DNS-rebinding between validation and connection.

Usage: ORBIT_RSS_HOSTS=feeds.example.org ORBIT_RSS_PARSER_TOKEN=<secret> \
       python -m services.automation.rss --serve
Default bind is localhost only; use a controlled HTTPS tunnel/proxy if needed.
"""

from __future__ import annotations

import argparse
import hmac
import html
from http import HTTPStatus
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
import re
import socket
import ssl
from urllib.parse import parse_qs, urljoin, urlsplit
import xml.etree.ElementTree as ET

MAX_BYTES = 256 * 1024
MAX_ITEMS = 10
MAX_URL = 2048
TIMEOUT = 8
_HOST = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$")
_ATOM = "{http://www.w3.org/2005/Atom}"


class UnsafeFeed(ValueError):
    """URL, DNS or content violates conservative RSS policy."""


def allowlist(raw: str | None) -> set[str]:
    return {host for s in (raw or "").split(",")
            if (host := s.strip().lower()) and _HOST.fullmatch(host)}


def validate_feed_url(url: str, hosts: set[str]) -> tuple[str, str]:
    if not isinstance(url, str) or len(url) > MAX_URL or not hosts:
        raise UnsafeFeed("feed URL or host allowlist missing")
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        explicit_port = parts.port
    except ValueError as err:
        raise UnsafeFeed("malformed feed URL") from err
    if (parts.scheme != "https" or not host or parts.username is not None
            or parts.password is not None or explicit_port is not None
            or parts.fragment or not _HOST.fullmatch(host)
            or host.endswith((".local", ".internal"))
            or not any(host == root or host.endswith("." + root) for root in hosts)):
        raise UnsafeFeed("only allowlisted HTTPS feeds without credentials or ports")
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return host, path


def public_addresses(host: str) -> list[str]:
    try:
        answers = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP,
                                     type=socket.SOCK_STREAM)
    except socket.gaierror as err:
        raise UnsafeFeed("feed hostname did not resolve") from err
    if not answers:
        raise UnsafeFeed("feed hostname has no DNS answers")
    addresses = list(dict.fromkeys(item[4][0] for item in answers))
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
        raise UnsafeFeed("non-public feed DNS address")
    return addresses


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, verified_ip: str, **kwargs):
        super().__init__(hostname, **kwargs)
        self._verified_ip = verified_ip

    def connect(self):
        socket_tcp = socket.create_connection((self._verified_ip, self.port),
                                              self.timeout)
        try:
            self.sock = self._context.wrap_socket(socket_tcp, server_hostname=self.host)
        except BaseException:
            socket_tcp.close()
            raise


def fetch_bytes(url: str, hosts: set[str], *, max_bytes: int = MAX_BYTES) -> bytes:
    host, path = validate_feed_url(url, hosts)
    ip = public_addresses(host)[0]
    connection = PinnedHTTPSConnection(host, ip, timeout=TIMEOUT,
                                       context=ssl.create_default_context())
    try:
        connection.request("GET", path, headers={
            "Host": host,
            "User-Agent": "OrbitSuitePersonalRSS/1.0",
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
            "Accept-Encoding": "identity",
            "Connection": "close",
        })
        result = connection.getresponse()
        if 300 <= result.status <= 399:
            raise UnsafeFeed("RSS redirects are disabled")
        if result.status != 200:
            raise UnsafeFeed(f"feed server returned HTTP {result.status}")
        advertised = result.getheader("Content-Length")
        if advertised and advertised.isdigit() and int(advertised) > max_bytes:
            raise UnsafeFeed("feed is too large")
        body = result.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise UnsafeFeed("feed is too large")
        return body
    finally:
        connection.close()


def clean_text(node: ET.Element | None, limit: int = 500) -> str:
    if node is None:
        return ""
    return html.unescape(" ".join("".join(node.itertext()).split()))[:limit]


def safe_article_url(raw: str, feed: str) -> str:
    try:
        absolute = urljoin(feed, raw)
        parts = urlsplit(absolute)
        if parts.scheme == "https" and parts.hostname and not parts.username and not parts.password:
            return absolute[:500]
    except ValueError:
        pass
    return ""


def parse_feed(contents: bytes, feed_url: str) -> list[dict[str, str]]:
    if len(contents) > MAX_BYTES:
        raise UnsafeFeed("RSS document is too large")
    if b"<!DOCTYPE" in contents.upper() or b"<!ENTITY" in contents.upper():
        raise UnsafeFeed("RSS document contains forbidden XML declarations")
    try:
        root = ET.fromstring(contents)
    except ET.ParseError as err:
        raise UnsafeFeed("malformed RSS or Atom XML") from err
    result = []
    if root.tag.lower() in ("rss", "rdf", "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}rdf"):
        entries = root.findall(".//item")
        for entry in entries[:MAX_ITEMS]:
            title = clean_text(entry.find("title"), 250)
            link = safe_article_url(clean_text(entry.find("link")), feed_url)
            guid = clean_text(entry.find("guid"), 500) or link
            if title and guid:
                result.append({"guid": guid, "title": title, "url": link})
    elif root.tag == _ATOM + "feed":
        for entry in root.findall(_ATOM + "entry")[:MAX_ITEMS]:
            title = clean_text(entry.find(_ATOM + "title"), 250)
            links = entry.findall(_ATOM + "link")
            link_raw = next((link.get("href", "") for link in links
                             if link.get("rel", "alternate") == "alternate"), "")
            link = safe_article_url(link_raw, feed_url)
            guid = clean_text(entry.find(_ATOM + "id"), 500) or link
            if title and guid:
                result.append({"guid": guid, "title": title, "url": link})
    else:
        raise UnsafeFeed("not a recognized RSS or Atom document")
    return result


def fetch_rss(url: str, hosts: set[str]) -> list[dict[str, str]]:
    return parse_feed(fetch_bytes(url, hosts), url)


class RSSRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802, stdlib name
        secret = os.environ.get("ORBIT_RSS_PARSER_TOKEN", "")
        header = self.headers.get("Authorization", "")
        if not secret or not hmac.compare_digest(header, "Bearer " + secret):
            return self.respond(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        request = urlsplit(self.path)
        if request.path not in ("/rss", "/lookup"):
            return self.respond(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        params = parse_qs(request.query)
        if request.path == "/lookup":
            from services.ai.lookup import lookup
            try:
                answer = lookup(params.get("kind", [""])[0], params.get("query", [""])[0])
            except (UnsafeFeed, ValueError, OSError, TimeoutError, ssl.SSLError) as err:
                return self.respond(HTTPStatus.BAD_REQUEST, {"error": str(err)[:120]})
            return self.respond(HTTPStatus.OK, {"result": answer[:1500]})
        url = params.get("url", [""])[0]
        try:
            items = fetch_rss(url, allowlist(os.environ.get("ORBIT_RSS_HOSTS")))
        except (UnsafeFeed, OSError, TimeoutError, ssl.SSLError) as err:
            return self.respond(HTTPStatus.BAD_REQUEST, {"error": str(err)[:120]})
        return self.respond(HTTPStatus.OK, {"items": items})

    def respond(self, status: HTTPStatus, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):  # noqa: A002, no sensitive URL logs
        pass


def main():
    parser = argparse.ArgumentParser(description="Private RSS feed parser")
    parser.add_argument("--serve", action="store_true", help="expose token-protected JSON endpoint")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8188)
    parser.add_argument("url", nargs="?", help="parse a single feed and emit JSON")
    args = parser.parse_args()
    if args.serve:
        if not os.environ.get("ORBIT_RSS_PARSER_TOKEN"):
            parser.error("ORBIT_RSS_PARSER_TOKEN required to serve")
        ThreadingHTTPServer((args.host, args.port), RSSRequestHandler).serve_forever()
    else:
        if not args.url:
            parser.error("supply URL or --serve")
        print(json.dumps({"items": fetch_rss(args.url,
              allowlist(os.environ.get("ORBIT_RSS_HOSTS")))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
