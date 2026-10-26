# Clips (`vf clip`)

One clip = one shot of 5–20 seconds, built from the project's existing characters and places.

## Pipeline

| Step | Model | What happens | Cost (est.) |
|---|---|---|---|
| plan | Gemini 3.8 Flash (fallback Claude Haiku 5.5) | Picks 1–3 characters and a place, writes `first_frame_prompt`, a timed `video_prompt`, `narration`, `music_prompt`, title and summary. Validated against a schema; invalid answers are sent back with the issues. | ~$0.006 |
| keyframe | flux-2-klein-9b | First frame from up to 3 character refs + the place plate, sent inline (no storage bucket). | ~$0.021 each |
| keyframe QA | clef-omni | Per character `same_<id>` ≥ 0.6, `fits_shot` ≥ 0.5, `has_text` < 0.3. Rejects are rerolled up to `--max-rerolls`; the best pass wins. | ~$0.0003 |
| video | flux-3-video | Image-to-video from the keyframe (base64), `generate_audio: true`, "No background music." appended. Draft by default. | $0.06 draft / $0.17 hd (unverified) |
| video QA | clef-omni | Report only: `character_consistent` ≥ 0.6, `no_morphing` ≥ 0.6, `follows_prompt` ≥ 0.5, `unwanted_text` < 0.3. Also answers the music gate: `needs_music`, `dialogue_heavy`. | ~$0.0003 |
| narration | Gemini 3.8 Flash TTS | Only if `project.json` has `narrator: true` and no `--no-narration`. Voice = `narrator_voice` (default `Leda`). WAV, 24 kHz mono. | ~$0.001 (unverified) |
| music | ElevenLabs Music v2 | Instrumental, at least 10 s, from `music_prompt` + the project's `music_style`. On when `--music`, or when `needs_music` ≥ 0.5 (unknown counts as yes). | ~$0.025 per 10 s |
| mix | ffmpeg (local) | Scene audio + narration (0.3 s delay, sped up to 1.3× if too long) + music (fades, ducked under the voice with sidechain compression; quieter when `dialogue_heavy` ≥ 0.6). Video stream copied, cut to the video length. | free |

A 6 s draft with narration cost $0.11 in a live run; without audio, $0.09.

## Writing the `--prompt`

The prompt is the director's note for the planner, not the image prompt. Good prompts:

- name who is in the shot by id or role ("Pip the mouse", "the cat"),
- say the one action and its payoff,
- may set the mood or the camera ("slow push-in", "low angle from the floor").

> Pip the mouse tiptoes past sleeping Marmalade to steal a cookie from the living room table

Avoid: lists of events, on-screen text, dialogue walls, brand or famous names, describing a character's look (the project already locks it).

## What the planner writes (`clips/<id>/plan.json`)

- `first_frame_prompt` (English): a still frame. Positions, poses, expressions, the setting. No motion blur, no text.
- `video_prompt` (English): a timeline with 2–3 beats per 5 s ("0-2s: … 2-5s: …"), the camera move, and **diegetic sound only** (footsteps, purring, clinks). No instruments or cartoon stingers; music is added later. Dialogue goes in quotes.
- `narration`: 1–2 short sentences in the project language that add meaning rather than describe the picture, sized to fit the clip minus 1 s (2.2 words/s; 11 chars/s for languages without spaces such as Thai, Chinese, Japanese).
- `music_prompt` (English): mood, instruments, BPM, no vocals.

## Resume and idempotency

- The clip key is the `--id`, or a hash of prompt + duration + hd + narration + music settings. State lives in `.vf/clip-<key>-state.json`.
- A finished key rerun = USAGE ("already done"). Use a new `--id` for a variation.
- A crash mid-run: rerun the same command (or the job's `resume`). Finished steps are skipped. Once the video request was sent, its request id is saved, so a rerun polls that request instead of paying for a new one.

## Inspecting a clip

The video QA is a weak judge; it often scores camera moves and cuts as "inconsistent". Before you report a clip as bad:

```sh
F=projects/<slug>/renders/<clip-id>.mp4
ffprobe -v error -show_entries stream=codec_type,duration -of csv "$F"      # expect video + audio
ffmpeg -v error -y -i "$F" -vf "fps=1,scale=240:-1,tile=6x1" -frames:v 1 /tmp/sheet.jpg   # contact sheet; open it
ffmpeg -i "$F" -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"     # around -20..-14 dB mean is fine
```

Look for: the characters keep their look, the action happened, no melting limbs, no text. If the clip is fine, report the warning as a false alarm. If it is bad, make a variation with a new `--id` and a simpler prompt (fewer characters, one action).

## Upgrading to HD

Run the same prompt with `--hd` (it is a different key, so it is a new clip with a new keyframe). Do it only after the user approved the draft.
