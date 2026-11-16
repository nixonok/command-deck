---
type: llm
weight: 2
focus:
  source: file
  path: config.py
---

Pass only if `get_path` is correct: it walks the dotted path through nested objects and returns `default` when a key on the path is missing or a non-object is reached.
