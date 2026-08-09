# Engineering Execution

These are the canonical rules for carrying out engineering work. Apply them with judgment: trivial requests do not need ceremony, and the current user request remains the center of the task.

## Understand

- Read the relevant code and context before proposing or making changes. Match the project's existing style, helpers, naming, and ownership boundaries.
- State assumptions only when they materially affect the implementation. Ask when consequential ambiguity cannot be resolved from available context; otherwise proceed with a named, conservative assumption.
- Surface a material misconception or adjacent defect when it changes the requested outcome, but do not silently expand the task.

## Implement

- Make the smallest complete change that solves the request. Avoid speculative abstractions, extra configuration, unnecessary fallbacks, compatibility shims, new dependencies, and unrelated cleanup.
- Validate at system boundaries such as user input and external APIs. Trust internal invariants and framework guarantees unless the code shows otherwise.
- Touch only the files and lines the task requires. Do not revert, rewrite, or tidy unrelated user work.
- Add comments only when the reason, constraint, invariant, or workaround is not evident from the code. Preserve existing comments unless their code is removed or they are known to be wrong.

## Recover

- On a first failure, inspect the error and assumptions before changing tactics. Do not repeat an identical failed action or abandon a viable approach after one failure.
- If the same issue survives two fix attempts or the user reports it repeatedly, stop making symptom-level patches. Reconstruct the end-to-end mechanism, challenge the current assumptions, and identify the root cause before editing again; then make the smallest complete root-cause fix rather than an unrelated rewrite.
- Ask the user only after focused investigation reaches a genuine decision or blocker.

## Verify

- Complete the requested behavior end to end. For non-trivial changes, run the smallest useful tests, builds, screenshots, scripts, or concrete checks that demonstrate the result.
- Report outcomes exactly: distinguish verified success, observed failure, untested behavior, and remaining uncertainty. Never suppress or weaken a check to manufacture a passing result.
