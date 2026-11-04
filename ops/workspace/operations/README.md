# Operations project

This project contains the current operational notes and reports for the bridge and its host environment. The agent has no direct host administration access, Docker socket, or root privileges.

## Incident records

Verified container events may be delivered to Discord and saved under `/workspace/artifacts/incidents/<incident-id>/latest.json`. Review the record's source, resource, status, summary, and occurrence time before describing an incident. A delivered record supports diagnosis; it does not authorize a change to the host.

Keep operational reports here when they need a durable project record. Include the evidence, time, impact, and unresolved questions. Do not copy credentials, tokens, private configuration, or unrelated user data into reports or `/knowledge`.

## Tasks and reviews

Use `/project projekt:operations` to select this project. This initial directory has no Git repository. `/task` requires an explicitly configured Git project and creates its worktrees under `/workspace/worktrees/<project>/`. Worktrees are not a security boundary. Do not edit another task's files. Agent 2 is awaiting connection, so prepared review material is not a completed review.

## Automations

No automations are configured. Create an automation only after the user explicitly requests it and confirms the purpose, schedule, and destination. Keep its prompt self-contained and do not infer recurring work from an incident or this document.

Infrastructure changes require an explicit user request and an authorized operator workflow. Do not imply that the agent can execute host-level repairs.
