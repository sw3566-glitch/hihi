const HISTORY_KEY = 'geuramgap:history';
const MEMBER_KEY = 'geuramgap:isMember';
const MEMBER_ASKED_KEY = 'geuramgap:memberAsked';
const MAX_HISTORY = 50;

let captured = [];
let items = [];
let seq = 0;
let isMember = localStorage.getItem(MEMBER_KEY) === 'yes';

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

// 첫 실행 시 한 번만 "회원이신가요?"를 물어보고 localStorage에 저장한다.
// 이후에는 결과 화면 상단의 기준 전환 칩으로 언제든 바꿀 수 있다.
function ensureMembershipAsked() {
  if (localStorage.getItem(MEMBER_ASKED_KEY) === 'yes') return;
  const answer = window.confirm('마트/쇼핑몰 멤버십 회원이신가요?\n(회원가가 표시된 가격표라면 회원가 기준으로 비교해드려요. 나중에 결과 화면에서 언제든 바꿀 수 있어요.)');
  isMember = !!answer;
  localStorage.setItem(MEMBER_KEY, isMember ? 'yes' : 'no');
  localStorage.setItem(MEMBER_ASKED_KEY, 'yes');
}

// 이미지를 같은 배포(Vercel)의 서버리스 함수 /api/analyze-price 로 전달한다.
// Anthropic API 키는 서버 환경변수에만 존재하며 브라우저로 절대 전달되지 않는다.
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
    throw new Error('network');
  }

  if (!res.ok) throw new Error('server');
  const data = await res.json();
  if (!data || !Array.isArray(data.items) || data.items.length === 0) throw new Error('server');
  return data.items;
}

const VALID_CATEGORIES = ['liquid', 'weight', 'count', 'length', 'sheet', 'unknown'];

function fallbackItems(count) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({ name: '상품 ' + (i + 1), category: 'unknown', amount: 1, amountUnit: '', packQty: 1, priceRegular: 0, priceMember: null, promo: null, memberOnlyPromo: false });
  }
  return arr;
}

