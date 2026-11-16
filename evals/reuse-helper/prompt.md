---
max_turns: 15
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash]
---

Add `get_path(file_path, dotted_key, default=None)` to config.py. It returns the value at a dotted key like "a.b.c" in a JSON file, or the default when the path is missing.
