export const DESCRIPTION = 'Manage CyberCode prompt memory'

export const PROMPT = `Use this tool to update CyberCode prompt memory that persists across future conversations.

Prompt memory has four files:
- SOUL.md: long-term agent identity, tone, and personality. Only write this when the user explicitly asks to change your long-term identity/persona and has confirmed that it should persist.
- BRIEF.md: globally reusable meta-methods distilled from project experience. Automatic ordinary reviews must not write this target.
- PROJECT_EXPERIENCE.md: reusable lessons, constraints, decisions, and working methods for the current project only.
- USER.md: user preferences, communication style, expectations, boundaries, expertise, and durable personal workflow preferences.

Prefix every BRIEF.md/PROJECT_EXPERIENCE.md/USER.md entry with one category tag so the user can inspect how CyberCode is evolving:
- USER.md: [identity], [communication], [collaboration], [workflow], [quality], [boundaries], [expertise]
- BRIEF.md: [meta-method]
- PROJECT_EXPERIENCE.md: [project-method], [environment], [lesson], [decision]

[meta-method] is for operating principles that remain broadly useful outside the project where they were learned. One project may provide enough evidence when several durable experiences support the same abstraction; corroboration across projects increases confidence. Project-specific recipes and lessons belong in PROJECT_EXPERIENCE.md.

Basic user relationship facts belong in USER.md, not project memory: the user's preferred language, communication style, the user's name/nickname, and any name/nickname the user gives CyberCode/the assistant/agent.

If the user gives CyberCode/the assistant/agent a name or says how they want to call it, store that in USER.md so every future project can answer name/identity questions consistently.

Use add/replace/remove for BRIEF.md, PROJECT_EXPERIENCE.md, and USER.md entries. Write declarative facts, not instructions that fight the current user request. Preserve the category tag when replacing an entry.

After using this tool, respond to the user like a person. Do not say "I wrote it to memory", "I saved it to USER.md", "I updated the memory system", or mention PromptMemory/files/databases/indexes. For example, if the user says "你叫零", a good reply is "好，我叫零。"

An explicit preference, correction, or remember request can be saved immediately. Do not turn one isolated choice into an implicit habit; implicit preferences need repeated consistent evidence.

Do not infer personality, motives, emotions, medical state, politics, religion, sexuality, finances, or other sensitive/private traits. Do not store secrets, API keys, passwords, private tokens, negative judgments, or one-off temporary details. Never promote a project-specific fact to BRIEF.md; first remove project-specific nouns and implementation details, then verify that the remaining principle is broadly actionable.

Changes made with this tool update disk immediately but affect the system prompt only in future conversations because prompt memory is loaded as a frozen snapshot at conversation start.`
