# TRACKING.md — interpreter

> Per shared/specs/EVENT_CAPTURE.md §9 + shared/specs/CONTINUOUS_LEARNING.md §2.2.

## Slug

`interpreter` — must match the project's row in `workers/event-capture/wrangler.toml`
`ALLOWED_PROJECTS` and the helper's `data-event-capture-key` attribute.

## Custom events emitted

Document every project-specific event the product code calls via
`window.track(...)`. Example:

| Event | Where | Props |
|---|---|---|
| `<event_name>` | `path/to/file.html` | `{ funnel?, step?, of? }` |

## Funnels

Define every multi-step user flow as a named funnel. The rollup job reads
this section; step order matters.

```yaml
# Required: at least one funnel if the project has any multi-step flow.
funnels:
  - name: <funnel_name>
    steps:
      - <event_for_step_1>
      - <event_for_step_2>
      - <event_for_step_3>
    abandonment_window_min: 30
```

## How to fire steps

```javascript
// In product code — uses the v2 helper's trackStep(...) shorthand which
// also auto-fires funnel_complete when step === of.
window.trackStep('<funnel_name>', 1, 3, { /* extra props */ });
window.trackStep('<funnel_name>', 2, 3, { /* … */ });
window.trackStep('<funnel_name>', 3, 3, { /* … */ });  // funnel_complete also fires
```

## Inquiry surfaces

Every existing contact-form / lead-form / partner-CRM submit handler should
emit:

```javascript
window.track('inquiry_submit', { source: '<form-id>', category_guess: '<bug|sales|support|…>' });
```

The form's destination doesn't change — this just registers existence for
correlation against errors/feedback.

## Notes

<add anything specific to this project — sampling overrides, abandonment
window changes, etc.>
