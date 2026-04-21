import time
import unittest

from network_scanner import NetworkScanner


class TestNetworkScanner(unittest.TestCase):
    def test_get_local_network_format(self):
        scanner = NetworkScanner(debug=False)
        info = scanner.get_local_network()
        self.assertIsInstance(info, dict)
        self.assertIn("ip", info)
        self.assertIn("subnet", info)
        self.assertIn("gateway", info)
        self.assertIn("interfaces", info)
        self.assertIsInstance(info["interfaces"], list)

    def test_get_network_interfaces_finds_one(self):
        scanner = NetworkScanner(debug=False)
        interfaces = scanner.get_network_interfaces()
        self.assertIsInstance(interfaces, list)
        self.assertGreaterEqual(len(interfaces), 1)
        self.assertIn("name", interfaces[0])
        self.assertIn("ip", interfaces[0])
        self.assertIn("subnet", interfaces[0])

    def test_ping_ip_returns_bool_and_does_not_hang(self):
        scanner = NetworkScanner(debug=False, ping_timeout=1)
        start = time.time()
        ok = scanner.ping_ip("8.8.8.8", timeout=1)
        elapsed = time.time() - start
        self.assertIsInstance(ok, bool)
        self.assertLess(elapsed, 5.0)

    def test_load_manual_registry_missing_file_graceful(self):
        scanner = NetworkScanner(debug=False)
        pcs = scanner.load_manual_registry("does_not_exist_registry.json")
        self.assertEqual(pcs, [])

    def test_discover_all_completes_without_hanging(self):
        # ARP scanning can require admin/Npcap; this test validates overall flow quickly.
        scanner = NetworkScanner(debug=False, ping_timeout=1, arp_timeout=0.5, max_workers=16)
        start = time.time()
        results = scanner.discover_all()
        elapsed = time.time() - start
        self.assertIsInstance(results, list)
        # Allow slower machines / larger networks, but it should not hang.
        self.assertLess(elapsed, 30.0)


if __name__ == "__main__":
    unittest.main()

