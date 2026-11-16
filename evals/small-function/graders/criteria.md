---
type: llm
weight: 1
---

Pass only if all of these hold:
- The function is correct: it loads the JSON file, walks the dotted path through nested objects, and returns `default` when a key on the path is missing or a non-object is reached.
- It uses only the Python standard library.
- A missing file or invalid JSON is not silently turned into the default: it either raises (the built-in error is fine) or the reply says plainly which choice was made.
- Nothing was added that was not asked for: no command-line interface, no class, no logging setup, no extra options or parameters.
- The reply outside the code block is under 80 words.
