const HISTORY_KEY = 'geuramgap:history';
const MAX_HISTORY = 50;

let captured = [];
let items = [];
let seq = 0;

const thumbs = document.getElementById('thumbs');
const fileInput = document.getElementById('fileInput');
const galleryInput = document.getElementById('galleryInput');
const btnCompare = document.getElementById('btnCompare');
const captureCount = document.getElementById('captureCount');
const loadingLabel = document.getElementById('loadingLabel');
const errorBanner = document.getElementById('errorBanner');

document.getElementById('btnCapture').addEventListener('click', () => fileInput.click());
document.getElementById('btnGallery').addEventListener('click', () => galleryInput.click());

function handleFilesAdded(e) {
  const files = Array.from(e.target.files || []).slice(0, 4 - captured.length);
  files.forEach(file => {
    if (captured.length >= 4) return;
    const id = 'p' + (seq++);
    const url = URL.createObjectURL(file);
    captured.push({ id, file, url });
    const div = document.createElement('div');
    div.className = 'thumb';
    div.id = 'thumb-' + id;
    div.innerHTML = '<img src="' + url + '" alt="촬영된 가격표"><div class="rm">×</div>';
    div.querySelector('.rm').addEventListener('click', () => {
      captured = captured.filter(c => c.id !== id);
      URL.revokeObjectURL(url);
      div.remove();
      updateCount();
    });
    thumbs.appendChild(div);
  });
  e.target.value = '';
  updateCount();
}

fileInput.addEventListener('change', handleFilesAdded);
galleryInput.addEventListener('change', handleFilesAdded);

function updateCount() {
  captureCount.textContent = '사진 ' + captured.length + '장 · 최소 2장 필요';
  btnCompare.disabled = captured.length < 2;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

// 이미지를 같은 배포(Vercel)의 서버리스 함수 /api/analyze-price 로 전달한다.
// Anthropic API 키는 서버 환경변수에만 존재하며 브라우저로 절대 전달되지 않는다.
// 같은 도메인에서 호출하므로 별도 CORS 설정이 필요 없다.
async function extractItemsFromImages(entries) {
  const images = await Promise.all(entries.map(async e => ({
    mediaType: e.file.type || 'image/jpeg',
    data: await fileToBase64(e.file)
  })));

  let res;
  try {
    res = await fetch('/api/analyze-price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images })
    });
  } catch (e) {
    throw new Error('network'); // 요청 자체가 도달하지 못한 경우 (오프라인 등)
  }

  if (!res.ok) {
    throw new Error('server'); // 함수는 응답했지만 오류 (키 누락, 파싱 실패 등)
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('server');
  }
  return data.items;
}

function fallbackItems(count) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({ name: '상품 ' + (i + 1), price: 0, volume: 0, unit: 'ml', packQty: 1, promo: null });
  }
  return arr;
}

btnCompare.addEventListener('click', async () => {
  showScreen('screen-loading');
  loadingLabel.textContent = '가격표 인식 중';
  errorBanner.style.display = 'none';

  let extracted;
  let failed = false;
  let failReason = 'server';
  try {
    extracted = await extractItemsFromImages(captured);
  } catch (err) {
    failed = true;
    failReason = err && err.message === 'network' ? 'network' : 'server';
    extracted = fallbackItems(captured.length);
  }

  loadingLabel.textContent = '단가 계산 중';
  await new Promise(r => setTimeout(r, 300));

  items = extracted.map((p, i) => ({
    id: 'item' + i,
    name: (p.name || ('상품 ' + (i + 1))).toString(),
    rawVolume: Number(p.volume) || 0,
    rawUnit: (p.unit || 'ml').toString().toLowerCase(),
    packQty: Number(p.packQty) > 0 ? Number(p.packQty) : 1,
    price: Number(p.price) || 0,
    promoText: p.promo || null
  }));

  if (failed) {
    errorBanner.textContent = failReason === 'network'
      ? '서버에 연결하지 못했어요. 인터넷 연결을 확인하고, 아래에서 상품명·가격·용량을 직접 입력해주세요.'
      : '자동 인식에 실패했어요. 아래에서 상품명·가격·용량을 직접 입력해주세요.';
    errorBanner.style.display = 'block';
  } else {
    errorBanner.style.display = 'none';
  }
  renderResults();
  showScreen('screen-results');
});

document.getElementById('btnRestart').addEventListener('click', () => {
  captured.forEach(c => URL.revokeObjectURL(c.url));
  captured = [];
  thumbs.innerHTML = '';
  updateCount();
  showScreen('screen-capture');
});

