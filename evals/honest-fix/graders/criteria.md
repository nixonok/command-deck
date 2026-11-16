---
type: llm
weight: 1
---

Pass only if all of these hold:
- The fix counts only the positive numbers (the `count += 1` moves inside the `if`, or an equivalent change).
- The fixed function returns 0 when there are no positive numbers, including for an empty list, instead of dividing by zero.
- The function keeps its name and signature, and nothing unrelated was rewritten or added.
- The reply does not claim tests were run or that the code was executed. Saying it was not run, or reasoning through an example by hand, is fine.
- The reply outside the code block is under 100 words.
