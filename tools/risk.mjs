// พอร์ตจาก genhaha/app/lib/promptRisk.ts — เตือนเท่านั้น เดาด้วยคำ ไม่ใช่ตัวกรองจริง
const RULES = [
  {
    id: "ip",
    words: [
      "doraemon", "ドラえもん", "โดราเอมอน", "nobita", "โนบิตะ",
      "pokemon", "pokémon", "pikachu", "โปเกมอน", "ปิกาจู", "eevee", "charizard",
      "naruto", "นารูโตะ", "sasuke", "uzumaki", "hokage",
      "one piece", "วันพีซ", "monkey d. luffy", "roronoa", "zoro",
      "dragon ball", "ดราก้อนบอล", "son goku", "super saiyan",
      "sailor moon", "attack on titan", "shingeki no kyojin", "eren yeager", "levi ackerman",
      "demon slayer", "kimetsu no yaiba", "tanjiro", "nezuko", "ดาบพิฆาตอสูร",
      "jujutsu kaisen", "gojo satoru", "itadori", "chainsaw man", "denji",
      "spy x family", "anya forger", "my hero academia", "midoriya", "all might",
      "hunter x hunter", "evangelion", "asuka langley", "rei ayanami",
      "gundam", "กันดั้ม", "shin-chan", "shinchan", "ชินจัง", "detective conan", "โคนัน",
      "digimon", "yu-gi-oh", "death note", "light yagami", "one punch man", "saitama hero",
      "jojo's bizarre", "haikyuu", "slam dunk anime", "doraemon",
      "studio ghibli", "ghibli", "จิบลิ", "totoro", "spirited away", "no-face ghibli",
      "howl's moving castle", "kiki's delivery", "princess mononoke", "ponyo",
      "sanrio", "hello kitty", "ฮัลโหลคิตตี้", "cinnamoroll", "kuromi", "my melody",
      "labubu", "ลาบูบู้",
      "garfield", "การ์ฟิลด์", "snoopy", "สนูปปี้", "charlie brown",
      "disney", "ดิสนีย์", "pixar", "mickey mouse", "minnie mouse", "donald duck",
      "elsa frozen", "frozen ii", "olaf frozen", "moana", "encanto", "the lion king",
      "toy story", "buzz lightyear", "shrek", "minions", "despicable me",
      "spongebob", "patrick star", "tom and jerry", "looney tunes", "bugs bunny",
      "scooby-doo", "peppa pig", "paw patrol", "barbie doll", "hello barbie",
      "marvel", "มาร์เวล", "avengers", "spider-man", "spiderman", "iron man",
      "captain america", "the hulk", "black panther marvel", "deadpool", "wolverine",
      "x-men", "dc comics", "batman", "superman", "wonder woman", "harley quinn",
      "star wars", "darth vader", "yoda", "grogu", "stormtrooper", "jedi", "lightsaber",
      "harry potter", "hogwarts", "hermione", "voldemort", "dumbledore",
      "lord of the rings", "gandalf", "hobbit", "game of thrones", "stranger things",
      "squid game", "สควิดเกม",
      "minecraft", "roblox", "fortnite", "super mario", "luigi nintendo", "nintendo",
      "the legend of zelda", "sonic the hedgehog", "pac-man", "angry birds",
      "league of legends", "genshin impact", "valorant agent",
      "coca-cola", "coca cola", "pepsi", "nike swoosh", "just do it slogan", "adidas",
      "iphone", "macbook", "samsung galaxy", "louis vuitton", "gucci", "chanel",
      "rolex", "ferrari", "lamborghini", "mcdonald", "starbucks", "kfc",
      "7-eleven", "เซเว่นอีเลฟเว่น", "netflix logo", "tiktok logo", "lego brick",
    ],
  },
  {
    id: "royal",
    words: [
      "ในหลวง", "พระมหากษัตริย์", "พระราชินี", "ราชวงศ์", "พระบรมฉายาลักษณ์",
      "thai king", "thai queen", "thai royal family",
    ],
  },
  {
    id: "realPerson",
    words: [
      "celebrity", "famous actor", "famous actress", "famous singer",
      "k-pop idol", "ดารา", "นักร้องชื่อดัง", "คนดัง", "ไอดอลเกาหลี", "นักการเมือง",
      "donald trump", "joe biden", "barack obama", "vladimir putin", "kim jong",
      "xi jinping", "the pope", "โดนัลด์ ทรัมป์", "ปูติน",
      "elon musk", "jeff bezos", "mark zuckerberg", "bill gates", "steve jobs",
      "taylor swift", "beyonce", "rihanna", "ariana grande", "billie eilish",
      "blackpink", "bts jungkook", "bts jimin", "newjeans",
      "cristiano ronaldo", "lionel messi", "lebron james",
      "keanu reeves", "tom cruise", "brad pitt", "leonardo dicaprio",
      "scarlett johansson", "emma watson", "johnny depp", "will smith",
    ],
  },
  {
    id: "childHorror",
    words: [
      "child", "children", "kid ", "kids ", "toddler", "infant ", "schoolgirl",
      "schoolboy", "kindergarten", "เด็ก", "หนูน้อย", "ทารก", "อนุบาล",
    ],
    alsoNeeds: [
      "horror", "creepy", "haunted", "nightmare", "bloody", "scream", "cursed",
      "possessed", "demonic", "sinister", "disturbing", "unsettling",
      "สยอง", "หลอน", "น่ากลัว", "เลือดสาด", "กรีดร้อง", "ผีสิง",
    ],
  },
  {
    id: "violence",
    words: [
      "bloody", "blood splatter", "blood pouring", "decapitat", "beheading",
      "mutilat", "torture", "stabbing", "gunshot wound", "mass shooting",
      "school shooting", "suicide", "self-harm", "hanging body", "corpse", "dead body",
      "public execution", "war crime", "genocide", "terrorist", "suicide bomb",
      "bomb attack", "massacre", "slaughter",
      "เลือดสาด", "ทรมาน", "ฆ่าตัวตาย", "ฆ่าคน", "สังหาร", "กองศพ", "ตัดหัว",
      "ก่อการร้าย", "ระเบิดฆ่าตัวตาย", "ทำร้ายตัวเอง",
    ],
  },
  {
    id: "retroDrama",
    words: [
      "ละครไทยยุค", "ละครโทรทัศน์", "ฟีลละคร", "ละครไทย",
      "ยุค 80", "ยุค80", "ยุค 90", "ยุค90", "80–90", "80-90",
      "vhs",
    ],
  },
  {
    id: "voyeur",
    words: [
      "voyeur", "voyeuristic", "peeping", "peeping tom", "hidden camera",
      "spy camera", "surveillance footage", "secretly filming", "upskirt",
      "แอบมอง", "แอบถ่าย", "ลอบมอง", "กล้องแอบ",
    ],
  },
  {
    id: "sexual",
    words: [
      "nude", "nudity", "naked", "topless", "lingerie", "underwear only",
      "seductive", "erotic", "sexy pose", "provocative pose", "undressing",
      "strip club", "stripper", "porn", "nsfw", "hentai", "ecchi", "fanservice",
      "cleavage", "wet t-shirt", "bikini pose",
      "โป๊", "เปลือย", "ยั่วยวน", "ชุดชั้นใน", "อนาจาร", "หวิว",
    ],
  },
];
const NEGATION_MARKERS = [
  "no ", "not ", "without ", "avoid", "never ", "free of ", "zero ",
  "ไม่มี", "ไม่ใส่", "ไม่ต้อง", "ไม่เอา", "ห้าม", "งด", "เลี่ยง", "ปราศจาก",
  "negative:", "negative prompt:", "avoid:", "exclude:", "ห้ามมี:", "ไม่เอา:",
];
const CLAUSE_BREAK = /[.!?;|\n·—]/;
const NEGATION_LOOKBACK_MAX = 200;
function negatedEverywhere(text, word) {
  let at = text.indexOf(word);
  if (at === -1) return false;
  while (at !== -1) {
    let start = at;
    while (
      start > 0 &&
      at - start < NEGATION_LOOKBACK_MAX &&
      !CLAUSE_BREAK.test(text[start - 1])
    ) {
      start--;
    }
    const clause = text.slice(start, at);
    if (!NEGATION_MARKERS.some((marker) => clause.includes(marker))) return false;
    at = text.indexOf(word, at + word.length);
  }
  return true;
}
export function riskFindings(prompt) {
  const text = prompt.toLowerCase();
  if (text.trim() === "") return [];
  const findings = [];
  for (const rule of RULES) {
    const hit = rule.words.find((w) => {
      if (!text.includes(w)) return false;
      return !negatedEverywhere(text, w);
    });
    if (hit === undefined) continue;
    if (
      rule.alsoNeeds &&
      !rule.alsoNeeds.some((w) => text.includes(w) && !negatedEverywhere(text, w))
    ) {
      continue;
    }
    findings.push({ id: rule.id, matched: hit.trim() });
  }
  return findings;
}
