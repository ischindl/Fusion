import type { PluginSkillContribution } from "@fusion/plugin-sdk";

/**
 * Compound Engineering pipeline-stage skills, bundled (pinned) inside the plugin.
 *
 * Each entry's `skillFiles` is plugin-root-relative and points at a `SKILL.md`
 * physically shipped under `src/skills/<skillId>/`. The bundled copy is a pinned
 * snapshot (KTD5) — never a symlink to the global compound-engineering cache —
 * so registering it can never clobber a user's global install (R12).
 *
 * The frontmatter `name` in each bundled SKILL.md equals the directory name
 * (e.g. `ce-brainstorm`), so `skillId === name` here. pi-coding-agent's
 * `loadSkills` derives `Skill.name` from that frontmatter, which is what the
 * engine skill-resolver matches against.
 */
export const COMPOUND_ENGINEERING_SKILLS: PluginSkillContribution[] = [
  {
    skillId: "ce-strategy",
    name: "ce-strategy",
    description:
      "Create or maintain STRATEGY.md — the product's target problem, approach, users, key metrics, and tracks of work.",
    skillFiles: ["skills/ce-strategy/SKILL.md"],
    enabled: true,
    triggerPatterns: ["strategy", "roadmap", "what are we working on", "set up the strategy doc"],
  },
  {
    skillId: "ce-ideate",
    name: "ce-ideate",
    description:
      "Generate and critically evaluate grounded ideas about a topic before committing to one direction.",
    skillFiles: ["skills/ce-ideate/SKILL.md"],
    enabled: true,
    triggerPatterns: ["ideate", "give me ideas", "what should I improve", "surprise me"],
  },
  {
    skillId: "ce-brainstorm",
    name: "ce-brainstorm",
    description:
      "Explore requirements and approaches through collaborative dialogue, then write a right-sized requirements document.",
    skillFiles: ["skills/ce-brainstorm/SKILL.md"],
    enabled: true,
    triggerPatterns: ["brainstorm", "what should we build", "help me think through"],
  },
  {
    skillId: "ce-plan",
    name: "ce-plan",
    description:
      "Create structured plans for multi-step tasks and optionally deepen existing plans via sub-agent review.",
    skillFiles: ["skills/ce-plan/SKILL.md"],
    enabled: true,
    triggerPatterns: ["plan this", "create a plan", "break this down", "deepen the plan"],
  },
  {
    skillId: "ce-work",
    name: "ce-work",
    description: "Execute work efficiently while maintaining quality and finishing features.",
    skillFiles: ["skills/ce-work/SKILL.md"],
    enabled: true,
    triggerPatterns: ["do the work", "implement", "execute the plan", "finish this feature"],
  },
  {
    skillId: "ce-code-review",
    name: "ce-code-review",
    description:
      "Structured code review using tiered persona agents, confidence-gated findings, and a merge/dedup pipeline.",
    skillFiles: ["skills/ce-code-review/SKILL.md"],
    enabled: true,
    triggerPatterns: ["code review", "review this change", "review before PR"],
  },
  {
    skillId: "ce-compound",
    name: "ce-compound",
    description:
      "Document a recently solved problem to compound the team's knowledge or the project's shared CONCEPTS.md vocabulary.",
    skillFiles: ["skills/ce-compound/SKILL.md"],
    enabled: true,
    triggerPatterns: ["compound this", "document this learning", "capture this solution"],
  },
];
