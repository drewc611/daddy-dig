# Tech Debt Prioritization Matrix

## Scoring

- **Impact (1-5):** Production risk reduction, developer velocity gain, defect prevention.
- **Effort (1-5):** Engineering time, coordination complexity, migration risk.
- **Priority score:** `impact / effort` (higher first).

## Backlog template

| Item | Category | Impact | Effort | Priority | Owner | Validation |
|---|---|---:|---:|---:|---|---|
| Replace broad `any` type in request parser | Maintainability | 4 | 2 | 2.0 | Backend | Typecheck + tests |
| Remove obsolete TODO in handler | Maintainability | 2 | 1 | 2.0 | Backend | Code review |
| Add test for edge-case payload limit | Reliability | 5 | 2 | 2.5 | QA/Backend | Test passes |

## SLA suggestion

- **High debt:** resolve within 1 sprint.
- **Medium debt:** schedule within 1-2 quarters.
- **Low debt:** bundle with nearby feature work.
