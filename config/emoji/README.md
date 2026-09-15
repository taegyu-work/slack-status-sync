# Custom Slack emoji

Bold Korean text rendered edge-to-edge (128×128, `#0288D1`, transparent
background) by `scripts/text-emoji.ps1`. Earlier versions tried 이태규's actual
handwriting, then a pill/ring badge around smaller text — both looked fine at
full size but turned to mush at Slack's real inline size (~16-20px). Plain
bold text with minimal margin, sized to fill the canvas, is what actually
stays legible that small.

Uploaded to the EverTri workspace as:

| File | Slack name | Used for |
|---|---|---|
| `yeoncha.png` | `:yeoncha:` | 연차 |
| `bancha.png` | `:bancha:` | 반차, 반차_AM, 반차_PM |
| `banbancha.png` | `:banbancha:` | 반반차, 반반차_AM, 반반차_PM (3 syllables —
  reads a bit smaller than the other two even at the tightest fit; a two-line
  layout would fix that if it's ever worth doing) |

Referenced from `config/status-map.json`. If they ever need re-uploading
(workspace migration, accidentally deleted), re-upload these files under the
same names via Slack → Settings & administration → Customize Workspace →
Emoji → Add Custom Emoji. Slack has no in-place image edit — replacing one
means deleting it and re-adding under the same name.
