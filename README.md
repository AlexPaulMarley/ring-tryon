# Jewellery try-on + verification — WebAR prototype

End-to-end pieces of the jewellery design pipeline, deployable as a single
static site on Vercel:

- **AR try-on** (`/`) — MediaPipe Hands + Three.js, rings and bracelets,
  works on iPhone Safari and Android Chrome. Share via QR code.
- **Verification UI** (`/verify.html`) — load an AI-generated design, paint
  mask regions, describe changes, regenerate just those regions.
  Backed by a Vercel serverless function that proxies to fal.ai or OpenAI.

## Structure

```
ring-tryon/
├── public/
│   ├── index.html       AR try-on UI shell
│   ├── app.js           try-on logic (ring + bracelet)
│   ├── verify.html      verification UI shell
│   ├── verify.js        mask paint, regenerate, history
│   └── rings/           per-client .glb files
├── api/
│   └── inpaint.js       serverless inpaint proxy (fal.ai / OpenAI)
├── vercel.json
├── package.json
└── .gitignore
```

## Deploy to Vercel

On your desktop (Claude Code or terminal):

```bash
# unzip the project if needed, then:
cd ring-tryon

# push to GitHub (first time)
gh repo create ring-tryon --public --source=. --remote=origin --push

# deploy
npx vercel --prod
```

Then in the Vercel dashboard → Project → Settings → Environment Variables:

- `FAL_KEY` — recommended. Grab from <https://fal.ai> dashboard.
  Or
- `OPENAI_KEY` — works too, more expensive.

Without either key, `/api/inpaint` runs in **mock mode** and returns the
original image unchanged with a clear note — useful for UI testing
before you commit to a provider.

## Run locally

```bash
npm start       # serves public/ on http://localhost:8000
```

Localhost counts as a secure context, so camera access works from a
laptop. For phone testing locally, tunnel with ngrok:

```bash
npx ngrok http 8000
```

Then open the `https://…ngrok.io` URL on your phone. Note: the
`/api/inpaint` function only runs on Vercel, not `npm start` — for local
API testing use `npx vercel dev` instead.

## Try-on URL params

| Param    | Values                  | Default | Meaning                                  |
|----------|-------------------------|---------|------------------------------------------|
| `mode`   | `ring` / `bracelet`     | `ring`  | Which body part to track                 |
| `jewel`  | path or full URL to GLB | —       | Custom 3D model (replaces placeholder)   |
| `palm`   | number (cm)             | `8.5`   | Hand-size calibration                    |
| `debug`  | `1`                     | off     | Render 21 hand landmarks as green dots   |

Legacy `?ring=…` still works as an alias for `?jewel=…`.

### Example URLs

```
/                                              ring, placeholder
/?mode=bracelet                                bracelet, placeholder
/?mode=ring&jewel=rings/sophia.glb             ring, custom GLB
/?mode=bracelet&jewel=rings/atlas.glb          bracelet, custom GLB
/?mode=ring&jewel=rings/x.glb&palm=9.2         big hands + custom ring
/?mode=bracelet&debug=1                        bracelet + landmark dots
```

QR codes: point any QR generator at the full URL, including query params.
Both iOS and Android camera apps open QR links natively.

## Verification workflow

1. Go to `/verify.html` (or link from the try-on page).
2. Upload a design image — eventually this comes from the upstream
   sketch→image step; for now it's a file picker or "Use sample".
3. Paint with your finger/mouse over the region(s) to change. Brush
   size slider, undo stroke, clear mask.
4. Type the change in plain English. Examples:
   - "Replace the centre stone with an emerald, keep the setting style"
   - "Add pavé diamonds around the band"
   - "Make the prongs thinner and more delicate"
5. Click **Regenerate selected area**. Server calls fal.ai Flux Fill (or
   OpenAI if you configured that). Result appears in place.
6. Each regeneration lands in the History row — tap any thumb to revert.
7. When happy, click **Approve current** — downloads the PNG.

## Bracelet mode — what's different

The tracking uses the same MediaPipe hand model. Differences:

- Anchor point is the **wrist landmark** (MediaPipe index 0), offset
  slightly into the forearm so the bracelet sits behind the wrist bone
  rather than on the palm edge.
- Axis direction is **wrist → middle-finger MCP reversed**, i.e.
  pointing up the forearm away from the fingers.
- Occluder is a larger cylinder (28 mm radius, 100 mm length) to cover
  the wrist and forearm.

Caveat: this derives the forearm direction from the hand alone, so it
assumes the wrist isn't severely flexed. For extreme wrist angles the
bracelet axis will be slightly off — fix later by adding MediaPipe Pose
for the real elbow→wrist vector.

## Tuning knobs

All in `public/app.js`:

- `PRESETS.ring` / `PRESETS.bracelet` — placeholder size, occluder size,
  placement offsets, target diameter for GLB normalisation.
- `OneEuroVec3(minCutoff, beta)` — smoothing.  Lower `beta` = calmer ring
  at rest, slightly more lag when moving fast.
- `PALM_WIDTH_METERS` (via `?palm=`) — depth estimation prior.

## Common issues

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Ring floats next to finger | Palm-width prior off | `?palm=9.0` (or similar) |
| Ring wrong size | Same | Same |
| Back of ring draws through finger | Occluder too thin | Bump `occluderRadius` in PRESETS |
| Bracelet drifts when wrist tilts | No forearm info | Accept for MVP; wire in MediaPipe Pose later |
| iOS black screen after Start | Safari race | Reload, tap Start again |
| "MOCK MODE" on regenerate | No API key set | Add `FAL_KEY` in Vercel env vars |
| Regenerate hangs / times out | fal queue backed up | Retry; if persistent, check fal.ai status |

## Roadmap (what's not built yet)

1. Upstream: sketch photo → Flux/ControlNet → image (the thing `verify`
   takes as input). Likely another `/api/` function + a small upload UI.
2. Downstream: approved image → Meshy/Tripo/Rodin → GLB → drop into
   `public/rings/`, return URL for the try-on link.
3. MediaPipe Pose integration so bracelet axis tracks the real forearm.
4. Environment lighting from the live camera feed for photoreal metals.
5. Auth on `/verify.html` (right now it's public; fine for prototype,
   not for production).
6. Self-hosted MediaPipe WASM + model files for reliability (currently
   loads from jsDelivr + Google storage CDNs).
