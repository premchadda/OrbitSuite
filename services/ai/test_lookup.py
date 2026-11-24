import json
import unittest
from unittest.mock import patch

from services.ai import lookup as module


class LookupTests(unittest.TestCase):
    @patch("services.ai.lookup.fetch_bytes")
    def test_wikipedia_uses_fixed_api_with_escaped_query(self, fetch):
        fetch.return_value = json.dumps({"query": {"pages": [{"title": "Test", "pageid": 123,
                                             "extract": "An example article."}]}}).encode()
        result = module.lookup("wiki", "Test & Example")
        self.assertIn("An example article.", result)
        self.assertIn("/?curid=123", result)
        self.assertEqual(fetch.call_args.args[1], {"en.wikipedia.org"})
        self.assertIn("Test+%26+Example", fetch.call_args.args[0])

    @patch("services.ai.lookup.fetch_bytes")
    def test_web_search_limits_results(self, fetch):
        fetch.return_value = json.dumps({"query": {"search": [
            {"title": "One", "pageid": 1}, {"title": "Two", "pageid": 2}]}}).encode()
        self.assertIn("One", module.lookup("websearch", "maths"))
        self.assertEqual(fetch.call_args.args[1], {"en.wikipedia.org"})

    @patch("services.ai.lookup.fetch_bytes")
    def test_whois_supports_fixed_domain_registry_and_excludes_contacts(self, fetch):
        fetch.return_value = json.dumps({"status": ["active"], "events": [
            {"eventAction": "registration", "eventDate": "2025-01-01T00:00:00Z"}],
            "entities": [{"vcardArray": ["vcard", [["email", {}, "text", "private@abc.com"]]]}]}).encode()
        result = module.lookup("whois", "example.com")
        self.assertIn("active", result)
        self.assertNotIn("private@abc.com", result)
        self.assertEqual(fetch.call_args.args[1], {"rdap.verisign.com"})
        module.lookup("whois", "example.net")
        self.assertIn("/net/v1/domain/example.net", fetch.call_args.args[0])
        result = module.lookup("whois", "example.org")
        self.assertIn(".com and .net", result)
        self.assertEqual(fetch.call_count, 2)

    def test_translation_is_offline_and_opt_in(self):
        result = module.lookup("translate", "en:hi Good morning")
        self.assertTrue("unavailable" in result.lower() or result)
        with self.assertRaises(ValueError):
            module.lookup("unknown", "text")
        with self.assertRaises(ValueError):
            module.lookup("wiki", " " * 200)


if __name__ == "__main__":
    unittest.main()
