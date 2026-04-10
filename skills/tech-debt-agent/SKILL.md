---
name: tech-debt-agent
description: Identify, prioritize, and reduce technical debt in a software repository. Use when asked to create a tech debt audit, produce a remediation backlog, assess maintainability risks, or convert debt findings into concrete implementation tasks.
---

# Tech Debt Agent

## Overview

Run a lightweight, repeatable debt audit and convert findings into a prioritized action plan. Focus on measurable signals first, then propose low-risk remediation steps.

## Workflow

1. **Collect signals**
   - Run `scripts/audit_tech_debt.sh` from this skill against the target repo.
   - Capture output in a markdown report file in the repo root.
2. **Classify debt**
   - Group findings into reliability, testability, maintainability, and security/operations.
   - Mark each finding with severity (`high`, `medium`, `low`) and effort (`S`, `M`, `L`).
3. **Prioritize actions**
   - Recommend a top-5 backlog using impact × effort.
   - Include at least one quick win that can be done in <1 day.
4. **Apply one improvement now**
   - Implement one small, safe remediation item when requested.
   - Re-run relevant checks/tests.

## Severity rubric

- **High**: likely production impact, regressions, or blocked velocity.
- **Medium**: recurring developer friction or increased defect probability.
- **Low**: style/cleanup work with minor immediate impact.

## Output contract

Produce:
- A `TECH_DEBT_REPORT.md` file with metrics and findings.
- A prioritized backlog table with owner suggestions and validation checks.

## Resources

### scripts/
- `audit_tech_debt.sh`: repository scanner that outputs markdown debt metrics.

### references/
- `prioritization-matrix.md`: impact/effort scoring and backlog template.
