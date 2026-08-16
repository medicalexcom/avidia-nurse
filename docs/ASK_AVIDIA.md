# Ask Avidia

Ask Avidia is a course-aware, retrieval-grounded tutor, not a generic chatbot. The Study dashboard and question review link to the shared Expo screen. Course, concept/question identifiers, bounded recent conversation, and client-safe simulation context travel as structured context; students do not copy prompts manually.

## Routing

- ordinary grounded answers: `RAG_ANSWER` / STANDARD
- simple explanations: `BASIC_EXPLANATION` / ECONOMY
- deep mechanism/pathophysiology: `DEEP_TUTORING` / ADVANCED
- analysis of student reasoning: `CLINICAL_REASONING_EVALUATION` / ADVANCED
- case/simulation requests: handoff to the corresponding authoring queue

The worker retrieves at most eight course chunks and stores only source chunk ids on assistant messages. Conversation history is capped at ten messages in model context.

## Simulation safety

Active simulation context may contain only the already-redacted client view. Requests for hidden findings, future events, scoring/critical-action rules, the exact next action, or “how to win” receive a deterministic refusal without an AI call. A completed debrief may be discussed because it is no longer hidden.

## Failure behavior

Provider, schema, or retrieval failures are persisted as a friendly retryable status. Raw provider details never reach a student. Existing deterministic study and stored generated content continue to work.
