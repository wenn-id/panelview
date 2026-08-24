# PanelView viewer contract

PanelView consumes Comic Sol project manifests from `project.json` and
`plan/storyboard.json`. This compatibility record is intentionally small and
should be updated whenever a consumed field changes.

## Manifest compatibility

| `project.json` field | PanelView use | Tested versions |
|---|---|---|
| `schema_version` | Compatibility notice for the reader | `"1.0"` |
| `settings.page_width` / `settings.page_height` | Scale storyboard rectangles to the source image | `"1.0"` |

A missing `schema_version` is accepted as a legacy manifest and logged. A
version not listed above is still rendered from the available geometry, but the
reader displays a non-blocking warning because its framing may be inaccurate.

## Storyboard geometry

| `plan/storyboard.json` field | PanelView use | Tested versions |
|---|---|---|
| `pages[].number` | Match `page-NNN` image files to storyboard pages | `"1.0"` |
| `pages[].layout` | Fallback geometry when panel rectangles are unavailable | `"1.0"` |
| `pages[].panels[].rect` | Primary panel geometry for Guided mode | `"1.0"` |

The Comic Sol schema definitions are authoritative for manifest structure:
[`comic-sol/references/schemas.md`](https://github.com/wenn-id/comic-sol/blob/main/references/schemas.md).

When Comic Sol changes a consumed field or bumps its schema, update this
contract and the compatibility tests before relying on the new output.

## Story plan presentation

| `plan/story-plan.json` field | PanelView use | Tested versions |
|---|---|---|
| `logline` | Toolbar subtitle next to the book title | `"1.0"` |

A missing story plan is fine; the subtitle simply stays hidden. When
`project.json` has no `title`, the `project_id` slug is prettified into the
display title (`sunlight-courier` → `Sunlight Courier`).

## Verification

Open [`../test.html`](../test.html) in a browser. The compatibility tests cover
legacy manifests, the tested `"1.0"` version, and unknown versions that must
continue rendering while surfacing the warning.
