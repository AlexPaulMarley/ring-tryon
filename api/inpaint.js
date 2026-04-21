// /api/inpaint.js
// ---------------
// Vercel serverless function. Proxies inpaint requests from the verify page
// to a configured image-gen provider. Keeps your API key server-side so it
// never reaches the browser.
//
// Provider selection: whichever env var is set.
//
//   FAL_KEY      -> fal.ai Flux Fill (recommended: fast, cheap, good)
//   OPENAI_KEY   -> OpenAI gpt-image-1 with mask (higher quality, pricier)
//   (neither)    -> returns the original image with a "mock" note so the
//                   UI can be tested end-to-end without a key
//
// In Vercel: Project Settings → Environment Variables → add FAL_KEY.
// Get a key at https://fal.ai → Dashboard → API Keys.
//
// Request body  JSON:  { image: dataURL, mask: dataURL, prompt: string }
// Response body JSON:  { image: dataURL, note?: string }

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  try {
    const { image, mask, prompt } = req.body || {};
    if (!image || !mask || !prompt) {
      return res.status(400).json({ error: 'image, mask, and prompt are required' });
    }

    if (process.env.FAL_KEY) {
      const out = await callFal({ image, mask, prompt, key: process.env.FAL_KEY });
      return res.status(200).json({ image: out });
    }

    if (process.env.OPENAI_KEY) {
      const out = await callOpenAI({ image, mask, prompt, key: process.env.OPENAI_KEY });
      return res.status(200).json({ image: out });
    }

    // No provider configured: echo the original image back so the UI loop
    // is testable end-to-end. Flag it clearly so nobody ships this by accident.
    return res.status(200).json({
      image,
      note: 'MOCK MODE — set FAL_KEY or OPENAI_KEY in Vercel env vars to enable real regeneration',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}

// -------- fal.ai Flux Fill --------
// Docs: https://fal.ai/models/fal-ai/flux-pro/v1/fill
// The fal REST submit→poll pattern is used here rather than the JS SDK,
// so this function has zero npm dependencies and deploys instantly.
async function callFal({ image, mask, prompt, key }) {
  const submit = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1/fill', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Key ${key}`,
    },
    body: JSON.stringify({
      image_url: image,      // data URLs are accepted
      mask_url:  mask,
      prompt,
      num_inference_steps: 28,
      guidance_scale: 30,
      safety_tolerance: '3',
    }),
  });
  if (!submit.ok) throw new Error(`fal submit failed: ${submit.status} ${await submit.text()}`);
  const { status_url, response_url } = await submit.json();

  // Poll until complete (fal returns quickly, usually 3-8s for Flux Fill).
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const s = await fetch(status_url, { headers: { 'authorization': `Key ${key}` } });
    const j = await s.json();
    if (j.status === 'COMPLETED') break;
    if (j.status === 'FAILED')    throw new Error('fal job failed: ' + JSON.stringify(j));
  }
  const r = await fetch(response_url, { headers: { 'authorization': `Key ${key}` } });
  const out = await r.json();
  const imageURL = out?.images?.[0]?.url;
  if (!imageURL) throw new Error('fal returned no image');

  // Download and convert to data URL so the browser doesn't need to fetch
  // from an external domain (avoids CORS + keeps history self-contained).
  return await urlToDataURL(imageURL);
}

// -------- OpenAI gpt-image-1 edits --------
// Docs: https://platform.openai.com/docs/guides/images
async function callOpenAI({ image, mask, prompt, key }) {
  const imageBlob = await (await fetch(image)).blob();
  const maskBlob  = await (await fetch(mask)).blob();
  const form = new FormData();
  form.set('model', 'gpt-image-1');
  form.set('prompt', prompt);
  form.set('image', imageBlob, 'image.png');
  form.set('mask',  maskBlob,  'mask.png');
  form.set('size',  '1024x1024');

  const r = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) throw new Error(`openai edit failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error('openai returned no image');
  return `data:image/png;base64,${b64}`;
}

// -------- helpers --------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function urlToDataURL(url) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || 'image/png';
  return `data:${ct};base64,${buf.toString('base64')}`;
}
