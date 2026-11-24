"""Offline security and parser tests; intentionally make no network calls."""

import socket
import unittest
from unittest.mock import patch

from services.automation import rss


class RSSSecurityTests(unittest.TestCase):
    HOSTS = {"example.org", "feeds.example.net"}

    def test_url_allowlist_and_credentials(self):
        self.assertEqual(rss.validate_feed_url("https://feeds.example.net/news?a=1", self.HOSTS),
                         ("feeds.example.net", "/news?a=1"))
        for value in ("http://example.org/rss", "https://example.org:443/rss",
                      "https://user@example.org/rss", "https://user:password@example.org/rss",
                      "https://example.org.evil.test/rss", "https://127.0.0.1/rss",
                      "https://example.org/rss#hash", "https://localhost/rss",
                      "file:///etc/passwd", "https://example.org:123/rss"):
            with self.subTest(value=value), self.assertRaises(rss.UnsafeFeed):
                rss.validate_feed_url(value, self.HOSTS)

    @patch("services.automation.rss.socket.getaddrinfo")
    def test_dns_answers_reject_any_private_address(self, getaddrinfo):
        getaddrinfo.return_value = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("8.8.8.8", 443)),
                                    (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 443))]
        with self.assertRaisesRegex(rss.UnsafeFeed, "non-public"):
            rss.public_addresses("example.org")
        getaddrinfo.return_value = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("8.8.8.8", 443))]
        self.assertEqual(rss.public_addresses("example.org"), ["8.8.8.8"])

    @patch("services.automation.rss.PinnedHTTPSConnection")
    @patch("services.automation.rss.public_addresses", return_value=["8.8.8.8"])
    def test_pins_validated_ip_and_rejects_redirect(self, dns, connection):
        response = connection.return_value.getresponse.return_value
        response.status = 302
        with self.assertRaisesRegex(rss.UnsafeFeed, "redirect"):
            rss.fetch_bytes("https://example.org/feed", self.HOSTS)
        self.assertEqual(connection.call_args.args, ("example.org", "8.8.8.8"))
        connection.return_value.close.assert_called_once()
        response.status = 200
        response.getheader.return_value = str(rss.MAX_BYTES + 1)
        with self.assertRaisesRegex(rss.UnsafeFeed, "too large"):
            rss.fetch_bytes("https://example.org/feed", self.HOSTS)

    def test_rss_and_atom_parse_into_small_stable_items(self):
        xml = (b'<rss version="2.0"><channel><item><guid>g1</guid>'
               b'<title>Short &amp; relevant</title><link>https://example.org/a</link>'
               b'</item></channel></rss>')
        self.assertEqual(rss.parse_feed(xml, "https://example.org/feed"),
                         [{"guid": "g1", "title": "Short & relevant",
                           "url": "https://example.org/a"}])
        atom = (b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:example,1</id>'
                b'<title>Today</title><link rel="alternate" href="/post" />'
                b'</entry></feed>')
        self.assertEqual(rss.parse_feed(atom, "https://example.org/feed"),
                         [{"guid": "tag:example,1", "title": "Today",
                           "url": "https://example.org/post"}])
        for value in (b"not xml", b"<root/>", b"x" * (rss.MAX_BYTES + 1)):
            with self.assertRaises(rss.UnsafeFeed):
                rss.parse_feed(value, "https://example.org/feed")
        with self.assertRaises(rss.UnsafeFeed):
            rss.parse_feed(b'<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
                           "https://example.org/feed")


if __name__ == "__main__":
    unittest.main()