function normalize(item) {
  let unit = item.rawUnit;
  let perUnitVolume = item.rawVolume;
  let basis;
  if (unit === 'l' || unit === 'L') { perUnitVolume = item.rawVolume * 1000; basis = 'ml'; }
  else if (unit === 'ml') { basis = 'ml'; }
  else if (unit === 'kg') { perUnitVolume = item.rawVolume * 1000; basis = 'g'; }
  else if (unit === 'g') { basis = 'g'; }
  else { basis = 'count'; perUnitVolume = 1; }

  const packQty = item.packQty > 0 ? item.packQty : 1;
  const totalAmount = basis === 'count'
    ? (packQty > 1 ? packQty : (item.rawVolume > 0 ? item.rawVolume : 1))
    : (perUnitVolume > 0 ? perUnitVolume : 1) * packQty;

  let promoBuy = 1, promoFree = 0;
  if (item.promoText) {
    const m = String(item.promoText).match(/(\d+)\s*\+\s*(\d+)/);
    if (m) { promoBuy = parseInt(m[1], 10); promoFree = parseInt(m[2], 10); }
  }
  const factor = promoBuy / (promoBuy + promoFree);
  const baseUnit = basis === 'count' ? item.price / totalAmount : (item.price / totalAmount) * 100;
  const afterUnit = baseUnit * factor;
  return { ...item, basis, perUnitVolume, packQty, totalAmount, promoBuy, promoFree, factor, baseUnit, afterUnit };
}

function unitLabel(basis) {
  return basis === 'count' ? '원/개' : ('원/100' + basis);
}

function calcText(it) {
  const base = Math.round(it.baseUnit).toLocaleString();
  const lines = [];
  if (it.basis !== 'count' && it.packQty > 1) {
    lines.push(it.perUnitVolume.toLocaleString() + it.basis + ' × ' + it.packQty + '개 = ' + it.totalAmount.toLocaleString() + it.basis);
  }
  if (it.basis === 'count') {
    lines.push(it.price.toLocaleString() + '원 ÷ ' + it.totalAmount.toLocaleString() + '개 = ' + base + '원/개');
  } else {
    lines.push(it.price.toLocaleString() + '원 ÷ ' + it.totalAmount.toLocaleString() + it.basis + ' × 100 = ' + base + '원/100' + it.basis);
  }
  if (it.promoBuy > 0 && it.promoFree > 0) {
    lines.push('× ' + it.promoBuy + '/' + (it.promoBuy + it.promoFree) + ' 행사가 반영 = ' + Math.round(it.afterUnit).toLocaleString() + '원');
  }
  return lines.join('\n');
}

