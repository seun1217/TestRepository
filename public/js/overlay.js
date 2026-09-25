// 툴팁 오버레이 렌더링. docs/CONTRACT.md 4절 overlay.js.
// 좌표 계산은 overlay-math.js에 맡기고 여기서는 DOM만 만든다.
import { computeCoverGeometry, mapBBox, anchorTooltip, resolveOverlaps, cropToVideoBBox } from "./overlay-math.js";

const TIP_MARGIN = 8;
const TIP_GAP = 4;

const px = (v) => `${v}px`;

function formatConfidence(confidence) {
  const n = Number(confidence);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "";
}

function makeBox(rect) {
  const box = document.createElement("div");
  box.className = "plant-box";
  box.style.left = px(rect.left);
  box.style.top = px(rect.top);
  box.style.width = px(rect.width);
  box.style.height = px(rect.height);
  return box;
}

function makeTip(plant, onSelect) {
  const tip = document.createElement("button");
  tip.type = "button";
  tip.className = "plant-tip";
  tip.tabIndex = 0;
  tip.dataset.plantId = String(plant.id ?? "");
  const conf = formatConfidence(plant.confidence);
  tip.setAttribute("aria-label", conf ? `${plant.name_ko}, 확신도 ${conf}, 상세 보기` : `${plant.name_ko} 상세 보기`);
  tip.append(document.createTextNode(String(plant.name_ko ?? "")));
  const confEl = document.createElement("span");
  confEl.className = "tip-conf";
  confEl.textContent = conf;
  tip.append(confEl);

  const select = () => {
    if (typeof onSelect === "function") onSelect(plant);
  };
  tip.addEventListener("click", select);
  // 네이티브 button은 Enter/Space에서 click을 또 내므로 preventDefault로 중복 호출을 막는다.
  tip.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.repeat) return;
    select();
  });
  return tip;
}

// 오버레이를 비우고 plants를 다시 그린다. 같은 입력이면 같은 결과가 나오므로 리사이즈 때 다시 불러도 된다.
// crop(captureFrame의 crop)이 있으면 bbox를 전체 프레임 기준으로 되돌린 뒤 화면 좌표로 옮긴다.
export function renderOverlay(container, plants, { videoEl, crop = null, onSelect } = {}) {
  container.replaceChildren();
  if (!Array.isArray(plants) || plants.length === 0) return;

  const elemW = container.clientWidth;
  const elemH = container.clientHeight;
  const videoW = videoEl?.videoWidth || crop?.videoW || elemW;
  const videoH = videoEl?.videoHeight || crop?.videoH || elemH;
  // 회전 등으로 스트림 크기가 캡처 때와 달라졌으면 옛 좌표는 맞지 않으므로 그리지 않는다 (스캐너가 곧 다시 인식한다).
  if (crop && crop.videoW > 0 && crop.videoH > 0 && (crop.videoW !== videoW || crop.videoH !== videoH)) return;
  const geometry = computeCoverGeometry({ videoW, videoH, elemW, elemH });

  const entries = plants.map((plant) => ({
    rect: mapBBox(cropToVideoBBox(plant.bbox, crop), geometry),
    tip: makeTip(plant, onSelect),
  }));

  // 박스를 먼저, 툴팁을 나중에 붙여 툴팁이 항상 테두리 위에 그려지게 한다.
  const frag = document.createDocumentFragment();
  for (const { rect } of entries) frag.append(makeBox(rect));
  for (const { tip } of entries) frag.append(tip);
  container.append(frag);

  // DOM에 붙인 뒤 실제 크기를 재서 위치를 정한다.
  const placements = entries.map(({ rect, tip }) => {
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const { left, top } = anchorTooltip(rect, { elemW, elemH, tipW, tipH, margin: TIP_MARGIN });
    return { left, top, width: tipW, height: tipH };
  });
  const resolved = resolveOverlaps(placements, { gap: TIP_GAP });
  entries.forEach(({ tip }, i) => {
    // 겹침 해소로 아래로 밀린 툴팁이 컨테이너 밖(overflow: hidden)으로 나가지 않게 한다. 겹치는 편이 안 보이는 것보다 낫다.
    const maxTop = Math.max(TIP_MARGIN, elemH - resolved[i].height - TIP_MARGIN);
    tip.style.left = px(resolved[i].left);
    tip.style.top = px(Math.min(resolved[i].top, maxTop));
  });
}

export function clearOverlay(container) {
  container.replaceChildren();
}
