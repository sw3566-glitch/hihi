// Vercel Serverless Function: /api/analyze-price
// 브라우저에서 받은 가격표 이미지(base64)를 Google Gemini API(무료 티어)로 보내
// 상품명 / 품목 카테고리 / 용량·단위 / 구성개수 / 정상가·회원가 / 행사문구 / 배송비를 추출해 JSON으로 돌려준다.
// 실제 단위 환산과 가격 계산은 여기서 하지 않는다 (프론트엔드에서 처리).
//
// 보안: GEMINI_API_KEY는 Vercel 프로젝트의 서버 환경변수에만 존재하며
// 브라우저나 응답 본문에 절대 포함되지 않는다. (같은 배포/도메인에서 실행되므로 CORS 설정도 불필요)
//
// 비용: Google AI Studio에서 발급받는 Gemini API 키는 무료 티어가 있다 (신용카드 등록 불필요).
// 단, Flash 계열 모델만 무료이고 분당/일일 요청 수 제한이 있다. 모델명은 종종 바뀌므로
// 필요하면 Vercel 환경변수 GEMINI_MODEL로 다른 모델(예: gemini-2.5-flash-lite)을 지정할 수 있다.
// 최신 무료 티어 모델/한도는 https://ai.google.dev/gemini-api/docs/models 에서 확인.
//
// 주의: Vercel Node.js 서버리스 함수는 요청 본문 전체가 약 4.5MB로 제한된다.
// 이미지 4장을 base64로 보내면 금방 넘기 때문에, 프론트엔드(src/main.js)에서
// 전송 전 캔버스로 리사이즈/재압축을 거친다. 이 파일의 크기 상한은 그 이후의 2차 방어선이다.

