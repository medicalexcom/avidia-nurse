# Dynamic Case and Simulation Generation

Dynamic personalized learning is implemented as an asynchronous, server-only worker pipeline. The Expo client creates an owner/course-scoped `ai_learning_requests` row; the worker claims it, selects structured M8 mastery signals, retrieves at most eight M5 chunks, routes the authoring task, validates it, and stores the reusable result.

## Case studies

Modes are Recommended for Me, Upcoming Exam, My Weakest Area, Choose Topic, Surprise Me, and Another Case Like This. Difficulty is Foundational, Application (default), Advanced, or Complex. LOW/MEDIUM routes to STANDARD; Complex routes to ADVANCED.

A draft contains a fictional patient, history, presentation, vitals, labs, medications, findings, unfolding phases, questions, answer indexes, rationales, and source indexes. Validation rejects missing/inconsistent answers and citations outside the retrieved set. One bounded repair is allowed; a second failure is rejected. Stored rows retain owner/course, concept and chunk ids, provider/model/tier, prompt/generator/validator versions, fingerprint, grounding, and lifecycle status.

## Simulations

The model authors a closed `SimulationCaseDefinition` through `SIMULATION_CASE_GENERATION` (ADVANCED). The worker runs the existing strict `validateCase()`, checks concept references against deterministic selection, permits one repair, and stores valid definitions in `simulation_cases` with private ownership and generation provenance.

Starting a generated case calls the existing `start_simulation`; all state changes, hidden findings, rules, action classification, scoring, outcomes, debrief, and M8 evidence remain the unchanged deterministic M11 SQL engine. Built-in cases remain owner-null and available when AI is unavailable.

## Grounding and degraded mode

Only retrieved chunks are sent, with document filename, chunk id, and page/slide/section locator. Generated content is labeled `course_grounded`; generation rejects when retrieval is empty. Stored questions, cases, built-in simulations, scoring, mastery, planner, and analytics do not depend on live AI.
