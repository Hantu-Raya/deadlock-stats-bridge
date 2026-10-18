# style(explorer): restyle the API Explorer to match the in-game mod

## Summary

Only `styles.css` changes. No HTML, JS or behavior changes.

```diff
 <main>                       one column, hero pushes the form below the fold
-  <section.intro>            5.5rem headline, orange eyebrow
-  <section.lookup-section>   4-column form strip, split header
+  <section.intro>  |  <section.lookup-section>   side by side, form in the first screen
   <section.output-section>   full width
-    eyebrow + split header on every section (6 orange labels)
+    one eyebrow (intro); notes stacked under headings
-    tables: player and community columns look the same
+    tables: player column mint and right-aligned, community muted
+    phone: table rows become labelled cards, no sideways scroll
```

- **Palette:** orange `#d18a56` is replaced by the mod's mint `#7ee2a8`, with cool neutrals and one 6px radius everywhere.
- **Contrast:** every text colour passes WCAG AA. The faint labels went from 3.5:1 to 5.3:1, and the button text on mint is 12.3:1.
- **Error panel:** a long request URL in the error text no longer widens the page, which used to scroll to 3,869px.

## Evidence

- **Before:** the hero takes the first screen, and the form starts at the fold line.
  **After:** the form is beside the intro, in the first screen.

| Before | After |
|---|---|
| ![before](https://raw.githubusercontent.com/Hantu-Raya/deadlock-stats-bridge/redesign/explorer-styles/docs/prs/img/redesign-before-fold-1440.png) | ![after](https://raw.githubusercontent.com/Hantu-Raya/deadlock-stats-bridge/redesign/explorer-styles/docs/prs/img/redesign-after-fold-1440.png) |

- **Before:** six orange section labels, and the player and community columns look alike.
  **After:** the player column is the mint subject and community is the muted reference.

| Before, full page | After, full page |
|---|---|
| ![before full](https://raw.githubusercontent.com/Hantu-Raya/deadlock-stats-bridge/redesign/explorer-styles/docs/prs/img/redesign-before-full-1440.png) | ![after full](https://raw.githubusercontent.com/Hantu-Raya/deadlock-stats-bridge/redesign/explorer-styles/docs/prs/img/redesign-after-full-1440.png) |

- **Before:** on a phone, the metric tables scroll sideways.
  **After:** each metric is a card with Player and Community labels.

| Phone before | Phone after |
|---|---|
| ![phone before](https://raw.githubusercontent.com/Hantu-Raya/deadlock-stats-bridge/redesign/explorer-styles/docs/prs/img/redesign-before-full-390.png) | ![phone after](https://raw.githubusercontent.com/Hantu-Raya/deadlock-stats-bridge/redesign/explorer-styles/docs/prs/img/redesign-after-full-390.png) |

| Tablet, 900px | Keyboard focus | Error state |
|---|---|---|
| ![tablet](https://raw.githubusercontent.com/Hantu-Raya/deadlock-stats-bridge/redesign/explorer-styles/docs/prs/img/redesign-after-fold-900.png) | ![focus](https://raw.githubusercontent.com/Hantu-Raya/deadlock-stats-bridge/redesign/explorer-styles/docs/prs/img/redesign-after-focus-1440.png) | ![error](https://raw.githubusercontent.com/Hantu-Raya/deadlock-stats-bridge/redesign/explorer-styles/docs/prs/img/redesign-after-error-1440.png) |

- `node --test` passes 149 tests.

## Merge Danger

**Door:** two-way

Reverting `styles.css` restores the old look.

**Blast Radius:** layout

- **Other pages:** the stylesheet is used only by `index.html`. The chart, party and bridge pages carry their own inline styles.
- **Phone tables:** the card labels Player, Community and Result come from CSS column positions. If a table gains or reorders columns, update the labels in `styles.css`.
- **Browser support:** the stylesheet needs `:has()`-free CSS grid and `100dvh`. Older browsers fall back to `min-height` on the body, which is harmless.