const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64_LEN = 3_000_000;
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Gemini의 구조화 출력(responseSchema)은 OpenAPI 서브셋을 사용한다 (타입은 대문자, nullable은 별도 플래그).
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: '상품명' },
          category: {
            type: 'STRING',
            enum: ['liquid', 'weight', 'count', 'length', 'sheet', 'unknown'],
            description:
              '이 상품의 실제 비교 기준이 되는 품목 카테고리. ' +
              'liquid=액체(우유/음료/세제/샴푸/화장품, 100ml 기준), ' +
              'weight=중량(쌀/과자/가루세제, 100g 기준), ' +
              'count=개수(계란/라면/즉석밥처럼 낱개 수량이 기준, 1개 기준), ' +
              'length=길이(두루마리 휴지/랩/호일처럼 롤·길이가 기준, 1m 기준), ' +
              'sheet=매수(물티슈/각티슈처럼 장 수가 기준, 1매 기준), ' +
              'unknown=위 다섯 중 무엇에도 해당 안 되거나 판단 불가.',
          },
          amount: {
            type: 'NUMBER',
            description:
              '카테고리별 낱개(포장 1개) 기준 수치. liquid/weight: 낱개 용량(예: 500ml면 500, 2L면 2). ' +
              'length: 롤 1개의 길이(예: 30m면 30). sheet: 팩 1개의 매수(예: 80매면 80). ' +
              'count: 의미 없으므로 1을 넣는다. 묶음 구성이 서로 다른 용량을 섞어 파는 경우 ' +
              '(예: 50ml 2개 + 20ml 1개) 가장 흔하거나 큰 대표 용량으로 최선 추정한다.',
          },
          amountUnit: {
            type: 'STRING',
            enum: ['ml', 'l', 'g', 'kg', 'm', 'cm', '매', '개', ''],
            description:
              'amount의 단위. liquid는 ml 또는 l, weight는 g 또는 kg, length는 m 또는 cm, sheet는 매, count는 개. unknown이면 빈 문자열.',
          },
          packQty: {
            type: 'NUMBER',
            description:
              '이 가격에 포함된 원래 판매 단위의 구성 개수(묶음). 예: "500ml 3개"면 3, 휴지 "30m 30롤"이면 30, ' +
              '계란 한 판(30개)이면 30, 낱개/단일 포장이면 1. amount가 대표 용량으로 추정된 경우 ' +
              '그 대표 용량 기준 개수로 최선 추정한다. ' +
              '중요: 상품명이나 옵션에 "1+1", "2+1", "3개 SET", "N개입"처럼 적혀 있고 표시된 가격이 ' +
              '이미 그 전체 개수에 대한 총액이면(예: "1.7L 1+1" 16,900원 = 1.7L 두 병 합쳐 16,900원), ' +
              '그 총 개수를 packQty에 넣고 promo는 반드시 null로 남긴다 (아래 promo 설명 참고, 이중 계산 금지).',
          },
          priceRegular: {
            type: 'NUMBER',
            description:
              '일반 구매자가 실제로 결제하는 금액(원). "정상가/판매가/즉시할인가/쿠폰 적용가/최종 결제가"처럼 ' +
              '별도 멤버십 가입 없이 누구나 받을 수 있는 가격을 여기에 넣는다. 가격이 하나만 있으면 그 값. ' +
              '여러 판매처가 나열된 가격비교 페이지라면 대표로 보이는 가격 하나만 사용한다.',
          },
          priceMember: {
            type: 'NUMBER',
            nullable: true,
            description:
              '"멤버십가/회원 전용가/N+ 멤버십 적용가"처럼 별도 유료·무료 멤버십 가입이 있어야만 받을 수 있는 ' +
              '할인가가 정상가와 별도로 표시되어 있으면 그 값. 단순 쿠폰/즉시할인은 여기 넣지 말고 priceRegular에 반영. 없으면 null.',
          },
          promo: {
            type: 'STRING',
            nullable: true,
            description:
              '구매 시 이미 책정된 packQty·priceRegular에는 포함되지 않은, "추가로" 더 받는 무료 증정 문구 ' +
              '(예: 가격표에 "3,000원 (2+1)"처럼 붙어 있어서 2개 값만 내면 1개를 더 주는 진짜 사은 행사). ' +
              '중요: packQty에 이미 "1+1"류 구성을 반영했다면(위 packQty 설명 참고) 여기는 반드시 null. ' +
              '같은 "1+1" 문구를 packQty와 promo 양쪽에 동시에 반영하지 말 것 (가격이 절반으로 잘못 계산됨).',
          },
          memberOnlyPromo: {
            type: 'BOOLEAN',
            description: 'promo가 "회원 전용", "앱 회원", "멤버십 전용" 등 회원에게만 적용되는 조건이 붙어 있으면 true.',
          },
          shippingFee: {
            type: 'NUMBER',
            nullable: true,
            description:
              '화면에 표시된 배송비(원). "3,000원 (30,000원 이상 무료배송)"처럼 조건부 무료배송 문턱값 아래일 때 ' +
              '부과되는 기본 배송비 숫자가 보이면 그 값을 넣는다. "무료배송"이라고만 표시되어 있으면 0. ' +
              '배송비 관련 정보가 화면에 아예 안 보이면 null(추측하지 말 것).',
          },
        },
        required: ['name', 'category', 'amount', 'amountUnit', 'packQty', 'priceRegular', 'memberOnlyPromo'],
      },
    },
  },
  required: ['items'],
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY가 설정되지 않았습니다. Vercel 프로젝트 Settings > Environment Variables에서 설정하세요.');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }

  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  if (images.length < 1 || images.length > MAX_IMAGES) {
    res.status(400).json({ error: 'invalid_image_count' });
    return;
  }

  const imageParts = [];
  for (const img of images) {
    const mediaType = (img.mediaType || '').toLowerCase();
    const data = img.data || '';
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      res.status(400).json({ error: 'invalid_media_type' });
      return;
    }
    if (!data || data.length > MAX_IMAGE_BASE64_LEN) {
      res.status(400).json({ error: 'invalid_or_too_large_image' });
      return;
    }
    imageParts.push({ inline_data: { mime_type: mediaType, data } });
  }

  const promptText =
    '아래는 마트/쇼핑몰 가격표 또는 상품 정보 사진 ' + images.length + '장이야. ' +
    '사진에는 실물 가격표뿐 아니라 온라인 쇼핑몰 상품 상세페이지나 가격비교 페이지 스크린샷도 포함될 수 있어. ' +
    '각 사진에서 상품명, 품목 카테고리(liquid/weight/count/length/sheet/unknown), ' +
    '낱개 기준 수치(amount)와 단위(amountUnit), 구성 개수(packQty), ' +
    '정상가(priceRegular)와 회원가(priceMember, 멤버십 전용 할인가가 별도 표시된 경우만), ' +
    '행사 문구(promo)와 회원 전용 여부(memberOnlyPromo), 배송비(shippingFee, 표시된 경우만)를 읽어서 ' +
    '사진이 주어진 순서대로 items 배열을 채워줘. ' +
    '카테고리 판단이 애매하면 unknown으로 표시해. ' +
    '특히 주의: "1+1", "2+1", "N개입", "SET" 같은 문구가 상품명/옵션에 있고 표시된 가격이 이미 그 전체 수량의 ' +
    '총액이면, packQty에만 그 개수를 반영하고 promo는 null로 둬라. 같은 정보를 packQty와 promo에 중복 반영하면 ' +
    '가격이 실제보다 절반 등으로 잘못 계산되니 절대 하지 마라. ' +
    '값을 확신할 수 없으면 최선의 추정치를 채워라.';

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [...imageParts, { text: promptText }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.2,
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => '');
      console.error('Gemini API error', geminiRes.status, errText);
      // 무료 티어 분당/일일 한도 초과(429)를 사용자에게 구분해서 보여줄 수 있도록 별도 코드로 전달.
      const status = geminiRes.status === 429 ? 429 : 502;
      res.status(status).json({ error: status === 429 ? 'rate_limited' : 'upstream_error' });
      return;
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('예상치 못한 Gemini 응답 형태', JSON.stringify(data).slice(0, 500));
      res.status(502).json({ error: 'parse_failed' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('Gemini 응답 JSON 파싱 실패', text.slice(0, 500));
      res.status(502).json({ error: 'parse_failed' });
      return;
    }

    const items = parsed?.items;
    if (!Array.isArray(items) || items.length === 0) {
      console.error('items 배열이 비어있음', JSON.stringify(parsed).slice(0, 500));
      res.status(502).json({ error: 'parse_failed' });
      return;
    }

    res.status(200).json({ items });
  } catch (err) {
    console.error('analyze-price 처리 중 오류', err);
    res.status(500).json({ error: 'internal_error' });
  }
}
