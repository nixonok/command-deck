import json
import os
import tempfile
import unittest

from config import get_port, load_json


def write_json(data):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(data, f)
    f.close()
    return f.name


class ConfigTest(unittest.TestCase):
    def test_port(self):
        path = write_json({"port": 9000})
        self.addCleanup(os.remove, path)
        self.assertEqual(get_port(path), 9000)

    def test_missing_file(self):
        with self.assertRaises(ValueError):
            load_json("no-such-file.json")


if __name__ == "__main__":
    unittest.main()
