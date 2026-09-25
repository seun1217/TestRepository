// 개발/테스트용 제공자. API 호출 없이 고정된 응답을 돌려준다 (docs/CONTRACT.md 3절).
const PLANTS = [
  {
    id: "p1",
    name_ko: "동백나무",
    name_sci: "Camellia japonica",
    name_en: "Japanese camellia",
    family_ko: "차나무과",
    confidence: 0.91,
    bbox: { x: 0.1, y: 0.15, w: 0.35, h: 0.5 },
    summary_ko: "겨울에서 이른 봄에 붉은 꽃이 피는 상록 활엽수입니다.",
    detail_ko:
      "잎은 두껍고 광택이 있으며 가장자리에 잔톱니가 있습니다. 꽃은 11월부터 이듬해 4월 사이에 피고, 꽃잎이 낱장으로 떨어지지 않고 통째로 떨어지는 것이 특징입니다.\n\n남해안과 제주도, 울릉도에 자생하며 순천만 국가정원에서는 산책로 곳곳에서 볼 수 있습니다. 씨앗에서 짠 동백기름은 예로부터 머릿기름과 식용으로 쓰였습니다.",
    tags: ["상록수", "겨울꽃", "남부수종"],
  },
  {
    id: "p2",
    name_ko: "수국",
    name_sci: "Hydrangea macrophylla",
    name_en: "Bigleaf hydrangea",
    family_ko: "수국과",
    confidence: 0.78,
    bbox: { x: 0.55, y: 0.3, w: 0.35, h: 0.45 },
    summary_ko: "초여름에 공 모양의 큰 꽃송이가 피는 낙엽 관목입니다.",
    detail_ko:
      "6월에서 7월 사이에 피는 꽃송이는 실제로는 장식꽃이 모인 것이며, 토양의 산도에 따라 푸른색 또는 분홍색으로 색이 달라집니다.\n\n습기가 많고 반그늘인 곳을 좋아하며, 정원에서는 물가나 나무 아래에 많이 심습니다.",
    tags: ["낙엽관목", "여름꽃"],
  },
];

export default async function identify({ debug } = {}) {
  if (debug && ["too_dark", "too_far", "blurry", "no_plant"].includes(debug)) {
    return { quality: debug, message_ko: null, plants: [], model: "mock", usage: { input_tokens: 0, output_tokens: 0 } };
  }
  return {
    quality: "ok",
    message_ko: null,
    plants: PLANTS.map((p) => ({ ...p, bbox: { ...p.bbox }, tags: [...p.tags] })),
    model: "mock",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
