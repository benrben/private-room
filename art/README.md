# Brand artwork sources

Master SVGs for every generated asset. The brand palette matches
`src/App.css`: ink `#0e1014`, panel `#161a22`/`#1c212c`, border `#262d3b`,
text `#e8eaf0`, slate `#8b93a7`, accent violet `#8b7cf6`. In-app icons live
as React components in `src/icons.tsx`; the favicon is `public/logo.svg`.

| Source | Generates | How |
|---|---|---|
| `appicon.svg` | `src-tauri/icons/*` (icns, ico, PNGs) | render to 1024px PNG, then `npx tauri icon <png>` |
| `docicon.svg` | `src-tauri/icons/document.icns` (.roomai Finder icon) | render sizes 16–1024 into an `.iconset`, then `iconutil -c icns` |
| `dmg-bg.svg` | `src-tauri/dmg-background.tiff` | render at 660×400 and 1320×800, then `tiffutil -cathidpicheck a.png b.png -out …` |
| `banner.svg` | `docs/banner.png` (README banner) | render at 2560×1280 |

> `docicon.svg` is currently a byte-for-byte copy of `appicon.svg`, so
> `document.icns` and `icon.icns` are the same file — a document in Finder
> looks exactly like the app. That's a placeholder, not a decision: give
> `docicon.svg` its own artwork (a page behind the keyhole reads better at
> 16px) and re-run the `iconutil` step above. Git stores the two `.icns` as
> one blob while they're identical.

`arcelle-30-second-publish-master.mp4` is the 30-second launch video (1080p):
"your AI tools are excellent" → "the handoff is still your job" → product
beats → the "Work with context." end card. That end card is the poster frame
`docs/video-poster.png` (`ffmpeg -ss 29.8 -i <mp4> -frames:v 1 -vf scale=1280:-2`),
which the README links to the raw mp4; the video is also attached to GitHub
releases as an asset. Re-generate the poster whenever the master video
changes, or the README's front-page card goes stale.

**Media weight — read before adding another video.** That mp4 replaced the
pre-rebrand 74-second `private-room-productivity-witness-protection.mp4`,
deleted from the tree in 8dbcba6. Deleting a file does not remove it from git:
both videos are in the pack forever (8.5 MB + 6.0 MB), and every `git clone`
pays for both. With `docs/banner.png` (1.1 MB) and the icons, roughly 16 MB of
the ~68 MB repo is front-page media. Only a history rewrite (`git filter-repo`,
or a Git LFS migration) would reclaim it, and that rewrites every commit hash —
it breaks every existing clone and fork, so it is not worth doing for a working
repo. So: **new large media goes on the GitHub release as an asset**; keep only
the poster frame in the tree, and replace a video in place rather than adding a
second one beside it.

The README badge pills (`docs/badge-*.svg`) are hand-authored SVGs, not
generated — edit them directly, keeping the pill recipe: `#161a22` fill,
`#262d3b` stroke, 28px tall with `rx≈14`, a 4px status dot, slate `#8b93a7`
system-font text.

Render SVG → PNG with headless Chrome (no extra tooling needed):

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 \
  --window-size=1024,1024 --screenshot=out.png \
  "file:///path/to/wrapper.html"   # html: <img src="appicon.svg" style="width:1024px;height:1024px"> with zero body margin
```

The `.roomai` document icon is attached via `src-tauri/Info.plist`
(`CFBundleTypeIconFile` → `document.icns`, bundled through the
`bundle.resources` map in `tauri.conf.json`).
