# Task recipe editor

The editor follows Vela's existing desktop theme: system sans-serif typography,
neutral surfaces, blue primary actions, subtle borders, and shared radius tokens.
Task instructions are the focus; library administration and optional metadata stay
out of the initial editing path. No illustration is needed for this form.

## Layout

- A sticky heading keeps Save recipe and Close editor with the current document.
- A compact toolbar groups the library destination and Organize with AI action.
- Basics pairs the name with the default mode and a short description.
- Task instructions precede parameters and structured stages.
- Skill dependencies, tags, variable insertion, and source references use
  disclosures. Existing metadata and validation errors expose the relevant settings.
- Editor sections use spacing and single separators instead of an enclosing card.
- The library header retains its create, import, and refresh actions. Team library
  management appears in the library view.

## Dialog

Unsaved changes uses a centered dialog up to 440px wide, independent of page
layout styles. Save and leave is the primary action; Keep editing receives initial
focus. Discard changes is separated on the left. Escape and the close button keep
the draft, and closing restores focus to the initiating control. Busy actions
disable dismissal.

## Validation

Risk: medium, confined to recipe page composition and dialog interaction.
Renderer typecheck and focused Electron interaction checks cover navigation,
source text, sticky actions, dialog centering, cancel/resume, save payload,
narrow layout, and 200% zoom. Dark and light screenshots are visually inspected.

```sh
pnpm --filter @vela/desktop exec tsc -p tsconfig.web.json --noEmit
VELA_RECIPE_UI_CAPTURE=/tmp/vela-recipes-redesign node apps/desktop/test/chat-actions-ui.mjs
```

Screenshot baselines are the user's two supplied editor/dialog captures.
Generated evidence uses 900×800, 900×600, and 520×720 windows, dark/light themes,
expanded optional settings, and 200% zoom.
The fixture uses an isolated synthetic recipe API; no personal recipes are saved.

## Visual review

A separate reviewer inspected the dark, light, narrow, modal, and zoom screenshots
against Vela's existing design tokens. The accepted refinements reduced space
before the first editable field and aligned name/mode control heights. The
redundant editor subtitle was removed; optional explanations and source IDs moved
into disclosures. The final screenshots were checked again after these changes.
No visual score was used for this existing-interface refinement.
