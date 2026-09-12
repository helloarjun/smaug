# builder-skills

47 Claude Code skills for product management, frontend design, full-stack development, and browser automation. Organized by workflow from discovery through deployment.

## Setup

**Install everything** - copy all skills into any project:

```bash
cp -r .claude/skills/ your-project/.claude/skills/
```

**Install globally** - available in every project:

```bash
cp -r .claude/skills/* ~/.claude/skills/
```

**Install selectively** - pick only the categories you need (recommended if you have many skills already, to avoid context bloat):

```bash
# Just design skills
cp -r .claude/skills/design/ your-project/.claude/skills/design/

# Just product skills
cp -r .claude/skills/product/ your-project/.claude/skills/product/

# Mix and match
cp -r .claude/skills/dev/setup/ your-project/.claude/skills/dev/setup/
cp -r .claude/skills/dev/review/ your-project/.claude/skills/dev/review/
```

## Skills

### Design

#### Frameworks

Knowledge skills that provide design principles and decision-making context.

| Skill | References | Covers |
|-------|-----------|--------|
| `frontend-design` | 7 | Typography, color, spacing, motion, interaction, responsive, writing |
| `design-foundations` | 5 | Five planes model - strategy, scope, structure, skeleton, surface |

#### Commands

Slash commands for targeted design work. Most accept an optional argument to scope the work (e.g. `/audit header`, `/polish checkout-form`).

| Group | Command | What it does |
|-------|---------|-------------|
| **Setup** | `/design-brief` | One-time setup - gathers design context and saves to config |
| **Review** | `/audit` | Technical quality checks: a11y, performance, theming, responsive |
| | `/critique` | Design review: hierarchy, clarity, emotional resonance |
| **Refine** | `/normalize` | Align with design system standards |
| | `/polish` | Final pass before shipping |
| | `/distill` | Strip to essence, remove noise |

## Links

- [GitHub](https://github.com/kazdenc/builder-skills)
- [Original Tweet](https://x.com/kazdenc/status/2031035321761075616)
