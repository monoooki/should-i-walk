import fs from "node:fs/promises";

const apiKey = process.env.WEATHERAPI_KEY;
if (!apiKey) {
  console.error("Missing WEATHERAPI_KEY");
  process.exit(1);
}

// 固定（要件）
const q = "mitaka-shi";

// sunrise/sunset が必要なので forecast
const url =
  `https://api.weatherapi.com/v1/forecast.json` +
  `?key=${encodeURIComponent(apiKey)}` +
  `&q=${encodeURIComponent(q)}` +
  `&days=1` +
  `&aqi=no` +
  `&alerts=no`;

const res = await fetch(url);
if (!res.ok) {
  throw new Error(`WeatherAPI failed: ${res.status} ${await res.text()}`);
}
const data = await res.json();

const location = data.location;
const current = data.current;
if (!data.forecast?.forecastday?.length) {
  throw new Error("WeatherAPI response missing forecast.forecastday data");
}
const astro = data.forecast.forecastday[0].astro;

const feels = Number(current.feelslike_c);
const wind = Number(current.wind_kph);
const precip = Number(current.precip_mm);
const humidity = Number(current.humidity);
const cond = String(current.condition?.text ?? "");

// localtime: "YYYY-MM-DD HH:mm"
const localtimeStr = String(location.localtime);
const [localDateStr, localTimeStr] = localtimeStr.split(" ");

function toMinutesHHMM(hhmm) {
  const [hh, mm] = hhmm.split(":").map((v) => Number(v));
  return hh * 60 + mm;
}

// "06:10 AM" -> 分
function toMinutesAmPm(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) throw new Error(`Invalid astro time: ${s}`);
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === "AM") {
    if (h === 12) h = 0;
  } else {
    if (h !== 12) h += 12;
  }
  return h * 60 + min;
}

const nowMin = toMinutesHHMM(localTimeStr);
const sunriseMin = toMinutesAmPm(astro.sunrise);
const sunsetMin = toMinutesAmPm(astro.sunset);

const isDaytime = nowMin >= sunriseMin && nowMin < sunsetMin;
const isRaining = precip > 0;

// ---- スコアリング（0〜100の百分率） ----
// - 雨 or 夜 => 0%（散歩NG）
// - それ以外は 100% から減点（一般的な快適さ）
const reasons = [];
let score = 100;

if (isRaining) {
  score = 0;
  reasons.push(`雨/降水あり（${precip}mm）`);
} else {
  reasons.push("雨なし");
}

if (!isDaytime) {
  score = 0;
  reasons.push(`夜間（${astro.sunrise}〜${astro.sunset}の範囲外）`);
} else {
  reasons.push(`日中（${astro.sunrise}〜${astro.sunset}）`);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

if (score > 0) {
  // 体感温度: ベスト 18〜24℃、許容 8〜30℃（最大50点減点）
  const bestLow = 18, bestHigh = 24;
  const okLow = 8, okHigh = 30;

  let tempPenalty = 0;
  if (feels < okLow || feels > okHigh) {
    tempPenalty = 50;
  } else if (feels < bestLow) {
    tempPenalty = ((bestLow - feels) / (bestLow - okLow)) * 25;
  } else if (feels > bestHigh) {
    tempPenalty = ((feels - bestHigh) / (okHigh - bestHigh)) * 25;
  }
  tempPenalty = clamp(tempPenalty, 0, 50);
  if (tempPenalty > 0) reasons.push(`体感温度による減点（-${tempPenalty.toFixed(0)}）`);

  // 風: 15kphまでは快適、30kphで厳しい（最大25点減点）
  let windPenalty = 0;
  if (wind >= 30) windPenalty = 25;
  else if (wind > 15) windPenalty = ((wind - 15) / (30 - 15)) * 25;
  windPenalty = clamp(windPenalty, 0, 25);
  if (windPenalty > 0) reasons.push(`風による減点（-${windPenalty.toFixed(0)}）`);

  // 湿度: 40〜60%が快適、80%以上は不快寄り（最大10点減点）
  let humidityPenalty = 0;
  if (humidity >= 80) humidityPenalty = 10;
  else if (humidity > 60) humidityPenalty = ((humidity - 60) / (80 - 60)) * 10;
  humidityPenalty = clamp(humidityPenalty, 0, 10);
  if (humidityPenalty > 0) reasons.push(`湿度による減点（-${humidityPenalty.toFixed(0)}）`);

  score = Math.round(clamp(100 - tempPenalty - windPenalty - humidityPenalty, 0, 100));
}

let walkability;
if (score === 0) walkability = "bad";
else if (score >= 70) walkability = "good";
else walkability = "caution";

const out = {
  query: q,
  location: location?.name
    ? `${location.name}, ${location.region}, ${location.country}`
    : q,
  localDate: localDateStr,
  localTime: localTimeStr,
  astro: { sunrise: astro.sunrise, sunset: astro.sunset },
  fetchedAt: new Date().toISOString(),
  walkabilityPercent: score,
  walkability,
  reasons,
  raw: {
    tempC: current.temp_c,
    feelslikeC: current.feelslike_c,
    condition: cond,
    windKph: wind,
    precipMm: precip,
    humidity,
  },
};

await fs.mkdir("data", { recursive: true });
await fs.writeFile("data/walkability.json", JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("Updated data/walkability.json");
