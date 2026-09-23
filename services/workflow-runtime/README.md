# Jupiter Workflow runtime

SET 5 durable Planner boundary and Workflow Engine. It validates strict structured plans, rejects unsafe graphs, schedules dependency-safe parallel work, enforces timeouts and bounded retries, persists every attempt, supports checkpoints and artifact passing, and reconstructs state after restart.

Executors are injected through a narrow bridge. This package does not implement the SET 6 Skill Registry and the desktop runtime registers no simulated skills.
