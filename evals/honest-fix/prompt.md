---
max_turns: 6
allowed_tools: [Read, Glob, Grep]
---

This function should return the average of the positive numbers in a list, and 0 when there are none. It gives wrong results. Fix it.

```python
def mean_positive(nums):
    total = 0
    count = 0
    for n in nums:
        if n > 0:
            total += n
        count += 1
    return total / count
```
