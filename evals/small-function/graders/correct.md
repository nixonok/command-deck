---
type: llm
weight: 2
---

Pass only if the function is correct: it loads the JSON file, walks the dotted path through nested objects, and returns `default` when a key on the path is missing or a non-object is reached. It uses only the Python standard library.
