export const LOOK = "A small round orange tabby cat with white paws, a short curled tail, big green eyes, a red knitted scarf, and a tiny bell on the collar; always the same proportions.";
export const goodBible = () => ({
  title: "แมวกับหมา",
  logline: "แมวกับหมาอยู่บ้านเดียวกัน",
  premise: "สองเพื่อนต่างนิสัยปั่นป่วนครัว",
  world: "บ้านเล็กๆ ในเมืองริมคลอง",
  style_prompt: "soft watercolor storybook illustration, warm light",
  palette: ["#F4A261", "#2A9D8F", "#E9C46A"],
  visual_rules: ["ไม่มีตัวอักษรในภาพ"],
  narrator: true,
  narrator_voice: "Kore",
  tone: "อบอุ่น ขำๆ",
  music_style: "light acoustic",
  lang: "th",
  characters: [
    { id: "cat", name: "มะลิ", role: "ตัวเอก", look: LOOK, personality: "ซน", voice_description: "เสียงสูงใส", tts_voice: "Puck" },
    { id: "dog", name: "ถุงเท้า", role: "เพื่อนซี้", look: LOOK.replace("cat", "dog").replace("tabby", "beagle"), personality: "ซื่อ", voice_description: "เสียงทุ้ม", tts_voice: "Charon" },
  ],
  places: [{ id: "kitchen", name: "ครัว", desc: "A cozy small kitchen with wooden shelves and a round window" }],
  story_rules: ["ห้ามทะเลาะกันจริงจัง"],
});

