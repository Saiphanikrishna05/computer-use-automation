# Proposed repair — `lookup_member_savings_balance` v1

Generated 2026-08-25T09:55:40.970Z from a run in which 1 step(s) could not find their control and a model was asked where it went.

**Nothing here has been applied.** The capability on disk is unchanged. This is a proposal, because a capability is approved on the strength of what a reviewer read, and a system that rewrites the approved thing on its own has made that approval worth nothing.

## Step `click_5`

Recorded target: **button "Search" in the Member Search panel**
Model chose: **button "Run Member Inquiry" in the Member Search panel**
Because: *It is the submit control in the Member Search panel that executes the search for the entered Member ID, just renamed from "Search" to "Run Member Inquiry" (the only other button there, "Clear", resets the form).*

Proposed replacement descriptor:

```json
{
  "description": "button \"Run Member Inquiry\" in the Member Search panel",
  "framePath": [
    {
      "ordinal": 1,
      "name": "contentFrame",
      "urlPattern": "/console/content"
    }
  ],
  "candidates": [
    {
      "kind": "role_name",
      "role": "button",
      "name": "Run Member Inquiry",
      "exact": true
    },
    {
      "kind": "structural",
      "css": "input[name=\"submitInquiry\"]",
      "ordinal": 0
    },
    {
      "kind": "coordinates",
      "xFraction": 0.[redacted:••5625],
      "yFraction": 0.[redacted:••5553]
    }
  ],
  "anchor": {
    "containerRole": "panel",
    "containerName": "Member Search"
  },
  "evidence": {
    "role": "button",
    "accessibleName": "Run Member Inquiry",
    "tag": "input",
    "boundingBox": {
      "x": 158,
      "y": 269,
      "width": 136.765625,
      "height": 21
    },
    "viewport": {
      "width": 1280,
      "height": 900
    }
  }
}
```

Before applying: confirm this is the same control and not merely one in the same place. Then re-probe the capability, because a moved control usually means the screen moved, and the declared outcomes were verified against the old one.
