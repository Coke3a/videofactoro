# Spike results

Fill in after running each spike with the real account (see docs in each script header for expected spend).
For each: command, result, measured values, conclusion for plans 2-4.

## 0 - live check without R2 (2026-10-27, token copied from Hermes VPS)

Script: a scratch file calling tools/ directly (token, llmJson for each model, generateImage without refs, pickBest characterRef). Total spend about $0.02.

- Token `CLOUDFLARE_AI_API_TOKEN` (53 chars): `GET /ai/models/search` returns 200. `/ai/run` works for both the `@cf/*` models and third-party models, so Unified Billing credits are present.
- **Gemini 3.8 flash:**
  - Thinking tokens count against `maxOutputTokens`, and Gemini bills them as output.
  - With 64 max tokens, `thoughtsTokenCount` was 61, `finishReason` was MAX_TOKENS, `parts` was `[]`, and `candidatesTokenCount` was missing.
  - With 1024, the reply was `{"ok":true}`, with 5 candidate tokens and 114 thought tokens.
  - Fixed in 0d02dcb: a 2048 headroom constant, `usage.out` = candidates + thoughts, a truncation issue text, and setup's maxTokens raised from 16 to 64.
  - After the fix: 3.98 s, 56 in / 97 out, $0.00041.
- **Haiku 5.5:**
  - The structured-output schema must set `additionalProperties:false` on every object. Without it the call fails with 400 code 7003.
  - Fixed in 0d02dcb. After the fix: 3.16 s, 216 in / 9 out, $0.000026.
- **klein:**
  - Test: prompt only, `aspect_ratio:"3:4"`, `resolution:"1k"`, `seed:42`.
  - It returns JPEG bytes (ffd8ffe0), about 200 KB at 1.04 MP, in 15–17 s, for $0.0091.
  - The same seed and prompt run twice produced files of different sizes (200291 vs 199460 bytes), so the seed alone does not give byte-identical output.
  - Visual check: a single character, full body, no text. The output is good.
- **clef-omni:** `{model:"clef-omni", state, questions, images:[data URI]}` returns `answers.<k>.noul`, 728 input tokens, in 0.65 s. characterRef passed with a score of 1.14.
- Still not run: R2 (no bucket or token yet), and klein with refs through R2.

### 0b - refs without R2 (2026-10-27)

- `black-forest-labs/flux-3-image-klein` with raw base64 in `images[0]` returns 400 code 7003 "Must be an HTTP(S) URL". The third-party flux-3 models need hosted URLs.
- `@cf/black-forest-labs/flux-2-klein-9b` takes multipart input: `prompt`, `input_image_0` (a file part), and `width`/`height` as strings. The response is `{image: base64}`, a JPEG of 261 KB at 768x1024, in 4.6 s.
  - Visual check against the cat ref: the same character (colours, stripes, belly patch, ears, tail), with the pose changed to sitting and smiling as the prompt asked. The output is good.
  - It is neuron-billed; the exact cost is still to be read from the gateway log.
- So images and character refs can work with no R2 through flux-2-klein-9b.
- Later the same day, every flux-2 call (9b and 4b) failed with 500 or 408 for about an hour, while flux-1-schnell kept working. After that, some calls still returned 500 intermittently; `withRetry` already retries 500 errors (PROVIDER_DOWN).
- `seed` (sent as a string) is accepted. Two runs with the same seed and prompt at 768x1360 gave byte-identical output (sha e780c2214eb2, 117850 bytes, about 2.1–2.7 s), so the output is deterministic, unlike flux-3-image-klein.

## a - klein-9b (768x1360, refs 1..4 inline multipart)

## b - (dropped: R2 removed from the project 2026-10-27)

## c - flux-3-video i2v with a raw base64 keyframe (2026-10-27)

- Input: `{mode:"i2v", prompt, keyframes:"<raw base64 jpeg, no data: prefix>", aspect_ratio:"3:4", duration:5, resolution:"hd", draft:true, generate_audio:false}`.
- Result: OK in 60.5 s, returning `{state, result}` with a video URL. The mp4 is 800x1088 at 24 fps, 5.04 s, 1.45 MB, with no audio stream, so `generate_audio:false` is honoured.
- Frame 0 matches the keyframe exactly. The cat waves and blinks as the prompt asked.
- Conclusion: video needs no hosted URL. R2 has been removed from the whole project. The price still has to be read from the gateway log (spike d).

## d - flux-3-video price units (gateway log)

## e - bria/remove-background request/response

## f - clef-omni calibration (same_character, has_text)

## g - last-frame chaining