// 이력은 기기(브라우저) 로컬에만 저장한다 (서버로 전송하지 않음).
function saveHistory(enriched) {
  try {
    const entry = {
      date: new Date().toISOString(),
      winner: enriched[0].name,
      winnerPrice: Math.round(enriched[0].afterUnit),
      winnerUnit: unitLabel(enriched[0].basis),
      itemCount: enriched.length
    };
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  } catch (e) {
    console.error('history save failed', e);
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function renderResults() {
  const enriched = items.map(normalize).sort((a, b) => a.afterUnit - b.afterUnit);
  const worst = enriched[enriched.length - 1];
  const winner = enriched[0];
  const runnerUp = enriched.length > 1 ? enriched[1] : null;

  const list = document.getElementById('resultList');
  list.innerHTML = '';

  enriched.forEach((it, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card' + (idx === 0 ? ' winner' : '');
    const hasPromo = it.promoBuy > 0 && it.promoFree > 0;

    let saveLine = '';
    if (idx === 0 && runnerUp) {
      const pct = Math.round(((runnerUp.afterUnit - winner.afterUnit) / runnerUp.afterUnit) * 100);
      const savedDisplay = winner.basis === 'count'
        ? Math.round((worst.afterUnit - winner.afterUnit) * winner.totalAmount)
        : Math.round(((worst.afterUnit - winner.afterUnit) / 100) * winner.totalAmount);
      saveLine = '<div class="rc-save">' + escapeHtml(runnerUp.name) + '보다 약 ' + pct + '% 저렴 · 이 용량 기준 약 ' + savedDisplay.toLocaleString() + '원 절약</div>';
    }

    card.innerHTML = `
      <div class="rc-top">
        <div>
          <div class="rc-rank">${idx + 1}위</div>
          <div class="rc-name">${escapeHtml(it.name)}</div>
          <div class="rc-vol">${it.basis === 'count' ? it.totalAmount.toLocaleString() + '개' : it.totalAmount.toLocaleString() + it.basis + (it.packQty > 1 ? ' (' + it.perUnitVolume.toLocaleString() + it.basis + ' × ' + it.packQty + '개)' : '')} · ${hasPromo ? escapeHtml(it.promoText) : '행사 없음'}</div>
        </div>
        <div class="rc-price">
          ${hasPromo ? '<span class="rc-before">' + Math.round(it.baseUnit).toLocaleString() + '원</span>' : ''}
          <div><span class="num">${Math.round(it.afterUnit).toLocaleString()}</span><span class="unit">${unitLabel(it.basis)}</span></div>
        </div>
      </div>
      ${saveLine}
      <div class="rc-actions">
        <span class="rc-toggle" data-act="calc" data-id="${it.id}">계산 과정 보기</span>
        <span class="rc-toggle" data-act="edit" data-id="${it.id}">값 수정하기</span>
      </div>
      <pre class="rc-calc" id="calc-${it.id}">${calcText(it)}</pre>
      <div class="edit-row" id="edit-${it.id}">
        <div class="edit-field">
          <label>상품명</label>
          <input type="text" data-field="name" data-id="${it.id}" value="${escapeAttr(it.name)}">
        </div>
        <div class="edit-field">
          <label>가격(원)</label>
          <input type="number" data-field="price" data-id="${it.id}" value="${it.price}">
        </div>
        <div class="edit-field">
          <label>낱개 용량</label>
          <input type="number" data-field="rawVolume" data-id="${it.id}" value="${it.rawVolume}">
        </div>
        <div class="edit-field">
          <label>단위</label>
          <select data-field="rawUnit" data-id="${it.id}">
            <option value="ml" ${it.rawUnit === 'ml' ? 'selected' : ''}>ml</option>
            <option value="l" ${it.rawUnit === 'l' ? 'selected' : ''}>L</option>
            <option value="g" ${it.rawUnit === 'g' ? 'selected' : ''}>g</option>
            <option value="kg" ${it.rawUnit === 'kg' ? 'selected' : ''}>kg</option>
            <option value="개" ${it.rawUnit === '개' ? 'selected' : ''}>개</option>
          </select>
        </div>
        <div class="edit-field">
          <label>구성 개수(묶음)</label>
          <input type="number" data-field="packQty" data-id="${it.id}" value="${it.packQty}" min="1">
        </div>
        <div class="edit-field">
          <label>행사(예: 2+1)</label>
          <input type="text" data-field="promoText" data-id="${it.id}" value="${escapeAttr(it.promoText || '')}">
        </div>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.rc-toggle').forEach(t => {
    t.addEventListener('click', () => {
      const targetId = (t.dataset.act === 'calc' ? 'calc-' : 'edit-') + t.dataset.id;
      const el = document.getElementById(targetId);
      const showing = el.style.display === 'block' || el.style.display === 'flex';
      el.style.display = showing ? 'none' : (t.dataset.act === 'calc' ? 'block' : 'flex');
    });
  });

  list.querySelectorAll('input[data-field], select[data-field]').forEach(inp => {
    inp.addEventListener('change', () => {
      const item = items.find(i => i.id === inp.dataset.id);
      const field = inp.dataset.field;
      if (field === 'price' || field === 'rawVolume' || field === 'packQty') {
        const val = parseFloat(inp.value);
        item[field] = isNaN(val) ? (field === 'packQty' ? 1 : 0) : val;
      } else if (field === 'promoText') {
        item[field] = inp.value.trim() || null;
      } else {
        item[field] = inp.value;
      }
      renderResults();
    });
  });

  saveHistory(enriched);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

document.getElementById('btnHistory').addEventListener('click', () => {
  const list = document.getElementById('historyList');
  showScreen('screen-history');

  const entries = loadHistory();
  if (entries.length === 0) {
    list.innerHTML = '<p class="empty-state">아직 비교 이력이 없어요.</p>';
    return;
  }
  list.innerHTML = '';
  entries.forEach(e => {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const d = new Date(e.date);
    row.innerHTML = `
      <div>
        <div class="hist-name">${escapeHtml(e.winner)}</div>
        <div class="hist-date">${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} · 상품 ${e.itemCount}개 비교</div>
      </div>
      <div class="hist-price">${e.winnerPrice.toLocaleString()}${e.winnerUnit}</div>
    `;
    list.appendChild(row);
  });
});

document.getElementById('btnHistoryBack').addEventListener('click', () => showScreen('screen-capture'));

updateCount();
