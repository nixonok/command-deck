import json


def load_json(path):
    """Read a JSON file. A missing or broken file raises ValueError naming the path."""
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise ValueError(f"cannot read config {path}: {e}") from e


def get_port(path):
    return load_json(path).get("port", 8080)