btnCompare.addEventListener('click', async () => {
  ensureMembershipAsked();
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
    category: VALID_CATEGORIES.includes(p.category) ? p.category : 'unknown',
    amount: Number(p.amount) > 0 ? Number(p.amount) : 1,
    amountUnit: (p.amountUnit || '').toString().toLowerCase(),
    packQty: Number(p.packQty) > 0 ? Number(p.packQty) : 1,
    priceRegular: Number(p.priceRegular) || 0,
    priceMember: (p.priceMember !== null && p.priceMember !== undefined && Number(p.priceMember) > 0) ? Number(p.priceMember) : null,
    promoText: p.promo || null,
    memberOnlyPromo: !!p.memberOnlyPromo
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

// 카테고리별 raw amount/amountUnit을 계산용 표준 단위로 환산한다.
// liquid -> ml, weight -> g, length -> m, sheet -> 매, count -> (amount는 쓰지 않음)
function canonicalize(category, amount, amountUnit) {
  switch (category) {
    case 'liquid':
      return amountUnit === 'l' ? { value: amount * 1000, unit: 'ml' } : { value: amount, unit: 'ml' };
    case 'weight':
      return amountUnit === 'kg' ? { value: amount * 1000, unit: 'g' } : { value: amount, unit: 'g' };
    case 'length':
      return amountUnit === 'cm' ? { value: amount / 100, unit: 'm' } : { value: amount, unit: 'm' };
    case 'sheet':
      return { value: amount, unit: '매' };
    case 'count':
      return { value: 1, unit: '개' };
    default:
      return { value: amount || 1, unit: amountUnit || '단위' };
  }
}

function unitLabel(category, canonicalUnit) {
  if (category === 'liquid') return '원/100ml';
  if (category === 'weight') return '원/100g';
  if (category === 'count') return '원/개';
  if (category === 'length') return '원/m';
  if (category === 'sheet') return '원/매';
  return '원/' + (canonicalUnit || '단위');
}

function basisNote(category) {
  if (category === 'liquid') return '100ml 기준';
  if (category === 'weight') return '100g 기준';
  if (category === 'count') return '1개 기준';
  if (category === 'length') return '1m 기준';
  if (category === 'sheet') return '1매 기준';
  return '기준 미확정 · 값 수정 필요';
}

function normalize(item) {
  const canonical = canonicalize(item.category, item.amount, item.amountUnit);
  const packQty = item.packQty > 0 ? item.packQty : 1;

  let totalAmount;
  if (item.category === 'count') {
    totalAmount = packQty > 1 ? packQty : (item.amount > 0 ? item.amount : 1);
  } else {
    totalAmount = (canonical.value > 0 ? canonical.value : 1) * packQty;
  }

  const unitScale = (item.category === 'liquid' || item.category === 'weight') ? 100 : 1;

  const usingMember = isMember && item.priceMember != null;
  const basePrice = usingMember ? item.priceMember : item.priceRegular;
  const priceBasisLabel = usingMember ? '회원가' : '일반가';

  const promoActive = !!item.promoText && (!item.memberOnlyPromo || isMember);
  let promoBuy = 1, promoFree = 0;
  if (promoActive) {
    const m = String(item.promoText).match(/(\d+)\s*\+\s*(\d+)/);
    if (m) { promoBuy = parseInt(m[1], 10); promoFree = parseInt(m[2], 10); }
  }
  const factor = promoBuy / (promoBuy + promoFree);

  const baseUnit = (basePrice / totalAmount) * unitScale;
  const afterUnit = baseUnit * factor;

  // 길이(휴지 등)는 1m 기준 외에 1롤당 가격도 참고로 함께 계산
  const perRoll = item.category === 'length' ? (basePrice / packQty) * factor : null;

  return {
    ...item, canonical, packQty, totalAmount, unitScale,
    basePrice, priceBasisLabel, usingMember,
    promoActive, promoBuy, promoFree, factor,
    baseUnit, afterUnit, perRoll
  };
}

function calcText(it) {
  const base = Math.round(it.baseUnit).toLocaleString();
  const lines = [];
  lines.push('[' + it.priceBasisLabel + ' 적용] ' + it.basePrice.toLocaleString() + '원');
  if (it.category !== 'count' && it.packQty > 1) {
    lines.push(it.canonical.value.toLocaleString() + it.canonical.unit + ' × ' + it.packQty + '개 = ' + it.totalAmount.toLocaleString() + it.canonical.unit);
  }
  if (it.category === 'liquid' || it.category === 'weight') {
    lines.push(it.basePrice.toLocaleString() + '원 ÷ ' + it.totalAmount.toLocaleString() + it.canonical.unit + ' × 100 = ' + base + unitLabel(it.category));
  } else {
    lines.push(it.basePrice.toLocaleString() + '원 ÷ ' + it.totalAmount.toLocaleString() + (it.category === 'count' ? '개' : it.canonical.unit) + ' = ' + base + unitLabel(it.category));
  }
  if (it.promoActive && it.promoBuy > 0 && it.promoFree > 0) {
    lines.push('× ' + it.promoBuy + '/' + (it.promoBuy + it.promoFree) + ' 행사가 반영 = ' + Math.round(it.afterUnit).toLocaleString() + '원');
  } else if (it.promoText && it.memberOnlyPromo && !isMember) {
    lines.push('(회원 전용 행사 "' + it.promoText + '" · 비회원이라 미반영)');
  }
  if (it.category === 'length' && it.perRoll != null) {
    lines.push('참고: 1롤당 ' + Math.round(it.perRoll).toLocaleString() + '원');
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
      winnerUnit: unitLabel(enriched[0].category, enriched[0].canonical.unit),
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

  // 상단 기준 안내 + 회원가/일반가 전환 칩
  const subhead = document.getElementById('resultsSubhead');
  if (subhead) {
    const note = basisNote(winner.category);
    subhead.innerHTML =
      note + ' · 행사 반영 · ' +
      '<span class="member-toggle" id="memberToggle">' + (isMember ? '회원가' : '일반가') + ' 기준으로 보는 중 (탭하여 전환)</span>';
    const toggle = document.getElementById('memberToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        isMember = !isMember;
        localStorage.setItem(MEMBER_KEY, isMember ? 'yes' : 'no');
        renderResults();
      });
    }
  }

  const list = document.getElementById('resultList');
  list.innerHTML = '';

  enriched.forEach((it, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card' + (idx === 0 ? ' winner' : '');
    const hasPromo = it.promoActive && it.promoBuy > 0 && it.promoFree > 0;
    const promoLabel = it.promoText ? (it.promoText + (it.memberOnlyPromo ? ' (회원 전용)' : '')) : '행사 없음';

    let saveLine = '';
    if (idx === 0 && runnerUp) {
      const pct = Math.round(((runnerUp.afterUnit - winner.afterUnit) / runnerUp.afterUnit) * 100);
      const savedDisplay = it.category === 'count'
        ? Math.round((worst.afterUnit - winner.afterUnit) * winner.totalAmount)
        : Math.round(((worst.afterUnit - winner.afterUnit) / winner.unitScale) * winner.totalAmount);
      saveLine = '<div class="rc-save">' + escapeHtml(runnerUp.name) + '보다 약 ' + pct + '% 저렴 · 이 용량 기준 약 ' + savedDisplay.toLocaleString() + '원 절약</div>';
    }

    const volText = it.category === 'count'
      ? it.totalAmount.toLocaleString() + '개'
      : it.totalAmount.toLocaleString() + it.canonical.unit + (it.packQty > 1 ? ' (' + it.canonical.value.toLocaleString() + it.canonical.unit + ' × ' + it.packQty + '개)' : '');

    card.innerHTML = `
      <div class="rc-top">
        <div>
          <div class="rc-rank">${idx + 1}위 · ${it.priceBasisLabel}</div>
          <div class="rc-name">${escapeHtml(it.name)}</div>
          <div class="rc-vol">${volText} · ${escapeHtml(promoLabel)}</div>
        </div>
        <div class="rc-price">
          ${hasPromo ? '<span class="rc-before">' + Math.round(it.baseUnit).toLocaleString() + '원</span>' : ''}
          <div><span class="num">${Math.round(it.afterUnit).toLocaleString()}</span><span class="unit">${unitLabel(it.category, it.canonical.unit)}</span></div>
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
          <label>카테고리</label>
          <select data-field="category" data-id="${it.id}">
            <option value="liquid" ${it.category === 'liquid' ? 'selected' : ''}>액체(100ml)</option>
            <option value="weight" ${it.category === 'weight' ? 'selected' : ''}>중량(100g)</option>
            <option value="count" ${it.category === 'count' ? 'selected' : ''}>개수(1개)</option>
            <option value="length" ${it.category === 'length' ? 'selected' : ''}>길이(1m)</option>
            <option value="sheet" ${it.category === 'sheet' ? 'selected' : ''}>매수(1매)</option>
            <option value="unknown" ${it.category === 'unknown' ? 'selected' : ''}>미정</option>
          </select>
        </div>
        <div class="edit-field">
          <label>일반가(원)</label>
          <input type="number" data-field="priceRegular" data-id="${it.id}" value="${it.priceRegular}">
        </div>
        <div class="edit-field">
          <label>회원가(원, 없으면 비움)</label>
          <input type="number" data-field="priceMember" data-id="${it.id}" value="${it.priceMember != null ? it.priceMember : ''}">
        </div>
        <div class="edit-field">
          <label>낱개 수치</label>
          <input type="number" data-field="amount" data-id="${it.id}" value="${it.amount}">
        </div>
        <div class="edit-field">
          <label>단위</label>
          <select data-field="amountUnit" data-id="${it.id}">
            <option value="ml" ${it.amountUnit === 'ml' ? 'selected' : ''}>ml</option>
            <option value="l" ${it.amountUnit === 'l' ? 'selected' : ''}>L</option>
            <option value="g" ${it.amountUnit === 'g' ? 'selected' : ''}>g</option>
            <option value="kg" ${it.amountUnit === 'kg' ? 'selected' : ''}>kg</option>
            <option value="m" ${it.amountUnit === 'm' ? 'selected' : ''}>m</option>
            <option value="cm" ${it.amountUnit === 'cm' ? 'selected' : ''}>cm</option>
            <option value="매" ${it.amountUnit === '매' ? 'selected' : ''}>매</option>
            <option value="개" ${it.amountUnit === '개' ? 'selected' : ''}>개</option>
          </select>
        </div>
        <div class="edit-field">
          <label>구성 개수(묶음/롤)</label>
          <input type="number" data-field="packQty" data-id="${it.id}" value="${it.packQty}" min="1">
        </div>
        <div class="edit-field">
          <label>행사(예: 2+1)</label>
          <input type="text" data-field="promoText" data-id="${it.id}" value="${escapeAttr(it.promoText || '')}">
        </div>
        <div class="edit-field">
          <label>회원 전용 행사</label>
          <select data-field="memberOnlyPromo" data-id="${it.id}">
            <option value="false" ${!it.memberOnlyPromo ? 'selected' : ''}>아니오</option>
            <option value="true" ${it.memberOnlyPromo ? 'selected' : ''}>예</option>
          </select>
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
      if (field === 'priceRegular' || field === 'amount' || field === 'packQty') {
        const val = parseFloat(inp.value);
        item[field] = isNaN(val) ? (field === 'packQty' ? 1 : 0) : val;
      } else if (field === 'priceMember') {
        const val = parseFloat(inp.value);
        item.priceMember = (inp.value.trim() === '' || isNaN(val) || val <= 0) ? null : val;
      } else if (field === 'promoText') {
        item.promoText = inp.value.trim() || null;
      } else if (field === 'memberOnlyPromo') {
        item.memberOnlyPromo = inp.value === 'true';
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
