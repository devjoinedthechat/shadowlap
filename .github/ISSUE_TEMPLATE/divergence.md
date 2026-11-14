---
name: Unexpected divergence
about: A replay diverged and you think it shouldn't have
labels: divergence
---

**The divergence report**

Paste the `✗ Diverged at call …` block from `shadowlap replay` or `shadowlap show <replay-run>`, redacted as needed.

**What changed between the recording and the replay, as far as you know**

Nothing? A code edit? Time passed? A different machine?

**Did a normalizer fix it?**

If the report suggested one (`shadowlap normalize add …`), did it match afterwards? If it suggested nothing, what field differed?

**Environment**

- shadowlap version:
- SDK and language:
