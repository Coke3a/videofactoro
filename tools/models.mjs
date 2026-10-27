export const MODELS = {
  image: "@cf/black-forest-labs/flux-2-klein-9b",
  // keyframe/ภาพนิ่งของ clip/film/motion: ถูกกว่า 9b ราว 10 เท่า ตัวละครยังเหมือน ref แต่ทำตามท่าทางใน prompt ได้น้อยกว่า
  imageFast: "@cf/black-forest-labs/flux-2-klein-4b",
  video: "black-forest-labs/flux-3-video",
  qa: "@cf/cloudflare/clef-omni",
  llm: ["google/gemini-3.8-flash", "anthropic/claude-haiku-5.5"],
  tts: "google/gemini-3.8-flash-tts",
  asr: "@cf/openai/whisper-large-v3-turbo",
  music: "elevenlabs/music-v2",
  rmbg: "bria/remove-background",
};
