# Time Complexity Analysis Guide

A reference guide for understanding, detecting, and remediating algorithmic complexity issues found by the **time-complexity-mcp** static analysis server.

## 1. Big-O Quick Reference

| Complexity | Name | Example | Growth at n=1000 |
|---|---|---|---|
| O(1) | Constant | Hash lookup, `.push()` | 1 |
| O(log n) | Logarithmic | Binary search | ~10 |
| O(n) | Linear | Single loop, `.map()`, `.filter()` | 1,000 |
| O(n log n) | Linearithmic | `.sort()`, merge sort | ~10,000 |
| O(n²) | Quadratic | Nested loops | 1,000,000 |
| O(n³) | Cubic | Triple-nested loops | 1,000,000,000 |
| O(2^n) | Exponential | Branching recursion (Fibonacci) | ~10^301 |

## 2. Detection Patterns

### Loop Nesting
The tool tracks nesting depth of `for`, `while`, and `do-while` loops:
- **Depth 1** → O(n)
- **Depth 2** → O(n²)
- **Depth 3** → O(n³)

Constant-bound loops (e.g., `for i in range(10)`) are correctly recognized as O(1) and do not increase nesting depth.

### Recursion
- **Linear recursion** (single recursive call) → O(n)
- **Branching recursion** (multiple recursive calls, e.g., Fibonacci) → O(2^n)
- **Tail recursion** may be reported as O(n) depending on language support

### Known Standard Library Methods
Each language has its own pattern map:
- **O(n log n)**: `.sort()`, `Arrays.sort()`, `sorted()`
- **O(n)**: `.filter()`, `.map()`, `.find()`, `.includes()`, `in` operator
- **O(1)**: `.push()`, `.pop()`, `.get()`, bracket access

### Combined Complexity
When an O(n) stdlib call appears inside an O(n) loop, the tool correctly reports O(n²). Example:
```python
for item in items:          # O(n)
    if item in blacklist:   # O(n) — linear search
        ...                 # Combined: O(n²)
```

## 3. Common Anti-Patterns & Fixes

### Anti-Pattern: Nested Linear Search
```javascript
// O(n²) — items.includes() is O(n) inside O(n) loop
for (const user of users) {
  if (blockedIds.includes(user.id)) { ... }
}
```
**Fix**: Convert to Set for O(1) lookup:
```javascript
const blockedSet = new Set(blockedIds);      // O(n) once
for (const user of users) {
  if (blockedSet.has(user.id)) { ... }       // O(1) lookup → O(n) total
}
```

### Anti-Pattern: Sort Inside Loop
```python
# O(n² log n) — sorting inside a loop
for batch in batches:
    batch.sort()  # O(n log n) × O(n) iterations
```
**Fix**: Sort once before the loop, or use a data structure that maintains order (e.g., `heapq`, `SortedList`).

### Anti-Pattern: Naive Fibonacci (Exponential Recursion)
```python
# O(2^n) — branching recursion
def fib(n):
    if n <= 1: return n
    return fib(n-1) + fib(n-2)
```
**Fix**: Use memoization (`@functools.lru_cache`) or iterative approach for O(n).

### Anti-Pattern: Cartesian Product via Triple Loop
```go
// O(n³) — three nested variable-bound loops
for _, a := range listA {
    for _, b := range listB {
        for _, c := range listC {
            process(a, b, c)
        }
    }
}
```
**Fix**: Evaluate whether all combinations are truly needed. Often, pre-filtering or indexing reduces the search space.

## 4. Integration Workflow

### During Code Review
1. Run `analyze_file` on changed files before approving a PR.
2. Flag any function that regressed in complexity (e.g., O(n) → O(n²)).
3. Document findings using `TIME_COMPLEXITY_REPORT_TEMPLATE.md`.

### During Architecture Review
1. Run `analyze_directory` on the entire `src/` directory.
2. Identify the **top 5 hotspots** — functions with the highest complexity.
3. Cross-reference with production profiling data to prioritize optimization.

### During Refactoring
1. Use `analyze_function` to baseline the target function's complexity.
2. Apply the fix.
3. Re-run `analyze_function` to verify improvement.
4. Document before/after in the report template.

## 5. Limitations

- **Static estimates only**: Cannot account for runtime data distributions, early returns, or caching.
- **No inter-procedural analysis**: If function A calls function B which is O(n), and A loops n times, the tool reports A as O(n) for the loop but may not combine with B's complexity.
- **Language coverage**: Currently supports JS/TS, Python, Java, Go, PHP, Dart, and Kotlin. Other languages require custom tree-sitter grammars.
- **Amortized complexity**: Data structures like dynamic arrays have O(1) amortized insert but O(n) worst case — the tool reports worst case.
