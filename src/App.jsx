import React, { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://vdubgrxwijydwfabwpnk.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkdWJncnh3aWp5ZHdmYWJ3cG5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MDk1ODgsImV4cCI6MjA5NzE4NTU4OH0.nqNO3vany3M6fzmG5BG6QVdvi8BW2UbhTDhxNnwvA88";
const _sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const SKEY = (k) => `bipmaker::${k}`;

const bipStore = {
  async get(key) {
    try {
      const r = await _sb.from("shared_store").select("value").eq("key", SKEY(key)).maybeSingle();
      if (r.error) { return null; }
      if (!r.data) return null;
      let v = r.data.value;
      // 컬럼이 text든 jsonb든, 이중 직렬화된 레거시 값이든 안전하게 역직렬화
      for (let i = 0; i < 2 && typeof v === "string"; i++) {
        const s = v.trim();
        if (s === "") return null;
        if (s[0] === "{" || s[0] === "[" || s[0] === '"') {
          try { v = JSON.parse(s); } catch (e) { break; }
        } else { break; } // 순수 문자열(예: adminHash)은 그대로
      }
      return v;
    } catch (e) { return null; }
  },
  async set(key, value) {
    try {
      // 항상 JSON 문자열로 저장 → 컬럼 타입과 무관하게 get에서 복원 가능
      const payload = typeof value === "string" ? value : JSON.stringify(value);
      const r = await _sb.from("shared_store").upsert({ key: SKEY(key), value: payload, updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (r.error) { return null; }
      return { value };
    } catch (e) { return null; }
  },
};

// ── 한글 조사 자동 선택 (받침 유무 판별) ──────────
// 마지막 글자에 받침이 있으면 josa[0], 없으면 josa[1].
// 사용: `${name}${K(name,"은","는")}` → "김주현은" / "민다혜는"
function hasJongseong(str) {
  if (!str) return false;
  const ch = String(str).trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false; // 한글 음절 아님
  return (code - 0xac00) % 28 !== 0; // 받침 인덱스 0이면 받침 없음
}
function K(word, withJong, withoutJong) {
  return hasJongseong(word) ? withJong : withoutJong;
}

// 문서 표시용 이름: 성(첫 글자)을 떼고, 받침 있으면 '이'를 붙여 부드럽게.
// 김주현 → 주현이 / 이민수 → 민수 / (2글자 이하는 성 안 뗌)
// 안전장치: 빈값·공백은 '아동', 비한글(영문 등)은 원본 그대로.
function isHangulSyllable(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3;
}
function displayName(fullName) {
  const raw = (fullName || "").trim();
  if (!raw) return "아동";
  // 전부 한글 음절인 이름만 성 떼기 대상 (영문·숫자 섞이면 원본 유지)
  const allHangul = [...raw].every(isHangulSyllable);
  if (!allHangul) return raw;
  let given = raw.length >= 3 ? raw.slice(1) : raw; // 3글자 이상만 성 제거
  return hasJongseong(given) ? given + "이" : given;
}

// ── 외부 작성 링크: 토큰 인코딩/디코딩 ──────────────
// 토큰 안에 케이스 식별 정보를 담아 서버 없이 링크만으로 작동시킨다.
// { cid: 케이스id, cn: 아동이름, tg: 목표행동, sc: 척도id }
function encodeFillToken(obj) {
  const json = JSON.stringify(obj);
  // 한글 포함 문자열을 안전하게 base64로 (btoa는 latin1만 지원하므로 escape 처리)
  const b64 = btoa(unescape(encodeURIComponent(json)));
  // URL 안전 형태로 변환
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeFillToken(token) {
  try {
    let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  } catch (e) { return null; }
}

// ── 외부 제출 저장/조회 (shared_store 재사용) ────────
// 제출 1건 = bipmaker::submit::{케이스id}::{제출id}
async function saveExternalSubmission(caseId, submission) {
  const sid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const key = `submit::${caseId}::${sid}`;
  return await bipStore.set(key, { ...submission, sid, submittedAt: new Date().toISOString() });
}
async function listExternalSubmissions(caseId) {
  try {
    const prefix = SKEY(`submit::${caseId}::`);
    const r = await _sb.from("shared_store").select("key,value").like("key", `${prefix}%`);
    if (r.error || !r.data) return [];
    return r.data.map((row) => {
      let v = row.value;
      for (let i = 0; i < 2 && typeof v === "string"; i++) {
        const s = v.trim();
        if (s && (s[0] === "{" || s[0] === "[")) { try { v = JSON.parse(s); } catch (e) { break; } } else break;
      }
      return v;
    }).filter(Boolean);
  } catch (e) { return []; }
}
async function deleteExternalSubmission(caseId, sid) {
  try {
    const key = SKEY(`submit::${caseId}::${sid}`);
    await _sb.from("shared_store").delete().eq("key", key);
  } catch (e) { /* ignore */ }
}


/*
 * BIP Maker — 도전행동 평가·중재 앱 (검단ABA언어행동연구소)
 * 통합본 패턴 반영: 로고 · 저작권 · PBKDF2 인증 · 관리자 계정관리 · 선생님별 데이터 격리
 *
 * ※ 아티팩트 미리보기용: 저장은 앱 상태(메모리)로 처리.
 *   나중에 GitHub 배포 시 Supabase(vdubgrxwijydwfabwpnk)로 교체 예정.
 *   - 관리자: 모든 선생님 케이스 열람
 *   - 선생님: 관리자가 추가, 본인 케이스만 열람
 *   - AI: 기본 템플릿, 필요시에만 AI 보강 버튼(크레딧 절약)
 */

// ── 브랜드 팔레트 (통합본 기준) ─────────────────
const PK = "#F5A0B1", PKL = "#FFF0F3", PKD = "#D4728A";
const INK = "#3A2C30", MUTE = "#9A8A8F";
const COPYRIGHT = "© 검단ABA언어행동연구소 (민다혜). All rights reserved.";

const LOGO_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAADwCAMAAAAJixmgAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAAA/1BMVEWeW185L0bNanOuYGjacHUqJFR5aGsjGyI7Lkr63t7XmpkyKTxtFmTln6DgboI8MEvysbHMk5NBMk9cKy/IaW1ENFVAMlC3hoe6X3CumJn8gH7raGj8wb0AAP/0W6MAXwD/AP+pYpzytsL//6r/zMxVqlXbcIT//3+/Pz+/P3/bdIcAAAD3fHzxd4z7srBFNVb9hIc8PD33rKr///84LUQ5LUb/AAAtKDI+ME1VVVUwKDj/f3//qqo+ME06Lkc9MUsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7V20FAAAAQHRSTlMbXZ9W0BsLENv/nVQJ1OuNC2tcFmvgnUqTFvgF/wEDAgET/wMFA6ACBARPAP39/v3+BvsBcIwBFPEDLQID0bGvbavxgQAAC8pJREFUeNrtnAl32kgSgFvoBAQYY5zYzjmbmT0a0AkS4vr//2qrqlsHjp1kn1fymFQ9P4EMUvfXdXZLQsjfTAQDMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADXwrwppTfBPhLA/03MWlXy2+hYSHN5ViL5SfOxQPv5Dhcagnfy/2lAztSLBsiXlvFon0F95rAvddOhK03n8hxE3hpvjKxaP38Zxa9XFpyv7lk4EcWTXFrd9Em7Z5bNMYt+e/LBf4KSZhkXG2WS/81ddwy8F5bdDgqN+TGrxi42m15I2dKtf0+bP7oh+fEYrffiYsCFtqigRU2cQm8tHxQ/r7MWxcEvH8coyu5ocZ7f/0lOnZo0a5FOyXgeIx/DRn3eha96ThNtQosNjpGL+P+aDRCR35CTPnpUoAbVUcfJXwSuNfpDKpN4LOJ0qr/xzPuPL4YH96VVYdy4vGzwMmFAD+eKD0tYa/TqCXaVLBY/op0uyYgOglZlIV0GqpilWniP8ZCOhfiww2LHpszVWjUvO/pH/8xZbe8LQKLOmRZgOsLbKqOYmYihDaECwFuWLQvZ73FYmGBOt/Xs2JoWuw7nza11+CX2biy3pkV3i8WYWjK2RnwJU0Pv9bmKxIzXKCEYNu9SwWuJ0pjoFTAi4VZDcOlAZdTfwTOpKWBw8sF3jcCsig1fL8QF2vSSaPqMKXQCu5JaV0m8EZGVV0VWpG26dDcmBcbpaUwSxFXFbAUN/p/WdMc9ih3F7CmVYpZm/RrS2tR2jVvKuktyiht9W5uoHZ+EI12k414R1p/2z7sQ2FVyaIU2ukJ+XAW0AcfVijvkrs3DCwWNeYjCRfNa6ZOImLiXQ26WPp4DeDFfdggvpKDFRLHq9jpYKr4KsDwkZPM9Dd3TkzAsJkC/WUCL+qFrFLBKKMOJsevBWy5yl/vpIgr4NW79peouwfGmL0MF2opK0nkqOKNIWz949KAISndCGH2FlRa7pKGQWPYan9Fr2NgzEgqGYndbg8harBqSBdhq1tgtGQ5HQymWo/ijBeAR62n4o6BTekQYzyYXl1NB7HmrGXadtjqADiMawXPsIyMYyo04ooV31Ks7iBsdQDc7+O7fkzZV1cZcbyqmft9eAebTsJWB8ArBbwi4Lv4zIIV5Aq0TsAdhK3WgWE7wtdR+AwwWnhcG3bbYat94P7IahSUjvbVBu+Hfkyy6pO2W6622jfplfJhrLDCRSanFW710i9Fh639m/dhJSGlJSTGrDStSkoMWCjlJFG0atRd5OER4nzQ00JocjrFlQ23UUTXgbv1sNVN4XEfPi4thWhW0To162orS948cKPWWvZuTJo8bKbfxesuJomvMz0MsaiePmnSbYet11oAAGeeNsN1o85st9pqcZn2/sdLPBUwEA6uxNUgXnURtlq78uD+WMNmBUwapa5Ui3mxm7w54H19EfzJJS35rTZpU+6FI67kuzpsbfZvDVhIM/yBBwsw2ql23LJ63stRB2GrNZPePa9iuvJQAw8c5bFXyaBh5M5bA97sZlb4LO+nhoYHOkTVK9T1/94QMD4b3WteUKsurPVmeC0N8GgGvPoQi2RDK7ZO/EH78IfYeXMmTcTipmedSa+HV0ux0Ts5HWlRjz0IKUaVDJy2ZhCtXhB/us97X76itHsHwG63351JshOVsTqJlnqAanmjwH9DYWAGZmAGZuALB06S6lcMnL0SsWl+/Mtn2v4NgCOUqiNb2o0eV5BPiPN0weXD0fav4lei2/6ybbSsu9LszKOOvVDD578clFV7D9Icz9Q9SI4UPSXmrByHRA4G9b05ihVLywJP4H8s1VrQxs5wnNzPMvu+6x9LKpllLWo4G6bDYWpE0vVy6C3uwW4mD7nWk5841S/sJNIqp0SWfg56j8sYV/Ku7LRt3BoFdHoYTCRCUecjmQYpKP8Q5MExyvJjEaxhbNJbLSfCH956pxTHIz/hwBnXBsq1UeMPhy8Fxp6QpB9dL4hkkavdocwDbT90i/vYSXwNvEAFW3hb0k6NwWhVrV84cq0P/zIMsNfuKfAOgCongYGjcOvN17IIvGFwhN1DoAUGt+zJsTgegzkcUZQfwlfJRmy7CPLsxRou1iAHGHACHgb5Gke1kAevnAA46kGdfQlM5m+F6i4dodap3lEzDvYyHa6xXwjsZ3ngwRAaPgxEKqP02livjbQBbP+JHvwnugIemhmAB4gHbGKt5Bh45CLw/Ulw2kb/Dx9282B9OOQ5tnrQ/4MxSDM6/H24tJZLBx+YJODZw8NO3oT3pvyXUnBcrlpFwLWGV+ij5wEwKM3L3DW+Q+BSZ0Mv9zQwOtBwaAx9VPARwsI6mBRp1QkUQ/uGDWMIpvPzQC9+miiyQ3AcYk8QOM/8SAEHQSF9MOVlaJn6Ke9Kw7ichU5MCp4OaF1SAaP9HokLME9gyNIOcjeawAfY47VxMshvjuDSp8pqbcRRwGACCpgitBOtyRmg6SH4v3eyX6zhzIBQ4sqoIB8OcmzKNbI5aNjVDyeZ+OAGPhNLwKa6IZzupfwnKvhOaBVvQR2HAgOBAWoiYAjO4CvgpQhsgP5BYZkyafjEuL4+BJPrawN30KQRSpm0r1KSHXnBkOw4BfcoQA0T90XA9hGGGzoJZ/FIwxBkDnkwN+Z55cFjNzGVFxMwBel7awYuu8drwQO6+Ux5ceYFYK5IM1TA9nYLwHjKFC38mIHTuIHnoklTEPYCYwgvhdTx7pgZkzOTPuRIiKhHV7owHF7xIuA8OOlYvz6CNeP45vkpzQ45Rmml4P2VP14uIT8RMC1dQV6aJYIULL5dfa3WnrPJPDisXdsn4CNiktWgrdvQGIYwFzXsyeO8suhg7qF5nOZHtKoCorQsDC0Q5oYZRgM4wbUtjRwcOXpJHs6yVAuB21GUKR/O6F52+pkZekq2hzdOllGabPqbVnBDxSCfKXwRsBHkRnGEdx8JWBYnyLSuaxQuGvft7TXmWthMbg1ZOqcbIbAdNCUFx8ukY8wntszsl0Zpo8qGGQxzhrkf4laOwKRgi0qrJQbqPUXpBMDxjS8jzMEkq1LF0QHj7xaA1xB2PDpvodMS1Q6YmQ9GQaPqGka6TsvKwj16WWSrVOGvT8cTZOTgCC9lpMKA/eI8HMFpTqTgHIBRMwcqrg3DVgpe6tIKVUyPJ83Eg9ipMI13c+jbN9RVbh9U42VQBW8j28XCIz3drgt4o4BtiLmBNwe79qKP0TYth3rt4mBEkBe2Nhxpl+WFjWaiBsO3bRsSHGx9+8XA1/TO8zLaqyMGKVgXzz3wYkdWaWlGF4DBgwdalBcT8FONqEpLugdMpRjbbEr/E8O2DQMTIqTHKA+K84kF6GLrb7eOHJ5ZeCH9F2oYc/+w1HAOyQLEiDb4Iw7Vj45QoKa0BNJb3IMPlx5cefEegfOUjr+mzkdb0Bgm6DkBf4ZaI3MzSFwAnOVEjxHYQGDwW6jFoOVrW5cIBpZr9JWTV8sxe6mGax+O6hIWegh2Czn4AZebP32CQD0W9eQhtEjBIrki2d+t1G2jUV4H3oYeiklBCGDSuYeJ67OzxQIFdtDACSHzqp64JfBB/s+L+j8vLdPbCcptSlHFUHuT22IDWrV8R00DP+GOk5jWvbqkcoPzwvpBpB3tYL1tT1QNPDGe7Cvknvn8ZKjqIT158/nhVEYte6KOnaTlMNHEo5xwVlPuFlc8xKyxDOC4Z2sBCZ47qffETyzp77PEE50tLTQXGpLvriOVM/3k2dP65fHbZ1Y56Du6ZfqOUw6GHT1e5Ej8NoB/IM7muZ3vlnnka//qMK9aMjADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADMzADM3CL8l+bfVstzxxTAwAAAABJRU5ErkJggg==";

// ── PBKDF2 인증 (통합본과 동일) ─────────────────
const PBKDF2_ITER = 120000;
function _bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function _hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
async function hashPasswordSecure(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? _hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    keyMaterial, 256
  );
  const saltOut = saltHex || _bufToHex(salt.buffer);
  return `pbkdf2$${PBKDF2_ITER}$${saltOut}$${_bufToHex(bits)}`;
}
async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  if (typeof storedHash === "string" && storedHash.startsWith("pbkdf2$")) {
    const parts = storedHash.split("$");
    if (parts.length !== 4) return false;
    try {
      return (await hashPasswordSecure(password, parts[2])) === storedHash;
    } catch (e) { return false; }
  }
  return false;
}

const ADMIN_NAME = "민다혜";

// ══════════════════════════════════════════════
//  간접평가 척도 정의 (FAST · QABF · MAS)
//  각 척도: 문항 배열 + 기능(function) 매핑
// ══════════════════════════════════════════════

// ── FAST (16문항, 예/아니오/해당없음) ───────────
// 기능: 사회적정적강화(관심/선호물), 사회적부적강화(회피), 자동정적강화(감각), 자동부적강화(신체/통증)
const FAST = {
  id: "FAST",
  name: "FAST",
  fullName: "기능평가 선별검사 (Functional Analysis Screening Tool)",
  scale: "yn", // 예/아니오/해당없음
  functions: {
    social_pos: "사회적 정적강화 (관심·선호물)",
    social_neg: "사회적 부적강화 (회피·도피)",
    auto_pos: "자동 정적강화 (감각자극)",
    auto_neg: "자동 부적강화 (신체·통증)",
  },
  items: [
    { q: "대상자가 관심을 받지 않거나 보호자가 다른 사람에게 관심을 줄 때 문제행동이 발생하는가?", f: "social_pos" },
    { q: "선호하는 항목이나 활동에 대한 대상자의 요구가 거부되거나 이를 빼앗길 때 문제행동이 발생하는가?", f: "social_pos" },
    { q: "문제행동이 발생할 때, 보호자는 보통 대상자를 진정시키거나 선호하는 활동에 참여시키려 하는가?", f: "social_pos" },
    { q: "많은 관심을 받을 때 또는 좋아하는 활동을 자유롭게 이용할 수 있을 때 대상자는 보통 바르게 행동하는가?", f: "social_pos" },
    { q: "업무/학습활동을 수행하거나 활동에 참여하도록 요청받았을 때, 대상자는 주로 소란을 피우거나 저항하는가?", f: "social_neg" },
    { q: "업무/학습활동을 수행하거나 활동에 참여하도록 요청받았을 때 문제행동이 발생하는가?", f: "social_neg" },
    { q: "과제가 제시되고 있는 동안 문제행동이 일어난다면, 대상자는 대개 과제로부터 '쉬는 시간'을 가지게 되는가?", f: "social_neg" },
    { q: "아무것도 할 필요가 없을 때 대상자는 바르게 행동하는가?", f: "social_neg" },
    { q: "근처에 아무도 없거나 보고 있지 않아도 문제행동이 발생하는가?", f: "auto_pos" },
    { q: "여가활동이 가능한 경우에도 문제행동을 보이는가?", f: "auto_pos" },
    { q: "문제행동이 '자기 자극'의 한 형태로 나타나는가? (예: 손 흔들기, 빙글빙글 돌기 등)", f: "auto_pos" },
    { q: "감각자극 활동이 나타날 때 문제행동이 일어날 가능성이 적은가? (예: 클레이, 모래놀이 등)", f: "auto_pos" },
    { q: "문제행동은 며칠 동안 발생하다가 발생하지 않는 상황이 순환적으로 일어나는가?", f: "auto_neg" },
    { q: "귀 질환이나 알레르기와 같은 반복적인 고통스러운 질환을 가지고 있는가?", f: "auto_neg" },
    { q: "대상자가 아플 때 문제행동이 일어날 가능성이 더 높은가?", f: "auto_neg" },
    { q: "신체적인 문제를 경험하고 있고, 이런 문제가 치료된다면 문제행동은 대개 없어지는가?", f: "auto_neg" },
  ],
  // 원본 FAST 검사지 앞부분(문항 앞 사전 정보). 16문항 응답 전에 작성.
  preInfo: [
    { key: "behaviors", label: "문제 행동", type: "checkbox",
      options: ["공격성(Aggression)", "자해행동(Self-Injury)", "상동행동(Stereotypy)", "파괴행동(Property destruction)", "기타(Other)"],
      hint: "상동행동: 반복적으로 나오는 행동(예: 손톱 물기, 제자리 돌기, 이상한 소리내기 등) · 파괴행동: 책 찢기, 장난감·가구 등을 부수는 행동" },
    { key: "behaviorOther", label: "기타 문제행동 (직접 입력)", type: "text", placeholder: "위에서 '기타'를 선택한 경우 구체적으로 적어주세요" },
    { key: "frequency", label: "빈도(Frequency)", type: "radio",
      options: ["매시간 발생", "매일 발생", "매주 발생", "더 적게 발생"] },
    { key: "severity", label: "심각도(Severity)", type: "radio",
      options: ["경도 : 파괴적이지만 재산이나 건강에 대한 위험은 거의 없음", "중등도 : 재산 상 손해 또는 경미한 부상", "중도 : 보건이나 안전에 대한 중대한 위협"] },
    { key: "highDaysTimes", label: "발생 가능성이 가장 높은 상황 — 일/시간(Days/Times)", type: "text" },
    { key: "highSettings", label: "발생 가능성이 가장 높은 상황 — 상황/활동(Settings/Activities)", type: "text" },
    { key: "highPersons", label: "발생 가능성이 가장 높은 상황 — 특정인의 존재(Persons present)", type: "text" },
    { key: "lowDaysTimes", label: "발생 가능성이 가장 낮은 상황 — 일/시간(Days/Times)", type: "text" },
    { key: "lowSettings", label: "발생 가능성이 가장 낮은 상황 — 상황/활동(Settings/Activities)", type: "text" },
    { key: "lowPersons", label: "발생 가능성이 가장 낮은 상황 — 특정인의 존재(Persons present)", type: "text" },
    { key: "antecedent", label: "문제행동이 일어나기 직전에 보통 무슨 일이 일어나는가?", type: "textarea" },
    { key: "consequence", label: "문제행동이 발생한 직후에 보통 일어나는 일은?", type: "textarea" },
    { key: "treatment", label: "현재 치료를 받고 있습니까?", type: "textarea" },
  ],
};

// ── QABF (25문항, X/0~3점, 5기능 각 5문항) ──────
const QABF = {
  id: "QABF",
  name: "QABF",
  fullName: "행동기능 설문지 (Questions About Behavioral Functions)",
  scale: "q0123", // X 해당없음 / 0 전혀아님 / 1 가끔 / 2 종종 / 3 자주
  functions: {
    attention: "관심습득",
    escape: "회피",
    nonsocial: "비사회적 (자기자극)",
    physical: "신체적 (고통)",
    tangible: "강화물습득",
  },
  items: [
    { q: "관심을 끌기 위해 행동을 보인다.", f: "attention" },              // 1
    { q: "일하는 상황이나 학습상황에서 벗어나기 위해 행동을 보인다.", f: "escape" }, // 2
    { q: "'자기자극'의 형태로 행동을 보인다.", f: "nonsocial" },             // 3
    { q: "아픔을 느낄 때 행동을 보인다.", f: "physical" },                   // 4
    { q: "좋아하는 장난감, 음식, 음료수와 같이 어떤 물건을 가지기 위해서 행동을 보인다.", f: "tangible" }, // 5
    { q: "꾸중을 듣기를 즐겨하기 때문에 행동을 보인다.", f: "attention" },    // 6
    { q: "옷 입기, 이 닦기, 일하기 등 어떤 과제를 수행하라고 했을 때 행동을 보인다.", f: "escape" }, // 7
    { q: "방 안에 아무도 없어도 혼자서 행동을 보인다.", f: "nonsocial" },     // 8
    { q: "평가대상자가 아플 때 더 많이 행동을 보인다.", f: "physical" },      // 9
    { q: "평가대상자로부터 어떤 물건들을 제거하면 행동을 보인다.", f: "tangible" }, // 10
    { q: "자신에게 관심을 끌기 위해 행동을 보인다.", f: "attention" },        // 11
    { q: "특정 과제를 수행하기 싫어서 행동을 보인다.", f: "escape" },         // 12
    { q: "아무것도 할 것이 없을 때 행동을 보인다.", f: "nonsocial" },         // 13
    { q: "무엇인가 물리적/신체적으로 자신을 귀찮게 할 때 행동을 보인다.", f: "physical" }, // 14
    { q: "평가대상자가 원하는 물건을 당신이 가지고 있을 때 행동을 보인다.", f: "tangible" }, // 15
    { q: "평가대상자가 당신의 반응을 보고 싶어서 행동을 보인다.", f: "attention" }, // 16
    { q: "다른 사람들로부터 혼자 있고 싶어서 행동을 보인다.", f: "escape" },   // 17
    { q: "주변의 상황을 무시하며 심하게 반복행동을 보인다.", f: "nonsocial" }, // 18
    { q: "신체적으로 불편할 때 행동을 보인다.", f: "physical" },              // 19
    { q: "평가대상자가 원하는 물건을 또래가 가지고 있을 때 행동을 보인다.", f: "tangible" }, // 20
    { q: "행동을 보일 때면 '여기 와서 나를 봐' '나를 바라봐'라고 이야기하는 것 같다.", f: "attention" }, // 21
    { q: "행동을 보일 때면 '혼자 내버려둬' '무엇을 하라고 하지 마'라고 이야기하는 것 같다.", f: "escape" }, // 22
    { q: "혼자 있어도 그 행동을 즐기는 것 같다.", f: "nonsocial" },          // 23
    { q: "행동을 통해서 평가대상자가 아프다는 것을 말하는 것 같다.", f: "physical" }, // 24
    { q: "행동을 보일 때 장난감, 음식, 특정 물건을 달라고 말하는 것 같다.", f: "tangible" }, // 25
  ],
};

// ── MAS (16문항, 0~6점, 4기능 각 4문항) ─────────
const MAS = {
  id: "MAS",
  name: "MAS",
  fullName: "동기사정척도 (Motivation Assessment Scale)",
  scale: "s0to6", // 0 전혀아님 ~ 6 언제나
  functions: {
    sensory: "감각추구",
    escape: "회피",
    attention: "관심얻기",
    tangible: "획득",
  },
  // 표준 MAS(Durand & Crimmins) 순환 순서: 감각·회피·관심·획득 반복 (1~16번)
  items: [
    { q: "위의 행동은 오랜 시간 혼자 있을 때 나타납니까?", f: "sensory" },        // 1 감각
    { q: "위의 행동은 어려운 과업 수행을 요구받을 때 일어납니까?", f: "escape" },   // 2 회피
    { q: "위의 행동은 다른 사람들과 이야기하고 있을 때 일어납니까?", f: "attention" }, // 3 관심
    { q: "위의 행동은 가질 수 없다고 알고 있는 물건, 음식, 활동 등을 얻고자 할 때 일어납니까?", f: "tangible" }, // 4 획득
    { q: "주변에 아무도 없으면 아주 오랜 시간 동안 반복적으로 일어납니까?", f: "sensory" }, // 5 감각
    { q: "위의 행동은 어떤 요구를 할 때 일어납니까?", f: "escape" },              // 6 회피
    { q: "위의 행동은 대상자에게서 관심을 다른 데로 돌릴 때 일어납니까?", f: "attention" }, // 7 관심
    { q: "위의 행동은 좋아하는 음식, 활동, 물건 등을 제거했을 때 일어납니까?", f: "tangible" }, // 8 획득
    { q: "위의 행동을 하는 것을 즐기는 것으로 보입니까? (소리, 냄새, 맛, 시각적 즐거움)", f: "sensory" }, // 9 감각
    { q: "어떤 것을 요구할 때, 상대방을 당황스럽거나 화나게 하려고 위의 행동을 하는 것 같습니까?", f: "escape" }, // 10 회피
    { q: "관심을 주지 않을 때, 상대방을 당황스럽거나 화나게 하려고 위의 행동을 하는 것 같습니까?", f: "attention" }, // 11 관심
    { q: "위의 행동은 요구 사항(물건, 음식, 활동 등)이 제공된 후에 짧게라도 행동이 멈추었습니까?", f: "tangible" }, // 12 획득
    { q: "위의 행동이 발생할 때, 주위에서 일어나는 일을 의식하지 못합니까?", f: "sensory" }, // 13 감각
    { q: "주어진 과제를 멈춘 후(1~5분 내) 위의 행동이 중지됩니까?", f: "escape" }, // 14 회피
    { q: "상대방(타인)과 함께 시간을 보내기 위해 위의 행동을 하는 것 같습니까?", f: "attention" }, // 15 관심
    { q: "원하는 일을 할 수 없을 때 위의 행동을 하는 것 같습니까?", f: "tangible" }, // 16 획득
  ],
};

const SCALES = { FAST, QABF, MAS };
const SCALE_LIST = [FAST, QABF, MAS];

// 응답 옵션 정의
const SCALE_OPTIONS = {
  yn: [
    { v: "yes", label: "예", score: 1 },
    { v: "no", label: "아니오", score: 0 },
    { v: "na", label: "해당없음", score: null },
  ],
  q0123: [
    { v: "x", label: "X", score: null, hint: "해당없음" },
    { v: "0", label: "0", score: 0, hint: "전혀아님" },
    { v: "1", label: "1", score: 1, hint: "가끔" },
    { v: "2", label: "2", score: 2, hint: "종종" },
    { v: "3", label: "3", score: 3, hint: "자주" },
  ],
  s0to6: [
    { v: "0", label: "0", score: 0, hint: "전혀아님" },
    { v: "1", label: "1", score: 1, hint: "거의아님" },
    { v: "2", label: "2", score: 2, hint: "가끔" },
    { v: "3", label: "3", score: 3, hint: "중간" },
    { v: "4", label: "4", score: 4, hint: "대부분" },
    { v: "5", label: "5", score: 5, hint: "거의" },
    { v: "6", label: "6", score: 6, hint: "언제나" },
  ],
};

// ── 채점 함수: 응답 → 기능별 점수·순위 ──────────
function scoreAssessment(scaleId, answers) {
  const scale = SCALES[scaleId];
  const opts = SCALE_OPTIONS[scale.scale];
  const byFunc = {}; // f -> {sum, count}
  Object.keys(scale.functions).forEach((f) => (byFunc[f] = { sum: 0, count: 0 }));

  scale.items.forEach((item, i) => {
    const ans = answers[i];
    if (ans == null || ans === "") return;
    const opt = opts.find((o) => o.v === ans);
    if (!opt || opt.score == null) return; // 해당없음/X 제외
    byFunc[item.f].sum += opt.score;
    byFunc[item.f].count += 1;
  });

  // 기능별 결과 (합계 + 평균)
  const results = Object.keys(scale.functions).map((f) => ({
    f,
    name: scale.functions[f],
    sum: byFunc[f].sum,
    count: byFunc[f].count,
    avg: byFunc[f].count ? byFunc[f].sum / byFunc[f].count : 0,
  }));

  // 순위: 합계 기준 내림차순 (MAS는 평균도 참고하지만 합계로 통일)
  const sorted = [...results].sort((a, b) => b.sum - a.sum);
  const top = sorted[0];
  return { results, sorted, top };
}

// ══════════════════════════════════════════════
//  기능 통합 매핑 + 중재 라이브러리 (템플릿 기반)
//  세 척도의 개별 기능 → 4대 공통기능으로 수렴
// ══════════════════════════════════════════════
// 공통기능: attention(관심) / escape(회피) / sensory(감각·자동) / tangible(획득)
const FUNC_UNIFY = {
  // FAST
  social_pos: "attention", social_neg: "escape", auto_pos: "sensory", auto_neg: "sensory",
  // QABF
  attention: "attention", escape: "escape", nonsocial: "sensory", physical: "sensory", tangible: "tangible",
  // MAS
  sensory: "sensory",
  // (attention/escape/tangible 은 위와 키 공유)
};
const UNIFIED_FUNC_NAME = {
  attention: "관심 끌기 (사회적 정적강화)",
  escape: "회피·도피 (사회적 부적강화)",
  sensory: "감각 자극 (자동강화)",
  tangible: "선호물 획득 (물질적 강화)",
};

// 기능 계층 라벨/색상 (1차/2차/별도)
const TIER_LABEL = { primary: "1차 기능", secondary: "2차 기능", tertiary: "별도 기능", minor: "경미" };
const TIER_COLOR = { primary: "#D4728A", secondary: "#E89AAC", tertiary: "#8AA9D6", minor: "#C9BCC0" };

// 기능별 한 줄 가설 (계층 표시용)
const FUNC_HYPOTHESIS_SHORT = {
  attention: "관심이 부족할 때 관심을 얻으려는 동기",
  escape: "비선호 활동·요구에서 벗어나려는 동기",
  sensory: "특정 감각자극 자체가 주는 만족을 추구하는 동기",
  tangible: "원하는 물건·활동을 얻으려는 동기",
};

// 행동의 의미 서술 (임상적 재해석)
function FUNC_MEANING(func, name, target, setting) {
  const who = displayName(name);
  const place = setting === "school" ? "학급" : "치료 상황";
  const base = {
    attention: `${who}의 도전적 행동은 예측할 수 없는 돌발적 행동이 아니라, "나에게 관심을 주세요"라는 의사를 적절한 방식으로 전달하지 못한 채 강도 높은 행동으로 표현하는 학습된 기능적 의사소통의 대체 수단입니다.`,
    escape: `${who}의 도전적 행동은 예측할 수 없는 돌발적 행동이 아니라, "이 활동을 하고 싶지 않다"는 거절·회피 의사를 적절한 방식으로 전달하지 못한 채 강도 높은 행동으로 표현하는 학습된 기능적 의사소통의 대체 수단입니다.`,
    sensory: `${who}의 도전적 행동은 문제 삼아야 할 '나쁜 버릇'이 아니라, 충족되지 못한 감각 욕구가 겉으로 드러난 신호입니다. 안전하고 수용 가능한 대체 감각활동을 제공하면 조절 가능한 행동입니다.`,
    tangible: `${who}의 도전적 행동은 예측할 수 없는 돌발적 행동이 아니라, "그것을 갖고 싶다·하고 싶다"는 요구를 적절한 방식으로 전달하지 못한 채 강도 높은 행동으로 표현하는 학습된 기능적 의사소통의 대체 수단입니다.`,
  };
  return `${base[func] || base.escape} 적절한 대체행동 교수와 강화 수반성 재설정을 통해 ${place}에서 충분히 변화 가능한 표적행동입니다.`;
}


// 부모님용 쉬운 버전 — 전문용어 없이, "~해주세요" 톤, 예시 풍부
const PARENT_BIP = {
  attention: {
    why: "우리 아이가 이런 행동을 하는 건 말썽을 부리려는 게 아니라, \"나를 봐주세요\", \"관심 가져주세요\"라는 마음을 표현하는 거예요. 아직 그 마음을 적절한 말이나 행동으로 표현하는 법을 몰라서, 문제행동으로 관심을 얻으려는 것이랍니다.",
    prevent: [
      "아이가 얌전히 잘 있을 때 먼저 다가가 관심을 주세요. 문제행동을 하기 전에 미리, 자주(5~10분마다) \"우리 ○○ 잘하고 있네~\" 하고 눈맞춤하며 칭찬해주세요.",
      "관심을 언제 받을 수 있는지 미리 알려주세요. 예: \"이거 다 하면 엄마가 안아줄게\"처럼 예고하면 아이가 안심하고 기다릴 수 있어요.",
      "잘하는 순간을 놓치지 말고 바로 말해주세요. \"혼자서 신발 신었네!\", \"동생한테 양보했구나!\"처럼 구체적으로 칭찬해주세요.",
      "야단치는 것보다 칭찬을 훨씬 많이(4배 이상) 해주세요. 아이는 혼나는 것도 '관심'으로 느껴서, 야단이 오히려 문제행동을 늘릴 수 있어요.",
    ],
    teach: [
      "관심이 필요할 때 적절히 표현하는 법을 가르쳐주세요. 예: 손 들기, \"봐 주세요\" 말하기, 엄마 어깨 톡톡 두드리기.",
      "아이가 바르게 표현하면 하던 일을 멈추고 바로 반응해주세요. 그래야 아이가 \"이렇게 하면 빨리 봐주시는구나\"를 배워요.",
      "조금씩 기다리는 것도 가르쳐주세요. \"잠깐만, 이것만 하고 봐줄게\" 하고 짧게 시작해 점점 기다리는 시간을 늘려주세요.",
    ],
    respond: [
      "문제행동을 할 때는 최대한 반응을 줄여주세요(위험하지 않다면). 눈맞춤·잔소리·표정 반응을 줄이면, 그 행동으로는 관심을 못 얻는다는 걸 배워요.",
      "대신 문제행동이 멈추고 바르게 행동하는 순간, 바로 크게 관심과 칭찬을 주세요.",
      "처음엔 문제행동이 잠깐 더 심해질 수 있어요(원래 통하던 방법이라). 흔들리지 말고 일관되게 반응해주시면 곧 줄어들어요.",
    ],
  },
  escape: {
    why: "우리 아이가 이런 행동을 하는 건 \"이거 너무 어려워요\", \"하기 싫어요\", \"그만하고 싶어요\"라는 마음의 표현이에요. 힘든 상황에서 벗어나고 싶은데, 그걸 적절히 말하는 법을 몰라서 문제행동으로 표현하는 거랍니다.",
    prevent: [
      "과제를 아이 수준에 맞게 조절해주세요. 너무 어려우면 잘게 나누고, 쉬운 것부터 성공하게 해서 자신감을 먼저 주세요.",
      "중간중간 쉬는 시간을 미리 넣어주세요. \"세 개 하고 한 번 쉬자\"처럼요.",
      "선택할 기회를 주세요. \"수학 먼저 할래, 책 먼저 볼래?\"처럼 아이가 고르게 하면 훨씬 덜 거부해요.",
      "무엇을 얼마나 하는지 그림이나 순서표로 보여주세요. 끝이 보이면 아이가 훨씬 잘 견뎌요. (\"먼저 이거, 그다음 이거\")",
    ],
    teach: [
      "\"쉬고 싶어요\", \"도와주세요\"를 말이나 카드로 표현하게 가르쳐주세요. 도망가는 대신 도움을 청하는 법을 알려주는 거예요.",
      "아이가 이렇게 표현하면 바로 짧게 쉬게 하거나 도와주세요. 그래야 \"이렇게 말하면 되는구나\"를 배워요.",
      "조금씩 참는 것도 가르쳐주세요. \"이거 하나만 더 하고 쉬자\"처럼 아주 조금씩 늘려가세요.",
    ],
    respond: [
      "문제행동을 한다고 해서 과제를 아예 없애주지는 마세요. 그러면 \"이렇게 하면 안 해도 되는구나\"를 배우게 돼요. 대신 도와주거나 양을 줄여서라도 마무리하게 해주세요.",
      "바르게 요청하거나 과제에 참여하면 바로 쉬게 해주고 칭찬해주세요.",
      "정해진 만큼 하면 좋아하는 활동을 하게 해주세요. \"이거 끝나면 좋아하는 블록 놀이 하자\"처럼요.",
    ],
  },
  sensory: {
    why: "우리 아이가 이런 행동을 하는 건 몸이 원하는 감각(만지는 느낌, 움직이는 느낌, 보는 느낌 등)을 채우려는 거예요. 말썽이 아니라, 아이 몸이 그 자극을 필요로 하는 것이랍니다. 그래서 주변에 아무도 없어도 이 행동이 나타나곤 해요.",
    prevent: [
      "아이가 좋아하는 감각을 안전하게 채울 수 있는 물건을 가까이 두세요. 예: 만지는 걸 좋아하면 촉감 장난감·말랑이, 움직임을 좋아하면 트램폴린·짐볼을 손 닿는 곳에.",
      "정해진 시간에 미리 감각 놀이를 시켜주세요. 예: 20~30분마다 몇 분씩 좋아하는 감각 활동을 하면, 문제행동으로 자극을 찾을 필요가 줄어요.",
      "하루 일과 속에 몸을 움직이고 감각을 채우는 시간을 규칙적으로 넣어주세요. (전문가·치료사와 상의해 시간표를 만들면 좋아요.)",
      "심심하거나 지루한 시간이 길어지지 않게 해주세요. 그럴 때 감각 추구 행동이 더 나오기 쉬워요.",
    ],
    teach: [
      "문제행동 대신 비슷한 감각을 얻는 다른 행동을 가르쳐주세요. 예: 물건을 입에 넣는 대신 씹기 장난감 물기, 손을 흔드는 대신 말랑이 만지기.",
      "\"만지고 싶어요\", \"움직이고 싶어요\"를 말이나 카드로 표현하게 알려주세요. 그러면 정해진 자리에서 감각 도구를 쓰게 해주세요.",
      "스스로 진정하는 순서를 알려주세요. 예: '멈추기 → 숨쉬기 → 도구 쓰기' 그림 카드로 연습해요.",
    ],
    respond: [
      "아이가 바르게 감각 도구를 요청하거나 사용하면 바로 칭찬해주세요.",
      "문제행동을 할 때는 담담하게 반응하고, 가능하면 그 행동이 주는 자극을 줄여주세요(안전한 범위에서). 예: 소리가 좋아서라면 조용한 환경, 촉감이라면 다른 재질로 바꿔주기.",
      "좋아하는 감각 활동도 가끔 종류를 바꿔주세요. 늘 똑같으면 아이가 금방 싫증 내요.",
    ],
  },
  tangible: {
    why: "우리 아이가 이런 행동을 하는 건 \"그거 갖고 싶어요\", \"그거 하고 싶어요\"라는 마음의 표현이에요. 원하는 걸 얻고 싶은데, 적절히 요청하는 법을 몰라서 문제행동으로 표현하는 거랍니다.",
    prevent: [
      "언제 가질 수 있는지 미리 알려주세요. 예: 타이머나 \"이따가\" 카드로 \"조금 있다가 줄게\"를 눈에 보이게 해주세요.",
      "좋아하는 것을 끝내야 할 때 미리 예고해주세요. \"5분 뒤에 정리할 거야, 이따 또 할 수 있어\"처럼요.",
      "원하는 걸 적절히 요청할 기회를 자주 만들어주세요.",
      "\"안 돼\"만 반복하기보다, 언제 어떻게 얻을 수 있는지 함께 알려주세요. 예: \"지금은 안 되지만, 밥 먹고 나서 하자\".",
    ],
    teach: [
      "원하는 걸 적절히 표현하는 법을 가르쳐주세요. 예: 그림카드 주기, \"주세요\" 말하기, 손으로 가리키기.",
      "\"기다리기\"를 조금씩 가르쳐주세요. 처음엔 아주 짧게, 점점 기다리는 시간을 늘려가세요.",
      "차례 지키기, 나눠 쓰기도 함께 알려주세요. 특히 형제나 친구와 있을 때 필요해요.",
    ],
    respond: [
      "문제행동을 할 때는 원하는 걸 주지 마세요. 그러면 \"이렇게 하면 얻는구나\"를 배우게 돼요.",
      "대신 바르게 요청하면 바로 주세요. \"주세요\"라고 말하거나 카드를 주면 즉시 반응해주세요.",
      "정해진 시간 동안 잘 기다리면 원하는 걸 주세요. 기다림이 통한다는 걸 배우게 해주세요.",
    ],
  },
};

// 기능별 중재 라이브러리 — ABA 표준 4구성
const INTERVENTION_LIB = {
  attention: {
    hypothesis: (name, beh) => `${name}${K(name,"은","는")} 주변 어른이나 또래의 관심이 부족할 때 ${beh}${K(beh,"을","를")} 통해 관심을 얻으려는 것으로 추정됩니다. 즉, 이 행동은 '나를 봐 주세요'라는 기능을 합니다.`,
    antecedent: [
      "도전적 행동이 없을 때 미리, 자주(예: 5~10분마다) 긍정적 관심을 준다 (비유관 관심, NCR). 관심을 얻으려 행동할 필요 자체를 줄인다.",
      "관심을 받을 수 있는 시점을 미리 예고한다. 예: '5분 동안 혼자 해보고, 다 하면 선생님이 크게 칭찬해줄게'로 예측 가능성을 높인다.",
      "아동이 바르게 행동하는 순간을 놓치지 않고 즉시 구체적으로 언급한다 (행동 특정적 칭찬). 예: '조용히 앉아서 기다렸구나!'",
      "관심 밀도가 낮아지는 시간대(교사가 바쁜 시간, 개별활동 시간 등)를 파악해 그때 관심 제공 방법을 미리 계획한다.",
      "또래의 긍정적 관심을 활용한다. 예: 짝활동·도우미 역할을 배정해 적절한 방식으로 관심을 얻을 기회를 만든다.",
      "긍정적 관심과 부정적 관심(꾸중)의 비율을 최소 4:1 이상으로 유지하도록 계획한다.",
    ],
    replacement: [
      "관심을 적절히 요청하는 방법을 가르친다 (기능적 의사소통 훈련, FCT). 예: 손 들기, '봐 주세요' 말하기, 도움카드 건네기.",
      "적절한 요청에는 즉각적이고 풍부하게 반응해, 새 행동이 도전적 행동보다 빠르고 확실하게 관심을 얻도록 한다 (반응효율성).",
      "기다리는 방법을 함께 가르친다. 예: '기다리는 중' 카드를 쥐고 잠시 기다리면 관심을 제공한다 (지연 감내 훈련).",
      "요청 행동을 처음엔 촉구로 이끌고 점차 촉구를 용암시켜 스스로 하게 한다 (촉구 용암).",
      "적절한 관심요청이 다양한 상황·사람에게 일반화되도록 여러 장면에서 연습한다.",
    ],
    consequence: [
      "도전적 행동에는 계획된 무관심(소거)을 적용한다 — 눈맞춤·말·표정 반응을 최소화한다. (단, 안전이 위협되면 최소한의 중립적 개입)",
      "적절한 관심요청 행동에는 즉시 관심으로 반응한다 (대체행동 차별강화, DRA).",
      "도전적 행동이 없는 시간 간격에 관심을 제공한다 (타행동 차별강화, DRO). 간격은 짧게 시작해 점차 늘린다.",
      "소거 초기에 나타날 수 있는 소거 폭발(일시적 행동 증가)을 예상하고 일관되게 대응한다.",
      "무관심 후 적절 행동이 나오는 즉시 관심을 주어, '적절 행동 → 관심'의 연결을 분명히 학습시킨다.",
    ],
  },
  escape: {
    hypothesis: (name, beh) => `${name}${K(name,"은","는")} 어렵거나 하기 싫은 과제·요구가 제시될 때 그 상황에서 벗어나기 위해 ${beh}${K(beh,"을","를")} 보이는 것으로 추정됩니다. 즉, 이 행동은 '이걸 그만하고 싶어요'라는 기능을 합니다.`,
    antecedent: [
      "과제 난이도를 아동 수준에 맞게 조정하고 성공 경험을 먼저 제공한다 (행동 탄력, behavioral momentum: 쉬운 과제 여러 개 → 어려운 과제).",
      "과제를 작게 나누고 중간에 계획된 짧은 휴식을 미리 넣는다 (과제 분할).",
      "선택 기회를 준다. 예: '수학 먼저 할래, 읽기 먼저 할래?' — 통제감을 주어 회피 동기를 낮춘다.",
      "시각적 일정표로 과제의 시작·끝·쉬는 시간을 예측 가능하게 한다 (예: '먼저-그다음' 카드).",
      "지루하거나 과도한 반복 과제를 줄이고, 아동의 흥미·강점을 과제에 반영한다 (과제 흥미도 조정).",
      "요구 방식을 부드럽게 한다. 예: 지시를 명확·간결하게, 예고 후 제시하고, 완료 기준을 분명히 보여준다.",
    ],
    replacement: [
      "적절하게 휴식을 요청하는 방법을 가르친다 (기능적 의사소통 훈련, FCT). 예: '쉬고 싶어요' 카드 교환, '쉬어요' 말하기.",
      "도움을 요청하는 방법을 가르친다. 예: '도와주세요' 카드·말하기로, 어려울 때 회피 대신 도움을 구하게 한다.",
      "요청 시 즉시 짧은 휴식·도움을 제공해, 새 행동이 도전적 행동보다 효율적으로 회피 기능을 하도록 한다 (반응효율성).",
      "정해진 만큼 과제를 하면 쉴 수 있음을 배우게 한다 (지연 감내: 휴식 요청 후 조금씩 기다리는 시간을 늘린다).",
      "요청 행동을 촉구로 이끈 뒤 점차 촉구를 용암시켜 독립적으로 사용하게 한다 (촉구 용암).",
    ],
    consequence: [
      "도전적 행동으로는 과제에서 벗어나지 못하게 한다 (회피 소거, escape extinction: 행동 후에도 과제를 지속·완료하게 한다).",
      "적절한 휴식·도움 요청, 과제 참여에는 즉시 휴식·강화를 제공한다 (대체행동 차별강화, DRA).",
      "정해진 양의 과제를 완수하면 선호 활동을 제공한다 (프리맥 원리).",
      "도전적 행동이 없는 시간 간격에 강화한다 (타행동 차별강화, DRO).",
      "회피 소거 적용 시 소거 폭발과 정서 반응을 예상하고, 촉구·난이도 조정을 병행해 좌절을 최소화한다.",
    ],
  },
  sensory: {
    hypothesis: (name, beh) => `${name}의 ${beh}${K(beh,"은","는")} 특정 감각적 자극 자체가 주는 만족 때문에 유지되는 것으로 추정됩니다(자동강화). 주변에 사람이 없어도 나타나는 경향이 이를 뒷받침합니다.`,
    antecedent: [
      "유사한 감각을 주는 적절한 대체 활동을 환경에 풍부하게 배치한다 (환경 풍부화). 예: 촉각 자극이면 촉감 놀잇감·씹기 목걸이, 전정 자극이면 짐볼·흔들의자를 손 닿는 곳에 둔다.",
      "선호 감각활동을 정해진 시간에 무조건적으로 제공한다 (비유관 강화, NCR). 예: 20분마다 2분씩 감각놀이를 일정에 넣어, 행동으로 자극을 얻을 필요 자체를 줄인다.",
      "하루 일과에 감각 욕구를 규칙적으로 채우는 활동을 배분한다 (감각 식단, sensory diet). 작업치료사와 협의해 각성 수준에 맞는 활동을 시간표로 만든다.",
      "감각추구가 심해지는 선행조건(피곤·배고픔·소음·무료한 대기시간 등)을 파악해 미리 조정한다 (동기조작, MO).",
      "과제·활동을 감각적으로 흥미롭게 구성해 몰입도를 높인다. 예: 촉감 교구, 움직임이 포함된 학습활동으로 자기자극의 필요를 낮춘다.",
      "자극이 단조로운 대기·전이 시간을 최소화하고, 비는 시간에 할 수 있는 감각활동을 미리 정해둔다.",
    ],
    replacement: [
      "사회적으로 수용 가능하고 유사한 감각을 얻는 대체행동을 가르친다 (기능적 등가 훈련). 예: 손 흔들기 → 피젯토이 조작, 물건 입에 넣기 → 씹기 목걸이.",
      "감각 도구를 스스로 요청·사용하도록 지도한다 (기능적 의사소통 훈련, FCT). 예: '쉬는 시간'·'감각 도구' 카드를 교환하면 도구를 제공한다.",
      "대체행동이 도전적 행동만큼, 혹은 그 이상으로 감각 만족을 주도록 조정한다 (대체행동의 반응효율성 확보).",
      "스스로 각성을 조절하는 자기관리 기술을 가르친다. 예: '멈추기 → 숨쉬기 → 감각 도구 쓰기' 순서 카드로 자기조절을 연습시킨다.",
      "대체행동을 처음엔 촉구로 이끌고 점차 촉구를 용암시켜 독립적으로 사용하게 한다 (촉구 용암).",
    ],
    consequence: [
      "대체 감각활동에 참여할 때 즉시·풍부하게 강화한다 (대체행동 차별강화, DRA).",
      "도전적 행동이 없는 시간 간격에 강화를 제공한다 (타행동 차별강화, DRO). 간격은 현재 행동 빈도에 맞춰 짧게 시작해 점차 늘린다.",
      "가능한 경우 그 행동이 주는 감각 자극을 차단·감소시킨다 (감각 소거). 예: 소리가 강화라면 방음, 촉감이면 재질 변경 — 반드시 안전 범위 내에서.",
      "도전적 행동에는 감각적 결과를 최소화하고 반응을 중립적으로 유지한다 (관심·반응이 부가 강화가 되지 않도록).",
      "강화 효과를 유지하기 위해 대체 감각활동의 종류를 주기적으로 바꿔 포화를 방지한다. ※ 자동강화는 소거가 어려우므로 대체행동 교수와 환경조정이 핵심이다.",
    ],
  },
  tangible: {
    hypothesis: (name, beh) => `${name}${K(name,"은","는")} 원하는 물건·음식·활동을 얻지 못하거나 빼앗겼을 때 이를 얻기 위해 ${beh}${K(beh,"을","를")} 보이는 것으로 추정됩니다. 즉, '그걸 갖고 싶어요'라는 기능을 합니다.`,
    antecedent: [
      "선호물 이용 규칙과 시간을 시각적으로 미리 안내한다 (예: 타이머, '이따가' 카드, '지금-다음' 시각판).",
      "선호물 종료(전이) 전에 미리 예고하고, 다음에 다시 할 수 있음을 알려준다 (전이 예고).",
      "선호물을 적절히 요청할 수 있는 기회를 하루 중 자주 만든다 (요청 기회 삽입).",
      "원하는 것을 규칙적으로 미리 제공해 결핍 상태를 줄인다 (비유관 강화, NCR).",
      "선호물을 둘러싼 갈등 상황(뺏김·순서 기다림)을 예측해, 순서판·차례 카드로 미리 구조화한다.",
      "'안 돼요'만 반복하기보다, 언제·어떻게 얻을 수 있는지를 함께 알려준다 (대안 제시).",
    ],
    replacement: [
      "원하는 것을 적절히 요청하는 방법을 가르친다 (기능적 의사소통 훈련, FCT). 예: 그림교환 PECS, '주세요' 말하기, 요청 카드.",
      "'기다리기'를 단계적으로 가르친다 (지연 감내 훈련: 짧은 대기부터 시작해 점차 늘린다).",
      "'지금은 안 되지만 이따가 가능'을 이해하도록 시각 지원과 함께 지도한다 (지금-다음 전략).",
      "차례 지키기·나눠 쓰기 등 사회적 기술을 함께 가르친다 (또래 상황 대비).",
      "요청 행동을 촉구로 이끈 뒤 점차 촉구를 용암시켜 스스로 요청하게 한다 (촉구 용암).",
    ],
    consequence: [
      "도전적 행동으로는 원하는 물건을 얻지 못하게 한다 (소거: 행동 후 선호물을 제공하지 않는다).",
      "적절한 요청에는 즉시 선호물을 제공한다 (대체행동 차별강화, DRA).",
      "정해진 시간 동안 도전적 행동 없이 기다리면 선호물을 제공한다 (타행동 차별강화 DRO·지연강화).",
      "소거 초기의 소거 폭발을 예상하고 일관되게 대응한다 (선호물을 절대 행동 뒤에 주지 않는다).",
      "'적절 요청 → 획득'의 연결이 분명해지도록, 요청 직후 제공 시점을 놓치지 않는다.",
    ],
  },
};

// ══════════════════════════════════════════════
//  학교(PBS) 전용 중재 라이브러리
//  전제: 교사 1명이 학급 전체 담당 → 1:1 개별교수·즉각개입 어려움
//  → 선행중재(예방)·환경세팅·또래/학급차원·자기관리 중심으로 구성
// ══════════════════════════════════════════════
const INTERVENTION_LIB_SCHOOL = {
  attention: {
    hypothesis: (name, beh) => `${name}${K(name,"은","는")} 교실에서 교사나 또래의 관심이 부족할 때 ${beh}${K(beh,"을","를")} 통해 관심을 얻으려는 것으로 추정됩니다. 학급 전체를 지도하는 교사가 개별 관심을 주기 어려운 상황이 이 행동을 강화할 수 있습니다.`,
    antecedent: [
      "수업 중 정기적으로 관심을 주는 시점을 미리 정한다 (예: 순회지도 동선에 이 학생 좌석을 포함, 활동 전환마다 짧게 눈맞춤·격려).",
      "교사와 가까운 좌석에 배치하고, 바르게 참여할 때 자연스럽게 관심을 받을 수 있게 한다.",
      "'도우미 역할'(칠판 정리, 유인물 배부 등)을 부여해 적절한 방식으로 관심·인정을 얻을 기회를 만든다.",
      "1:1 개별 개입이 어려우므로, 학급 전체 규칙에 '바르게 참여하면 관심' 원칙을 포함해 예측 가능하게 한다.",
    ],
    replacement: [
      "관심이 필요할 때 적절히 요청하는 방법을 가르친다 (예: 도움 요청 카드 책상에 부착, 손 들기, 정해진 신호).",
      "또래 짝(버디)을 지정해, 교사가 즉시 반응하지 못할 때 또래의 긍정적 관심으로 보완한다 (또래 매개 지원).",
    ],
    consequence: [
      "도전적 행동에는 최소한의 반응(계획된 무관심)을 하되, 학급 흐름이 끊기지 않게 비언어적 신호로 처리한다.",
      "바르게 참여하는 순간을 놓치지 않고 즉시 구체적으로 칭찬한다 (행동 특정적 칭찬 — 학급 전체에도 모델이 됨).",
      "개별 즉각강화가 어려우므로, 토큰·스티커판 같은 시각적 누적강화로 지연강화를 운영한다.",
    ],
  },
  escape: {
    hypothesis: (name, beh) => `${name}${K(name,"은","는")} 수업 과제가 어렵거나 길게 느껴질 때 그 상황에서 벗어나기 위해 ${beh}${K(beh,"을","를")} 보이는 것으로 추정됩니다. 개별 난이도 조정이 어려운 학급 수업 특성상 회피 동기가 커질 수 있습니다.`,
    antecedent: [
      "과제를 작은 단위로 나누고, 완료 지점을 시각적으로 표시한다 (예: 체크리스트, '여기까지' 표시).",
      "이 학생에게는 분량·난이도를 사전에 조정한 과제를 준비한다 (수정된 과제, 또래와 다른 양이어도 무방).",
      "수업 일과와 과제 순서를 시각적 일정표로 제시해 예측 가능성을 높인다.",
      "쉬운 과제로 시작해 성공 경험을 준 뒤 어려운 과제로 넘어간다 (행동 탄력).",
      "정해진 조건에서 '휴식 패스'를 쓸 수 있게 한다 (교실 안에서 허용된 방식으로 잠깐 쉬는 방법).",
    ],
    replacement: [
      "적절히 도움·휴식을 요청하는 방법을 가르친다 (예: '도와주세요/쉬고 싶어요' 카드, 책상 위 신호판).",
      "요청 시 짧은 휴식이나 대안 과제를 허용해, 도전적 행동보다 요청이 더 쉽게 통하도록 만든다.",
    ],
    consequence: [
      "가능한 범위에서 도전적 행동으로 과제를 완전히 회피하지는 못하게 한다 (예: 양을 줄여서라도 최소한 참여 후 종료).",
      "적절한 요청·참여에는 즉시 휴식·강화를 준다 (DRA).",
      "정해진 분량을 마치면 선호 활동을 하게 한다 (프리맥 — 학급 공통 규칙으로 운영하면 관리 쉬움).",
      "일관된 소거가 어려운 환경이므로, 교사·특수교사·보조인력이 대응 방식을 미리 통일해 둔다.",
    ],
  },
  sensory: {
    hypothesis: (name, beh) => `${name}의 ${beh}${K(beh,"은","는")} 특정 감각자극 자체가 주는 만족 때문에 유지되는 것으로 추정됩니다(자동강화). 수업 중 자극이 단조롭거나 대기 시간이 길 때 더 나타날 수 있습니다.`,
    antecedent: [
      "수업 중 사용할 수 있는 조용한 감각 도구를 허용한다 (예: 피젯토이, 무릎담요, 씹기 목걸이 — 수업 방해 없는 것으로).",
      "대기·전이 시간을 줄이고, 할 일을 명확히 주어 '빈 시간'을 최소화한다.",
      "쉬는 시간이나 정해진 시점에 감각욕구를 충분히 충족할 기회를 준다 (감각 식단).",
      "좌석 위치·조명·소음 등 교실 환경에서 과잉/과소 자극 요인을 조정한다.",
    ],
    replacement: [
      "수업에 방해되지 않으면서 비슷한 감각을 얻는 대체행동을 가르친다 (예: 소리내기 → 피젯 조작, 자리이탈 → 정해진 스트레칭).",
      "감각 도구 사용 규칙(언제·어떻게)을 명확히 정해 자기관리로 연결한다.",
    ],
    consequence: [
      "자동강화는 소거가 어려우므로, 환경조정과 대체도구가 핵심임을 교사와 공유한다.",
      "대체도구를 적절히 사용할 때 인정·강화한다 (DRA).",
      "도전적 행동이 적은 시간대·상황을 파악해, 그 조건을 수업 전반으로 확대 적용한다.",
    ],
  },
  tangible: {
    hypothesis: (name, beh) => `${name}${K(name,"은","는")} 원하는 물건·활동을 얻지 못하거나 순서를 기다려야 할 때 ${beh}${K(beh,"을","를")} 보이는 것으로 추정됩니다. 학급에서는 자원(교구·컴퓨터·차례)이 공유되므로 이런 상황이 자주 생깁니다.`,
    antecedent: [
      "차례·이용 규칙을 시각적으로 명확히 안내한다 (예: 순서판, 타이머, '다음은 내 차례' 카드).",
      "전이(활동 종료) 전에 예고하고, 다음 이용 시점을 알려준다.",
      "선호 물건·활동을 적절히 요청하거나 차례를 기다릴 기회를 자주 만든다.",
      "공유 자원은 순번표·시간표로 구조화해 갈등 상황 자체를 예방한다.",
    ],
    replacement: [
      "원하는 것을 적절히 요청하고 기다리는 방법을 가르친다 (예: 요청 카드, '기다리기' 시각 타이머).",
      "짧은 기다림부터 점차 늘려 지연을 견디는 힘을 기른다 (지연 감내 훈련).",
    ],
    consequence: [
      "도전적 행동으로는 원하는 것을 얻지 못하게 하되, 학급 규칙으로 일관되게 적용한다.",
      "적절한 요청·기다림에는 약속대로 선호물·차례를 제공한다 (DRA).",
      "차례를 잘 지키거나 기다린 것을 학급 차원에서 인정·강화한다 (집단강화로 관리 부담 완화).",
    ],
  },
};

// 완료된 평가들 → 통합 기능 집계 (가장 우세한 기능 판정)
function aggregateFunction(assessments) {
  if (!assessments || assessments.length === 0) return null;
  const tally = { attention: 0, escape: 0, sensory: 0, tangible: 0 }; // 1위 표수(기존 호환)
  const scoreSum = { attention: 0, escape: 0, sensory: 0, tangible: 0 }; // 정규화 점수 합
  const detail = []; // 각 평가별 top 기능

  assessments.forEach((a) => {
    // 1위 기능 집계 (기존 호환)
    const uf = FUNC_UNIFY[a.top.f];
    if (uf) { tally[uf] += 1; detail.push({ scale: a.scaleId, func: uf, raw: a.top.name }); }

    // 모든 기능 점수를 통합축으로 합산 (정규화: 각 평가 내 최고점=1 기준)
    if (a.results && a.results.length) {
      const maxSum = Math.max(...a.results.map((r) => r.sum), 1);
      a.results.forEach((r) => {
        const u = FUNC_UNIFY[r.f];
        if (u) scoreSum[u] += r.sum / maxSum; // 0~1 정규화 후 누적
      });
    }
  });

  const ranked = Object.entries(tally).sort((x, y) => y[1] - x[1]);
  const primary = ranked[0][1] > 0 ? ranked[0][0] : null;

  // 점수 기반 순위 (1차/2차/별도 계층 판정용)
  const scoreRanked = Object.entries(scoreSum)
    .filter(([, v]) => v > 0)
    .sort((x, y) => y[1] - x[1]);

  // 계층 분류: 최고점 대비 비율로 판정
  const topScore = scoreRanked.length ? scoreRanked[0][1] : 0;
  const tiers = scoreRanked.map(([f, v], i) => {
    let tier;
    if (i === 0) tier = "primary";
    else if (v >= topScore * 0.6) tier = "secondary"; // 최고의 60% 이상이면 부기능
    else if (v >= topScore * 0.3) tier = "tertiary";  // 30~60%면 별도기능
    else tier = "minor";
    return { func: f, score: v, ratio: topScore ? v / topScore : 0, tier };
  });

  return { primary, tally, detail, ranked, scoreSum, scoreRanked, tiers, topScore };
}

// BIP 생성 (템플릿 조합) — setting: 'center' | 'pbs'
function generateBIP(func, childName, targetBeh, setting) {
  const lib = (setting === "pbs" ? INTERVENTION_LIB_SCHOOL : INTERVENTION_LIB)[func];
  if (!lib) return null;
  const name = displayName(childName);
  const beh = targetBeh || "목표행동";
  return {
    func,
    funcName: UNIFIED_FUNC_NAME[func],
    setting: setting === "pbs" ? "school" : "center",
    hypothesis: lib.hypothesis(name, beh),
    antecedent: lib.antecedent,
    replacement: lib.replacement,
    consequence: lib.consequence,
  };
}

// ── 라우터: #/fill/{token} 이면 외부 작성 페이지, 아니면 앱 ──
export default function App() {
  const [hash, setHash] = useState(typeof window !== "undefined" ? window.location.hash : "");
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // #/fill/{token}  (척도id는 토큰 안에 들어있으므로 토큰만 파싱)
  const m = hash.match(/^#\/fill\/(.+)$/);
  if (m) {
    // 경로가 #/fill/{scale}/{token} 형태일 수도 있어 마지막 세그먼트를 토큰으로 사용
    const parts = m[1].split("/");
    const token = parts[parts.length - 1];
    return <ExternalFillPage token={token} />;
  }
  return <MainApp />;
}

function MainApp() {
  // 인증 상태
  const [adminHash, setAdminHash] = useState(null); // 관리자 비번 해시 (null = 미설정)
  const [teachers, setTeachers] = useState([]);       // [{name, hash}]
  const [current, setCurrent] = useState(null);       // {role:'admin'|'teacher', name}
  const didRestoreSession = React.useRef(false);

  // 데이터 (Supabase 로드)
  const [cases, setCases] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const didHydrate = React.useRef(false);
  const hadCasesAtLoad = React.useRef(false);
  const hadTeachersAtLoad = React.useRef(false);

  const [tab, setTab] = useState("center");
  const [selectedId, setSelectedId] = useState(null); // 열람 중인 케이스 id

  useEffect(() => {
    (async () => {
      const [ah, tc, cs] = await Promise.all([
        bipStore.get("adminHash"),
        bipStore.get("teachers"),
        bipStore.get("cases"),
      ]);
      if (ah) setAdminHash(ah);
      if (Array.isArray(tc)) { setTeachers(tc); hadTeachersAtLoad.current = tc.length > 0; }
      if (Array.isArray(cs)) { setCases(cs); hadCasesAtLoad.current = cs.length > 0; }
      didHydrate.current = true;
      setLoaded(true);
    })();
  }, []);

  useEffect(() => { if (didHydrate.current && adminHash) bipStore.set("adminHash", adminHash); }, [adminHash]);
  useEffect(() => {
    if (!didHydrate.current) return;
    if (teachers.length === 0 && hadTeachersAtLoad.current) return; // 비정상 빈 배열 덮어쓰기 방지
    bipStore.set("teachers", teachers);
  }, [teachers]);
  useEffect(() => {
    if (!didHydrate.current) return;
    if (cases.length === 0 && hadCasesAtLoad.current) return; // 비정상 빈 배열 덮어쓰기 방지
    bipStore.set("cases", cases);
  }, [cases]);

  useEffect(() => {
    try { const r = sessionStorage.getItem("bipmaker-current"); if (r) setCurrent(JSON.parse(r)); } catch (e) {}
    didRestoreSession.current = true;
  }, []);
  useEffect(() => {
    if (!didRestoreSession.current) return;
    if (current) { try { sessionStorage.setItem("bipmaker-current", JSON.stringify(current)); } catch (e) {} }
  }, [current]);


  // 로그인 전
  if (!current) {
    return (
      <AuthGate
        adminHash={adminHash}
        teachers={teachers}
        onSetupAdmin={async (pw) => {
          const h = await hashPasswordSecure(pw);
          setAdminHash(h);
        }}
        onLogin={setCurrent}
      />
    );
  }

  const handleLogout = () => {
    try { sessionStorage.removeItem("bipmaker-current"); } catch (e) {}
    setCurrent(null);
  };

  const isAdmin = current.role === "admin";
  // 관리자는 전체, 선생님은 본인 owner만
  const visible = cases.filter((c) => c.type === tab && (isAdmin || c.owner === current.name));

  const selectedCase = selectedId ? cases.find((c) => c.id === selectedId) : null;

  // 기록 추가/삭제 헬퍼
  const addRecord = (caseId, rec) =>
    setCases((prev) => prev.map((c) => c.id === caseId ? { ...c, records: [{ ...rec, id: Date.now() }, ...(c.records || [])] } : c));
  const removeRecord = (caseId, recId) =>
    setCases((prev) => prev.map((c) => c.id === caseId ? { ...c, records: (c.records || []).filter((r) => r.id !== recId) } : c));

  // 평가 추가/삭제 헬퍼
  const addAssessment = (caseId, asmt) =>
    setCases((prev) => prev.map((c) => c.id === caseId ? { ...c, assessments: [{ ...asmt, id: Date.now() }, ...(c.assessments || [])] } : c));
  const removeAssessment = (caseId, asmtId) =>
    setCases((prev) => prev.map((c) => c.id === caseId ? { ...c, assessments: (c.assessments || []).filter((a) => a.id !== asmtId) } : c));

  // 케이스 삭제
  const removeCase = (caseId) => {
    setCases((prev) => {
      const next = prev.filter((c) => c.id !== caseId);
      hadCasesAtLoad.current = next.length > 0; // 의도적 삭제로 0개가 되면 이후 자동저장 허용
      bipStore.set("cases", next);              // 빈 배열이어도 명시적으로 저장
      return next;
    });
    setSelectedId(null);
  };

  // 상세 화면
  if (selectedCase) {
    return (
      <div style={{ minHeight: "100vh", background: PKL, fontFamily: "'Pretendard', -apple-system, sans-serif", color: INK, display: "flex", flexDirection: "column" }}>
        <Header current={current} isAdmin={isAdmin} onLogout={handleLogout} />
        <div style={{ flex: 1, maxWidth: 860, margin: "0 auto", width: "100%", boxSizing: "border-box", padding: "0 16px 40px" }}>
          <CaseDetail
            c={selectedCase}
            isAdmin={isAdmin}
            onBack={() => setSelectedId(null)}
            onAddRecord={(rec) => addRecord(selectedCase.id, rec)}
            onRemoveRecord={(recId) => removeRecord(selectedCase.id, recId)}
            onAddAssessment={(asmt) => addAssessment(selectedCase.id, asmt)}
            onRemoveAssessment={(aid) => removeAssessment(selectedCase.id, aid)}
            onRemoveCase={() => removeCase(selectedCase.id)}
          />
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: PKL, fontFamily: "'Pretendard', -apple-system, sans-serif", color: INK, display: "flex", flexDirection: "column" }}>
      <Header current={current} isAdmin={isAdmin} onLogout={handleLogout} />

      <div style={{ flex: 1, maxWidth: 860, margin: "0 auto", width: "100%", boxSizing: "border-box", padding: "0 16px 40px" }}>
        {isAdmin && (
          <AdminPanel
            teachers={teachers}
            onAddTeacher={async (name, pw) => {
              const h = await hashPasswordSecure(pw);
              setTeachers((prev) => [...prev.filter((t) => t.name !== name), { name, hash: h }]);
            }}
            onRemoveTeacher={(name) => setTeachers((prev) => prev.filter((t) => t.name !== name))}
          />
        )}

        <div style={{ display: "flex", gap: 8, margin: "18px 0" }}>
          <TabBtn active={tab === "center"} onClick={() => setTab("center")}>
            센터 아동 <Badge>{cases.filter((c) => c.type === "center" && (isAdmin || c.owner === current.name)).length}</Badge>
          </TabBtn>
          <TabBtn active={tab === "pbs"} onClick={() => setTab("pbs")}>
            PBS 아동 <Badge>{cases.filter((c) => c.type === "pbs" && (isAdmin || c.owner === current.name)).length}</Badge>
          </TabBtn>
        </div>

        <CaseList
          tab={tab}
          isAdmin={isAdmin}
          cases={visible}
          onSelect={(id) => setSelectedId(id)}
          onAdd={(nc) => setCases((prev) => { hadCasesAtLoad.current = true; return [...prev, { ...nc, id: Date.now(), type: tab, owner: current.name, createdAt: today(), records: [], assessments: [] }]; })}
        />
      </div>

      <Footer />
    </div>
  );
}

// ── 인증 게이트: 최초 관리자 설정 / 로그인 ───────
function AuthGate({ adminHash, teachers, onSetupAdmin, onLogin }) {
  const needSetup = !adminHash;
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const doSetup = async () => {
    if (pw.length < 4) return setErr("비밀번호는 4자 이상이어야 해요.");
    if (pw !== pw2) return setErr("비밀번호가 서로 달라요.");
    setBusy(true);
    await onSetupAdmin(pw);
    setBusy(false);
    setPw(""); setPw2(""); setErr("");
  };

  const doLogin = async () => {
    setErr(""); setBusy(true);
    try {
      if (name.trim() === ADMIN_NAME) {
        if (await verifyPassword(pw, adminHash)) return onLogin({ role: "admin", name: ADMIN_NAME });
        return setErr("관리자 비밀번호가 맞지 않아요.");
      }
      const t = teachers.find((x) => x.name === name.trim());
      if (t && (await verifyPassword(pw, t.hash))) return onLogin({ role: "teacher", name: t.name });
      setErr("이름 또는 비밀번호가 맞지 않아요.");
    } finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(160deg, ${PKL} 0%, #fff 100%)`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Pretendard', -apple-system, sans-serif", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 370, background: "#fff", borderRadius: 20, padding: 32, boxShadow: "0 12px 40px rgba(212,114,138,0.15)" }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div style={{ width: 60, height: 60, margin: "0 auto 10px", borderRadius: 15, background: PKL, border: `2px solid ${PK}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            <img src={LOGO_B64} alt="검단ABA언어행동연구소 로고" style={{ width: "82%", height: "82%", objectFit: "contain" }} />
          </div>
          <div style={{ fontWeight: 800, fontSize: 20, color: INK }}>BIP Maker</div>
          <div style={{ fontSize: 13, color: MUTE, marginTop: 4 }}>도전행동 평가 · 중재 도구</div>
        </div>

        {needSetup ? (
          <>
            <div style={{ background: PKL, borderRadius: 10, padding: "10px 12px", fontSize: 12.5, color: PKD, marginBottom: 16, lineHeight: 1.5 }}>
              🔒 <b>처음 사용</b>이시군요! 관리자(센터장) 비밀번호를 먼저 설정해 주세요.
            </div>
            <Field label="새 관리자 비밀번호 (4자 이상)" value={pw} onChange={setPw} type="password" placeholder="비밀번호" />
            <Field label="비밀번호 확인" value={pw2} onChange={setPw2} type="password" placeholder="다시 입력" onEnter={doSetup} />
            {err && <div style={{ color: PKD, fontSize: 12, marginBottom: 8 }}>{err}</div>}
            <button onClick={doSetup} disabled={busy} style={{ ...btnPrimary, width: "100%", marginTop: 6, opacity: busy ? 0.6 : 1 }}>
              {busy ? "설정 중..." : "관리자 비밀번호 설정"}
            </button>
          </>
        ) : (
          <>
            <Field label="이름" value={name} onChange={setName} placeholder="이름" />
            <Field label="비밀번호" value={pw} onChange={setPw} type="password" placeholder="비밀번호" onEnter={doLogin} />
            {err && <div style={{ color: PKD, fontSize: 12, marginBottom: 8 }}>{err}</div>}
            <button onClick={doLogin} disabled={busy} style={{ ...btnPrimary, width: "100%", marginTop: 6, opacity: busy ? 0.6 : 1 }}>
              {busy ? "확인 중..." : "로그인"}
            </button>
          </>
        )}
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px dashed #e8d0d6", fontSize: 10.5, color: MUTE, textAlign: "center", lineHeight: 1.6 }}>
          {needSetup
            ? "이 비밀번호는 클라우드에 안전하게 저장되며, 어느 기기에서든 로그인할 수 있습니다."
            : "검단ABA언어행동연구소 · 도전행동 평가·중재 도구"}
        </div>
        <div style={{ marginTop: 12, fontSize: 10, color: "#bbb", textAlign: "center" }}>
          {COPYRIGHT}
        </div>
      </div>
    </div>
  );
}

// ── 헤더 ────────────────────────────────────────
function Header({ current, isAdmin, onLogout }) {
  return (
    <div style={{ background: "#fff", borderBottom: `1px solid ${PKL}`, position: "sticky", top: 0, zIndex: 10 }}>
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: PKL, border: `1.5px solid ${PK}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
          <img src={LOGO_B64} alt="로고" style={{ width: "82%", height: "82%", objectFit: "contain" }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>BIP Maker</div>
          <div style={{ fontSize: 11, color: MUTE }}>도전행동 평가 · 중재 도구</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: isAdmin ? PKD : INK }}>
            {isAdmin ? "👑 " : "👩‍🏫 "}{current.name}
          </div>
          <button onClick={onLogout} style={{ fontSize: 11, color: MUTE, background: "none", border: "none", cursor: "pointer", padding: 0, marginTop: 2 }}>
            로그아웃
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 관리자 패널: 선생님 계정 추가/삭제 ──────────
function AdminPanel({ teachers, onAddTeacher, onRemoveTeacher }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const add = async () => {
    if (!name.trim()) return setMsg("이름을 입력해 주세요.");
    if (pw.length < 4) return setMsg("비밀번호는 4자 이상이어야 해요.");
    if (name.trim() === ADMIN_NAME) return setMsg("'민다혜'는 선생님 이름으로 쓸 수 없어요.");
    setBusy(true);
    await onAddTeacher(name.trim(), pw);
    setBusy(false);
    setName(""); setPw(""); setMsg(`✓ ${name.trim()} 선생님 계정을 추가했어요.`);
  };

  return (
    <div style={{ background: "#fff", borderRadius: 14, marginTop: 18, boxShadow: "0 2px 12px rgba(212,114,138,0.06)", overflow: "hidden" }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: "100%", padding: "13px 16px", background: "none", border: "none", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14, fontWeight: 700, color: PKD }}>
        <span>⚙️ 선생님 계정 관리 <span style={{ color: MUTE, fontWeight: 400, fontSize: 12 }}>({teachers.length}명)</span></span>
        <span style={{ color: MUTE }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${PKL}` }}>
          <div style={{ display: "grid", gap: 6, margin: "12px 0" }}>
            {teachers.length === 0 && <div style={{ fontSize: 12.5, color: MUTE }}>아직 추가된 선생님이 없어요.</div>}
            {teachers.map((t) => (
              <div key={t.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: PKL, borderRadius: 8, padding: "8px 12px" }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>👩‍🏫 {t.name}</span>
                <button onClick={() => onRemoveTeacher(t.name)} style={{ fontSize: 11.5, color: PKD, background: "none", border: `1px solid ${PK}`, borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>삭제</button>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 120px" }}>
              <div style={{ fontSize: 11, color: MUTE, marginBottom: 4, fontWeight: 600 }}>선생님 이름</div>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 이선생" style={inputStyle} />
            </div>
            <div style={{ flex: "1 1 120px" }}>
              <div style={{ fontSize: 11, color: MUTE, marginBottom: 4, fontWeight: 600 }}>초기 비밀번호</div>
              <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="4자 이상" style={inputStyle} />
            </div>
            <button onClick={add} disabled={busy} style={{ ...btnPrimary, flexShrink: 0, opacity: busy ? 0.6 : 1 }}>
              {busy ? "..." : "추가"}
            </button>
          </div>
          {msg && <div style={{ fontSize: 12, color: msg.startsWith("✓") ? "#2e8b57" : PKD, marginTop: 8 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

// ── 케이스 목록 + 추가 ──────────────────────────
function CaseList({ tab, isAdmin, cases, onAdd, onSelect }) {
  const [adding, setAdding] = useState(false);
  const isPbs = tab === "pbs";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{isPbs ? "PBS 컨설팅 아동" : "센터 아동"} 목록</div>
        <button onClick={() => setAdding((v) => !v)} style={btnPrimary}>{adding ? "닫기" : "+ 새 케이스"}</button>
      </div>

      {adding && <AddForm isPbs={isPbs} onAdd={(c) => { onAdd(c); setAdding(false); }} />}

      {cases.length === 0 && !adding && (
        <div style={{ textAlign: "center", padding: "50px 20px", color: MUTE, background: "#fff", borderRadius: 16 }}>
          아직 등록된 케이스가 없어요.<br /><span style={{ fontSize: 13 }}>+ 새 케이스로 첫 아동을 추가해 보세요.</span>
        </div>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {cases.map((c) => <CaseCard key={c.id} c={c} isPbs={isPbs} isAdmin={isAdmin} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

function CaseCard({ c, isPbs, isAdmin, onSelect }) {
  const recCount = (c.records || []).length;
  return (
    <div onClick={() => onSelect(c.id)} style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 12px rgba(212,114,138,0.06)", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 16 }}>
          {c.name} <span style={{ fontSize: 12, color: MUTE, fontWeight: 400 }}>· {c.age}</span>
        </div>
        {isPbs && c.school && <div style={{ fontSize: 12, color: PKD, marginTop: 2 }}>{c.school}</div>}
        <div style={{ fontSize: 13, color: INK, marginTop: 6 }}>🎯 목표행동: <b>{c.target || "미설정"}</b></div>
        <div style={{ fontSize: 11, color: MUTE, marginTop: 4 }}>
          등록 {c.createdAt}{isAdmin && c.owner && ` · 담당 ${c.owner}`}
          {recCount > 0 && <span style={{ color: PKD }}> · 기록 {recCount}건</span>}
        </div>
      </div>
      <div style={{ color: PK, fontSize: 20 }}>›</div>
    </div>
  );
}

// ── 케이스 상세: ABC 기록 + 도전행동(횟수·강도) ──
const SEVERITY = [
  { v: "경도", label: "경도", desc: "파괴적이지만 위험은 거의 없음", color: "#7FB77E" },
  { v: "중등도", label: "중등도", desc: "재산 손해 또는 경미한 부상", color: "#E8A33D" },
  { v: "중도", label: "중도", desc: "보건·안전에 대한 중대한 위협", color: "#D85A5A" },
];

function CaseDetail({ c, isAdmin, onBack, onAddRecord, onRemoveRecord, onAddAssessment, onRemoveAssessment, onRemoveCase }) {
  const [showForm, setShowForm] = useState(false);
  const [section, setSection] = useState("record"); // record | assess | bip
  const [runningScale, setRunningScale] = useState(null); // 진행 중인 척도 id
  const [confirmDel, setConfirmDel] = useState(false);
  const [abcSubs, setAbcSubs] = useState([]);        // 받은 외부 ABC 제출
  const [abcSubsLoading, setAbcSubsLoading] = useState(false);
  const [abcImporting, setAbcImporting] = useState(null); // 반영 중인 sid
  const records = c.records || [];
  const assessments = c.assessments || [];
  const isPbs = c.type === "pbs";

  // 받은 외부 제출 중 ABC만 불러오기
  const loadAbcSubs = React.useCallback(async () => {
    setAbcSubsLoading(true);
    const list = await listExternalSubmissions(c.id);
    const abcOnly = (list || []).filter((s) => s.scaleId === "ABC");
    abcOnly.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    setAbcSubs(abcOnly);
    setAbcSubsLoading(false);
  }, [c.id]);

  useEffect(() => { loadAbcSubs(); }, [loadAbcSubs]);

  // 받은 ABC 1건 → 케이스 기록으로 반영 + 원본 삭제
  const importAbc = async (sub) => {
    setAbcImporting(sub.sid);
    const r = sub.record || {};
    onAddRecord({
      datetime: r.when || "",
      antecedent: r.antecedent || "",
      behavior: r.behavior || "",
      consequence: r.consequence || "",
      count: "1",
      severity: "",
      by: sub.writer || "외부",
      source: "external",
    });
    await deleteExternalSubmission(c.id, sub.sid);
    setAbcSubs((prev) => prev.filter((x) => x.sid !== sub.sid));
    setAbcImporting(null);
  };

  const dismissAbc = async (sub) => {
    await deleteExternalSubmission(c.id, sub.sid);
    setAbcSubs((prev) => prev.filter((x) => x.sid !== sub.sid));
  };

  // 요약 통계
  const totalCount = records.reduce((s, r) => s + (Number(r.count) || 1), 0);
  const sevCount = { 경도: 0, 중등도: 0, 중도: 0 };
  records.forEach((r) => { if (r.severity) sevCount[r.severity] = (sevCount[r.severity] || 0) + 1; });

  // 평가 진행 화면
  if (runningScale) {
    return (
      <AssessmentRunner
        scaleId={runningScale}
        childName={c.name}
        target={c.target}
        onCancel={() => setRunningScale(null)}
        onComplete={(asmt) => { onAddAssessment(asmt); setRunningScale(null); setSection("assess"); }}
      />
    );
  }

  return (
    <div>
      {/* 상단: 뒤로가기 + 삭제 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 0 10px" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: PKD, fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
          ‹ 목록으로
        </button>
        <button onClick={() => setConfirmDel(true)} style={{ background: "none", border: "none", color: MUTE, fontSize: 12.5, cursor: "pointer" }}>
          🗑 케이스 삭제
        </button>
      </div>

      {confirmDel && (
        <ConfirmModal
          title="케이스를 삭제할까요?"
          message={`'${c.name}' 케이스의 모든 기록·평가·중재안이 함께 삭제됩니다. 이 작업은 되돌릴 수 없어요.`}
          confirmLabel="삭제"
          onConfirm={onRemoveCase}
          onCancel={() => setConfirmDel(false)}
        />
      )}

      <div style={{ background: "#fff", borderRadius: 16, padding: 20, boxShadow: "0 2px 12px rgba(212,114,138,0.06)", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 20 }}>{c.name}</div>
            <div style={{ fontSize: 13, color: MUTE, marginTop: 3 }}>
              {c.birth ? `${c.birth} · ` : ""}{c.age}{isPbs && c.school ? ` · ${c.school}` : ""}
            </div>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: isPbs ? "#7B9BD8" : PK, padding: "4px 10px", borderRadius: 20 }}>
            {isPbs ? "PBS" : "센터"}
          </span>
        </div>
        <div style={{ marginTop: 12, padding: "10px 14px", background: PKL, borderRadius: 10, fontSize: 13.5 }}>
          🎯 목표행동: <b>{c.target || "미설정"}</b>
        </div>
        {isAdmin && c.owner && <div style={{ fontSize: 11, color: MUTE, marginTop: 8 }}>담당 {c.owner} · 등록 {c.createdAt}</div>}
      </div>

      {/* 섹션 전환 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <SectionBtn active={section === "record"} onClick={() => setSection("record")}>
          📋 기록 <Badge>{records.length}</Badge>
        </SectionBtn>
        <SectionBtn active={section === "assess"} onClick={() => setSection("assess")}>
          🧩 평가 <Badge>{assessments.length}</Badge>
        </SectionBtn>
        <SectionBtn active={section === "bip"} onClick={() => setSection("bip")}>
          📝 중재안
        </SectionBtn>
      </div>

      {section === "record" && (
        <>
          {/* 요약 카드 */}
          {records.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
              <StatBox label="총 발생" value={totalCount} unit="회" />
              <StatBox label="경도" value={sevCount.경도} unit="건" color="#7FB77E" />
              <StatBox label="중등도" value={sevCount.중등도} unit="건" color="#E8A33D" />
              <StatBox label="중도" value={sevCount.중도} unit="건" color="#D85A5A" />
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>도전행동 기록 <span style={{ color: MUTE, fontWeight: 400, fontSize: 13 }}>({records.length})</span></div>
            <button onClick={() => setShowForm((v) => !v)} style={btnPrimary}>{showForm ? "닫기" : "+ 기록 추가"}</button>
          </div>

          {showForm && <RecordForm onSave={(rec) => { onAddRecord(rec); setShowForm(false); }} />}

          <AbcLinkBox c={c} />

          {(abcSubsLoading || abcSubs.length > 0) && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, color: PKD }}>
                📩 받은 ABC 기록 <span style={{ color: MUTE, fontWeight: 400, fontSize: 12.5 }}>({abcSubs.length})</span>
                <button onClick={loadAbcSubs} style={{ ...btnGhost, padding: "3px 9px", fontSize: 11, marginLeft: 8 }}>새로고침</button>
              </div>
              {abcSubsLoading && <div style={{ fontSize: 12.5, color: MUTE, padding: "6px 2px" }}>불러오는 중...</div>}
              <div style={{ display: "grid", gap: 10 }}>
                {abcSubs.map((sub) => {
                  const r = sub.record || {};
                  return (
                    <div key={sub.sid} style={{ background: "#fff", borderRadius: 12, padding: 14, border: `1.5px solid ${PKL}`, boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
                      <div style={{ fontSize: 11.5, color: MUTE, marginBottom: 8 }}>
                        작성자 <b style={{ color: INK }}>{sub.writer || "외부"}</b>
                        {r.when ? ` · ${r.when}` : ""}
                        {sub.submittedAt ? ` · 제출 ${String(sub.submittedAt).slice(0, 10)}` : ""}
                      </div>
                      <div style={{ display: "grid", gap: 4, fontSize: 12.5, lineHeight: 1.6 }}>
                        {r.antecedent ? <div><b style={{ color: PKD }}>A</b> {r.antecedent}</div> : null}
                        {r.behavior ? <div><b style={{ color: PKD }}>B</b> {r.behavior}</div> : null}
                        {r.consequence ? <div><b style={{ color: PKD }}>C</b> {r.consequence}</div> : null}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <button onClick={() => dismissAbc(sub)} disabled={abcImporting === sub.sid} style={{ ...btnGhost, flex: 1, fontSize: 12.5 }}>삭제</button>
                        <button onClick={() => importAbc(sub)} disabled={abcImporting === sub.sid} style={{ ...btnPrimary, flex: 2, fontSize: 12.5, opacity: abcImporting === sub.sid ? 0.6 : 1 }}>
                          {abcImporting === sub.sid ? "반영 중..." : "이 기록에 반영하기"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {records.length === 0 && !showForm && (
            <div style={{ textAlign: "center", padding: "40px 20px", color: MUTE, background: "#fff", borderRadius: 16 }}>
              아직 기록이 없어요.<br /><span style={{ fontSize: 13 }}>+ 기록 추가로 도전행동을 관찰 기록해 보세요.</span>
            </div>
          )}

          <div style={{ display: "grid", gap: 10 }}>
            {records.map((r) => <RecordCard key={r.id} r={r} onRemove={() => onRemoveRecord(r.id)} />)}
          </div>
        </>
      )}

      {section === "assess" && (
        <AssessmentSection
          c={c}
          assessments={assessments}
          onStart={(scaleId) => setRunningScale(scaleId)}
          onRemove={onRemoveAssessment}
          onImport={onAddAssessment}
        />
      )}

      {section === "bip" && (
        <BIPSection c={c} assessments={assessments} />
      )}
    </div>
  );
}

function SectionBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: "11px 8px", borderRadius: 11, border: "none", cursor: "pointer",
      fontWeight: 700, fontSize: 13.5,
      background: active ? PKD : "#fff", color: active ? "#fff" : MUTE,
      boxShadow: active ? "0 3px 10px rgba(212,114,138,0.3)" : "0 1px 4px rgba(0,0,0,0.04)",
    }}>{children}</button>
  );
}

function StatBox({ label, value, unit, color = PKD }) {
  return (
    <div style={{ background: "#fff", borderRadius: 12, padding: "12px 8px", textAlign: "center", boxShadow: "0 2px 8px rgba(212,114,138,0.05)" }}>
      <div style={{ fontSize: 11, color: MUTE, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}<span style={{ fontSize: 11, fontWeight: 400, color: MUTE }}> {unit}</span></div>
    </div>
  );
}

// ── 기록 입력 폼 ────────────────────────────────
function RecordForm({ onSave }) {
  const [datetime, setDatetime] = useState("");
  const [antecedent, setAntecedent] = useState("");
  const [behavior, setBehavior] = useState("");
  const [consequence, setConsequence] = useState("");
  const [count, setCount] = useState("1");
  const [severity, setSeverity] = useState("");
  const [err, setErr] = useState("");
  const [photoState, setPhotoState] = useState("idle"); // idle | reading | error
  const [photoMsg, setPhotoMsg] = useState("");
  const fileRef = React.useRef(null);

  const onPhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (fileRef.current) fileRef.current.value = ""; // 같은 파일 재선택 허용
    if (!file) return;
    setPhotoState("reading"); setPhotoMsg(""); setErr("");
    try {
      const r = await readAbcPhoto(file);
      if (r.when) setDatetime(r.when);
      if (r.antecedent) setAntecedent(r.antecedent);
      if (r.behavior) setBehavior(r.behavior);
      if (r.consequence) setConsequence(r.consequence);
      setPhotoState("idle");
      setPhotoMsg("사진에서 내용을 불러왔어요. 확인 후 수정·저장해 주세요.");
    } catch (ex) {
      setPhotoState("error");
      setPhotoMsg(ex.message || "사진 인식에 실패했어요.");
    }
  };

  const save = () => {
    if (!behavior.trim()) return setErr("행동(B)은 꼭 입력해 주세요.");
    onSave({
      datetime, antecedent: antecedent.trim(), behavior: behavior.trim(),
      consequence: consequence.trim(), count: count || "1", severity,
    });
  };

  return (
    <div style={{ background: "#fff", borderRadius: 16, padding: 20, marginBottom: 16, boxShadow: "0 4px 20px rgba(212,114,138,0.1)", border: `1.5px solid ${PKL}` }}>
      <div style={{ fontWeight: 700, marginBottom: 14, color: PKD }}>새 도전행동 기록</div>

      <div style={{ marginBottom: 14 }}>
        <input ref={fileRef} type="file" accept="image/*" onChange={onPhoto} style={{ display: "none" }} />
        <button onClick={() => fileRef.current && fileRef.current.click()} disabled={photoState === "reading"}
          style={{ ...btnGhost, width: "100%", justifyContent: "center", padding: "10px", fontSize: 13, opacity: photoState === "reading" ? 0.6 : 1 }}>
          {photoState === "reading" ? "사진 읽는 중..." : "📷 사진으로 채우기 (손글씨·메모 인식)"}
        </button>
        {photoMsg ? (
          <div style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5, color: photoState === "error" ? "#D85A5A" : "#5C9A72" }}>{photoMsg}</div>
        ) : null}
      </div>

      <Field label="날짜 / 시간" value={datetime} onChange={setDatetime} placeholder="예: 5월 23일 3:00" />

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: MUTE, marginBottom: 5, fontWeight: 600 }}>선행사건 (A) — 행동 직전에 무슨 일이?</div>
        <textarea value={antecedent} onChange={(e) => setAntecedent(e.target.value)} placeholder="예: 수학 학습지를 꺼냄" style={{ ...inputStyle, minHeight: 44, resize: "vertical", fontFamily: "inherit" }} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: PKD, marginBottom: 5, fontWeight: 700 }}>행동 (B) — 관찰된 도전행동 *</div>
        <textarea value={behavior} onChange={(e) => setBehavior(e.target.value)} placeholder="예: 학습지를 찢음" style={{ ...inputStyle, minHeight: 44, resize: "vertical", fontFamily: "inherit", borderColor: PK }} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: MUTE, marginBottom: 5, fontWeight: 600 }}>후속결과 (C) — 행동 직후에 무슨 일이?</div>
        <textarea value={consequence} onChange={(e) => setConsequence(e.target.value)} placeholder="예: 타임아웃 시킴" style={{ ...inputStyle, minHeight: 44, resize: "vertical", fontFamily: "inherit" }} />
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 90px" }}>
          <div style={{ fontSize: 12, color: MUTE, marginBottom: 5, fontWeight: 600 }}>발생 횟수</div>
          <input type="number" min="1" value={count} onChange={(e) => setCount(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: "1 1 200px" }}>
          <div style={{ fontSize: 12, color: MUTE, marginBottom: 5, fontWeight: 600 }}>강도 (심각도)</div>
          <div style={{ display: "flex", gap: 6 }}>
            {SEVERITY.map((s) => (
              <button key={s.v} onClick={() => setSeverity(severity === s.v ? "" : s.v)} title={s.desc}
                style={{ flex: 1, padding: "9px 4px", borderRadius: 9, cursor: "pointer", fontSize: 12.5, fontWeight: 700,
                  border: `1.5px solid ${severity === s.v ? s.color : PKL}`,
                  background: severity === s.v ? s.color : "#fff",
                  color: severity === s.v ? "#fff" : MUTE }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {err && <div style={{ color: PKD, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <button onClick={save} style={{ ...btnPrimary, width: "100%" }}>기록 저장</button>
    </div>
  );
}

// ── 기록 카드 ───────────────────────────────────
function RecordCard({ r, onRemove }) {
  const sev = SEVERITY.find((s) => s.v === r.severity);
  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: MUTE }}>🕐 {r.datetime || "시간 미기록"}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {sev && <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: sev.color, padding: "2px 8px", borderRadius: 12 }}>{sev.label}</span>}
          <span style={{ fontSize: 11, fontWeight: 700, color: PKD, background: PKL, padding: "2px 8px", borderRadius: 12 }}>{r.count || 1}회</span>
          <button onClick={onRemove} style={{ fontSize: 11, color: MUTE, background: "none", border: "none", cursor: "pointer" }}>삭제</button>
        </div>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <AbcRow tag="A" label="선행사건" text={r.antecedent} color="#8AA9D6" />
        <AbcRow tag="B" label="행동" text={r.behavior} color={PKD} bold />
        <AbcRow tag="C" label="후속결과" text={r.consequence} color="#7FB77E" />
      </div>
    </div>
  );
}

function AbcRow({ tag, label, text, color, bold }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 6, background: color, color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{tag}</span>
      <div style={{ flex: 1 }}>
        <span style={{ fontSize: 11, color: MUTE }}>{label}</span>
        <div style={{ fontSize: 13.5, fontWeight: bold ? 700 : 400, color: text ? INK : MUTE }}>{text || "—"}</div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
//  간접평가 섹션 (목록 + 시작)
// ══════════════════════════════════════════════
function AssessmentSection({ c, assessments, onStart, onRemove, onImport }) {
  const [linkScale, setLinkScale] = useState(null); // 링크 만들 척도
  const [subs, setSubs] = useState([]);             // 받은 외부 제출
  const [subsLoading, setSubsLoading] = useState(false);
  const [importing, setImporting] = useState(null); // 반영 중인 sid

  const loadSubs = React.useCallback(async () => {
    setSubsLoading(true);
    const list = await listExternalSubmissions(c.id);
    // ABC 제출은 기록 탭에서 처리하므로 평가 탭에서는 척도 설문만
    const scaleOnly = (list || []).filter((s) => s.scaleId !== "ABC");
    // 최신순
    scaleOnly.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    setSubs(scaleOnly);
    setSubsLoading(false);
  }, [c.id]);

  useEffect(() => { loadSubs(); }, [loadSubs]);

  // 받은 설문 1건 → 채점해서 평가 결과로 반영 + 원본 삭제
  const importSub = async (sub) => {
    setImporting(sub.sid);
    const scored = scoreAssessment(sub.scaleId, sub.answers);
    onImport({
      scaleId: sub.scaleId,
      date: today(),
      answers: sub.answers,
      results: scored.results,
      sorted: scored.sorted,
      top: scored.top,
      writer: sub.writer,
      source: "external",
      preInfo: sub.preInfo,
    });
    await deleteExternalSubmission(c.id, sub.sid);
    setSubs((prev) => prev.filter((x) => x.sid !== sub.sid));
    setImporting(null);
  };

  const dismissSub = async (sub) => {
    await deleteExternalSubmission(c.id, sub.sid);
    setSubs((prev) => prev.filter((x) => x.sid !== sub.sid));
  };

  return (
    <div>
      {/* 척도 시작 버튼 */}
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>새 평가 시작</div>
      <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
        {SCALE_LIST.map((s) => (
          <div key={s.id} style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 16, color: PKD }}>{s.name}</div>
                <div style={{ fontSize: 12, color: MUTE, marginTop: 2 }}>{s.fullName}</div>
                <div style={{ fontSize: 11, color: MUTE, marginTop: 4 }}>
                  {s.items.length}문항 · {Object.keys(s.functions).length}기능 판정
                </div>
              </div>
              <button onClick={() => onStart(s.id)} style={btnPrimary}>시작 ›</button>
            </div>
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${PKL}`, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: MUTE, flex: 1 }}>👨‍👩‍👧 외부 교사·부모가 직접 작성하게 하려면</span>
              <button onClick={() => setLinkScale(linkScale === s.id ? null : s.id)} style={{ ...btnGhost, padding: "6px 12px", fontSize: 12 }}>
                🔗 작성 링크
              </button>
            </div>
            {linkScale === s.id && <ExternalLinkBox scale={s} c={c} />}
          </div>
        ))}
      </div>

      {/* 받은 설문 (외부 제출) */}
      {(subsLoading || subs.length > 0) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>
            📩 받은 설문 <span style={{ color: MUTE, fontWeight: 400, fontSize: 13 }}>({subs.length})</span>
            <button onClick={loadSubs} style={{ ...btnGhost, padding: "4px 10px", fontSize: 11, marginLeft: 8 }}>새로고침</button>
          </div>
          {subsLoading && <div style={{ fontSize: 12.5, color: MUTE, padding: "8px 2px" }}>불러오는 중...</div>}
          <div style={{ display: "grid", gap: 10 }}>
            {subs.map((sub) => {
              const sc = SCALES[sub.scaleId];
              return (
                <div key={sub.sid} style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 12px rgba(212,114,138,0.06)", border: `1.5px solid ${PKL}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 15, color: PKD }}>{sc ? sc.name : sub.scaleId}</div>
                      <div style={{ fontSize: 12, color: INK, marginTop: 3 }}>작성자: <b>{sub.writer || "미기재"}</b></div>
                      <div style={{ fontSize: 11, color: MUTE, marginTop: 2 }}>제출 {sub.submittedAt ? String(sub.submittedAt).slice(0, 10) : ""}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button onClick={() => dismissSub(sub)} disabled={importing === sub.sid} style={{ ...btnGhost, flex: 1 }}>삭제</button>
                    <button onClick={() => importSub(sub)} disabled={importing === sub.sid} style={{ ...btnPrimary, flex: 2, opacity: importing === sub.sid ? 0.6 : 1 }}>
                      {importing === sub.sid ? "반영 중..." : "결과로 반영하기"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 완료된 평가 결과 */}
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>완료된 평가 <span style={{ color: MUTE, fontWeight: 400, fontSize: 13 }}>({assessments.length})</span></div>
      {assessments.length === 0 && (
        <div style={{ textAlign: "center", padding: "36px 20px", color: MUTE, background: "#fff", borderRadius: 16 }}>
          아직 완료된 평가가 없어요.<br /><span style={{ fontSize: 13 }}>위에서 척도를 골라 평가를 시작해 보세요.</span>
        </div>
      )}
      <div style={{ display: "grid", gap: 10 }}>
        {assessments.map((a) => <AssessmentResultCard key={a.id} a={a} onRemove={() => onRemove(a.id)} />)}
      </div>
    </div>
  );
}

// ── FAST 앞부분(preInfo) 입력 필드 렌더러 (센터·외부 공용) ──
function PreInfoFields({ fields, values, onChange }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {fields.map((fld) => {
        const val = values[fld.key];
        if (fld.type === "checkbox") {
          const arr = Array.isArray(val) ? val : [];
          const toggle = (opt) => {
            const next = arr.includes(opt) ? arr.filter((x) => x !== opt) : [...arr, opt];
            onChange(fld.key, next);
          };
          return (
            <div key={fld.key} style={{ background: "#fff", borderRadius: 12, padding: "12px 14px", boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 8 }}>{fld.label}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {fld.options.map((opt) => {
                  const sel = arr.includes(opt);
                  return (
                    <button key={opt} onClick={() => toggle(opt)}
                      style={{ padding: "7px 12px", borderRadius: 9, fontSize: 12.5, cursor: "pointer", fontWeight: sel ? 700 : 400,
                        border: sel ? `1.5px solid ${PKD}` : "1.5px solid #eadfe2",
                        background: sel ? PKL : "#fff", color: sel ? PKD : INK }}>
                      {sel ? "✓ " : ""}{opt}
                    </button>
                  );
                })}
              </div>
              {fld.hint ? <div style={{ fontSize: 11, color: MUTE, marginTop: 8, lineHeight: 1.5 }}>{fld.hint}</div> : null}
            </div>
          );
        }
        if (fld.type === "radio") {
          return (
            <div key={fld.key} style={{ background: "#fff", borderRadius: 12, padding: "12px 14px", boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 8 }}>{fld.label}</div>
              <div style={{ display: "grid", gap: 6 }}>
                {fld.options.map((opt) => {
                  const sel = val === opt;
                  return (
                    <button key={opt} onClick={() => onChange(fld.key, opt)}
                      style={{ textAlign: "left", padding: "8px 12px", borderRadius: 9, fontSize: 12.5, cursor: "pointer", fontWeight: sel ? 700 : 400,
                        border: sel ? `1.5px solid ${PKD}` : "1.5px solid #eadfe2",
                        background: sel ? PKL : "#fff", color: sel ? PKD : INK }}>
                      {sel ? "● " : "○ "}{opt}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }
        if (fld.type === "textarea") {
          return (
            <div key={fld.key} style={{ background: "#fff", borderRadius: 12, padding: "12px 14px", boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 8 }}>{fld.label}</div>
              <textarea value={val || ""} onChange={(e) => onChange(fld.key, e.target.value)}
                placeholder={fld.placeholder || ""} rows={2}
                style={{ ...inputStyle, resize: "vertical", minHeight: 48, fontFamily: "inherit" }} />
            </div>
          );
        }
        // text (default)
        return (
          <div key={fld.key} style={{ background: "#fff", borderRadius: 12, padding: "12px 14px", boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 8 }}>{fld.label}</div>
            <input value={val || ""} onChange={(e) => onChange(fld.key, e.target.value)}
              placeholder={fld.placeholder || ""} style={inputStyle} />
          </div>
        );
      })}
    </div>
  );
}

// ── ABC 외부 작성 페이지 (로그인 없이, 여러 건 반복 제출) ─────
function AbcFillPage({ info }) {
  const [writer, setWriter] = useState("");
  const [antecedent, setAntecedent] = useState("");
  const [behavior, setBehavior] = useState("");
  const [consequence, setConsequence] = useState("");
  const [when, setWhen] = useState("");
  const [state, setState] = useState("form"); // form | saving | error
  const [errMsg, setErrMsg] = useState("");
  const [savedCount, setSavedCount] = useState(0);

  const pageWrap = { minHeight: "100vh", background: PKL, padding: 20, fontFamily: "'Pretendard', -apple-system, sans-serif" };

  if (!info) {
    return (
      <div style={{ ...pageWrap, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ background: "#fff", borderRadius: 16, padding: 28, maxWidth: 380, textAlign: "center" }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>😕</div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>링크가 올바르지 않아요</div>
          <div style={{ fontSize: 13, color: MUTE, lineHeight: 1.6 }}>링크가 손상되었거나 만료되었을 수 있어요. 보내주신 분께 새 링크를 요청해 주세요.</div>
        </div>
      </div>
    );
  }

  const submit = async () => {
    if (!writer.trim()) { setErrMsg("작성자 이름을 입력해 주세요."); return; }
    if (!behavior.trim()) { setErrMsg("행동(B) 내용을 입력해 주세요."); return; }
    setState("saving"); setErrMsg("");
    const res = await saveExternalSubmission(info.cid, {
      scaleId: "ABC", childName: info.cn, target: info.tg, writer: writer.trim(),
      record: {
        antecedent: antecedent.trim(),
        behavior: behavior.trim(),
        consequence: consequence.trim(),
        when: when.trim(),
      },
    });
    if (res) {
      setSavedCount((n) => n + 1);
      setAntecedent(""); setBehavior(""); setConsequence(""); setWhen("");
      setState("form");
    } else {
      setState("error"); setErrMsg("제출에 실패했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.");
    }
  };

  const field = (label, val, setter, ph, rows = 2) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 6 }}>{label}</div>
      <textarea value={val} onChange={(e) => setter(e.target.value)} placeholder={ph} rows={rows}
        style={{ ...inputStyle, resize: "vertical", minHeight: rows * 22, fontFamily: "inherit" }} />
    </div>
  );

  return (
    <div style={pageWrap}>
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <div style={{ background: "#fff", borderRadius: 16, padding: "20px 18px", marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: PKD }}>{info.cn} 아동 · ABC 관찰 기록</div>
          <div style={{ fontSize: 12.5, color: MUTE, marginTop: 4, lineHeight: 1.6 }}>
            문제 상황이 있을 때마다 <b>선행–행동–후속</b>을 기록해 주세요. 한 건 제출 후에도 이 창에서 계속 이어서 기록할 수 있어요.
          </div>
          {info.tg ? <div style={{ fontSize: 12, color: INK, marginTop: 8, padding: "6px 10px", background: PKL, borderRadius: 8 }}>관찰 대상 행동: <b>{info.tg}</b></div> : null}
        </div>

        {savedCount > 0 && (
          <div style={{ background: "#EAF5EC", border: "1px solid #7FB77E", borderRadius: 12, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#3A2C30" }}>
            ✅ 지금까지 <b>{savedCount}건</b> 제출됐어요. 계속 기록하셔도 됩니다.
          </div>
        )}

        <div style={{ background: "#fff", borderRadius: 16, padding: "18px 16px" }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 6 }}>작성자 이름</div>
            <input value={writer} onChange={(e) => setWriter(e.target.value)} placeholder="예: 김담임" style={inputStyle} />
          </div>
          {field("① 언제 (시간·상황)", when, setWhen, "예: 2교시 수학시간, 오전 10시경", 1)}
          {field("② 선행사건 A (행동 직전에 무슨 일이?)", antecedent, setAntecedent, "예: 어려운 문제를 풀라고 하자")}
          {field("③ 행동 B (관찰된 행동)", behavior, setBehavior, "예: 소리를 지르며 책상에 엎드림")}
          {field("④ 후속결과 C (행동 직후 어떻게 됐나?)", consequence, setConsequence, "예: 교사가 다가와 달래고 문제를 미룸")}

          {errMsg ? <div style={{ color: "#D85A5A", fontSize: 12.5, marginBottom: 10 }}>{errMsg}</div> : null}

          <button onClick={submit} disabled={state === "saving"}
            style={{ ...btnPrimary, width: "100%", padding: "12px", fontSize: 14, opacity: state === "saving" ? 0.6 : 1 }}>
            {state === "saving" ? "제출 중..." : "이 기록 제출하기"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 외부 작성 페이지 (로그인 없이, 링크로 접속) ─────
function ExternalFillPage({ token }) {
  const info = React.useMemo(() => decodeFillToken(token), [token]);
  // ABC 링크는 별도 페이지로 분기 (훅 호출 전에 처리)
  if (info && info.sc === "ABC") return <AbcFillPage info={info} />;
  return <ScaleFillPage info={info} />;
}

// ── 척도(설문) 외부 작성 페이지 ─────
function ScaleFillPage({ info }) {
  const scale = info ? SCALES[info.sc] : null;
  const [answers, setAnswers] = useState(() => (scale ? scale.items.map(() => null) : []));
  const [preInfo, setPreInfo] = useState({}); // FAST 앞부분 응답 (해당 척도에 preInfo 있을 때만)
  const [writer, setWriter] = useState("");
  const [state, setState] = useState("form"); // form | saving | done | error
  const [errMsg, setErrMsg] = useState("");
  const setPre = (k, v) => setPreInfo((prev) => ({ ...prev, [k]: v }));

  if (!info || !scale) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: PKL, padding: 20, fontFamily: "'Pretendard', -apple-system, sans-serif" }}>
        <div style={{ background: "#fff", borderRadius: 16, padding: 28, maxWidth: 380, textAlign: "center" }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>😕</div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>링크가 올바르지 않아요</div>
          <div style={{ fontSize: 13, color: MUTE, lineHeight: 1.6 }}>링크가 손상되었거나 만료되었을 수 있어요. 보내주신 분께 새 링크를 요청해 주세요.</div>
        </div>
      </div>
    );
  }

  const opts = SCALE_OPTIONS[scale.scale];
  const answeredCount = answers.filter((a) => a != null).length;

  const submit = async () => {
    if (!writer.trim()) { setErrMsg("작성자 이름을 입력해 주세요."); return; }
    setState("saving"); setErrMsg("");
    const res = await saveExternalSubmission(info.cid, {
      scaleId: info.sc, childName: info.cn, target: info.tg,
      writer: writer.trim(), answers,
      preInfo: (scale.preInfo && scale.preInfo.length) ? preInfo : undefined,
    });
    if (res) setState("done");
    else { setState("error"); setErrMsg("제출에 실패했어요. 인터넷 연결을 확인하고 다시 시도해 주세요."); }
  };

  if (state === "done") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: PKL, padding: 20, fontFamily: "'Pretendard', -apple-system, sans-serif" }}>
        <div style={{ background: "#fff", borderRadius: 16, padding: 32, maxWidth: 380, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>✅</div>
          <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>제출 완료</div>
          <div style={{ fontSize: 13.5, color: MUTE, lineHeight: 1.6 }}>{info.cn} 아동의 {scale.name} 설문이 제출되었어요.<br />창을 닫으셔도 됩니다. 감사합니다 🙏</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(160deg, ${PKL} 0%, #fff 100%)`, fontFamily: "'Pretendard', -apple-system, sans-serif", padding: "20px 16px 60px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ background: "#fff", borderRadius: 16, padding: 22, marginBottom: 14, boxShadow: "0 4px 20px rgba(212,114,138,0.1)" }}>
          <div style={{ fontWeight: 800, fontSize: 19, color: PKD }}>{scale.name}</div>
          <div style={{ fontSize: 12.5, color: MUTE, marginTop: 3 }}>{scale.fullName}</div>
          <div style={{ marginTop: 12, padding: "12px 14px", background: PKL, borderRadius: 10, fontSize: 13, color: INK, lineHeight: 1.6 }}>
            <b>{info.cn}</b> 아동{info.tg ? <> · 목표행동: <b>{info.tg}</b></> : null}에 대해, 아래 문항을 읽고 평소 모습에 가장 가까운 것을 골라주세요.
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: MUTE, marginBottom: 5, fontWeight: 600 }}>작성자 이름 <span style={{ color: PKD }}>*</span></div>
            <input value={writer} onChange={(e) => setWriter(e.target.value)} placeholder="예: 홍길동 (담임교사 / 어머니)" style={inputStyle} />
          </div>
        </div>

        {scale.preInfo && scale.preInfo.length ? (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: PKD, margin: "4px 2px 10px" }}>문제행동 정보</div>
            <PreInfoFields fields={scale.preInfo} values={preInfo} onChange={setPre} />
            <div style={{ fontSize: 13.5, fontWeight: 800, color: PKD, margin: "18px 2px 10px" }}>기능 평가 문항</div>
          </div>
        ) : null}

        <div style={{ display: "grid", gap: 10 }}>
          {scale.items.map((item, i) => (
            <div key={i} style={{ background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
              <div style={{ fontSize: 13.5, color: INK, lineHeight: 1.5, marginBottom: 10 }}>
                <span style={{ color: PKD, fontWeight: 700 }}>{i + 1}.</span> {item.q}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {opts.map((o) => {
                  const sel = answers[i] === o.v;
                  return (
                    <button key={o.v} onClick={() => setAnswers((prev) => { const n = [...prev]; n[i] = o.v; return n; })}
                      style={{ padding: "7px 12px", borderRadius: 9, fontSize: 12.5, cursor: "pointer", fontWeight: sel ? 700 : 400,
                        border: sel ? `1.5px solid ${PKD}` : "1.5px solid #eadfe2",
                        background: sel ? PKL : "#fff", color: sel ? PKD : INK }}>
                      {o.label}{o.hint ? <span style={{ fontSize: 10.5, color: MUTE, marginLeft: 3 }}>{o.hint}</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {errMsg && <div style={{ color: PKD, fontSize: 12.5, marginTop: 12, textAlign: "center" }}>{errMsg}</div>}

        <div style={{ position: "sticky", bottom: 0, marginTop: 16, padding: "12px 0", background: "linear-gradient(0deg, #fff 70%, transparent)" }}>
          <div style={{ fontSize: 11.5, color: MUTE, textAlign: "center", marginBottom: 8 }}>{answeredCount} / {scale.items.length} 문항 응답</div>
          <button onClick={submit} disabled={state === "saving"} style={{ ...btnPrimary, width: "100%", opacity: state === "saving" ? 0.6 : 1 }}>
            {state === "saving" ? "제출 중..." : "제출하기"}
          </button>
          <div style={{ fontSize: 10.5, color: MUTE, textAlign: "center", marginTop: 10 }}>{COPYRIGHT}</div>
        </div>
      </div>
    </div>
  );
}

// ── 외부 작성 링크 생성 박스 ────────────────────
function ExternalLinkBox({ scale, c }) {
  const [copied, setCopied] = useState(false);
  // 케이스 정보를 토큰에 담아 실제 작동하는 링크 생성
  const token = encodeFillToken({ cid: c.id, cn: c.name, tg: c.target || "", sc: scale.id });
  const base = (typeof window !== "undefined" && window.location)
    ? `${window.location.origin}${window.location.pathname}`
    : "https://aba-geomdan.github.io/bip-maker/";
  const url = `${base}#/fill/${scale.id.toLowerCase()}/${token}`;

  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div style={{ marginTop: 10, padding: "12px 14px", background: "#FFF9FA", border: `1px dashed ${PK}`, borderRadius: 10 }}>
      <div style={{ fontSize: 12, color: INK, lineHeight: 1.6, marginBottom: 8 }}>
        이 링크를 외부 교사·부모에게 보내면, 앱 설치 없이 <b>{scale.name}</b> 설문을 직접 작성하고 제출할 수 있어요. 제출 결과는 이 케이스에 들어옵니다.
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input readOnly value={url} style={{ ...inputStyle, fontSize: 11.5, color: MUTE }} onFocus={(e) => e.target.select()} />
        <button onClick={copy} style={{ ...btnPrimary, flexShrink: 0, padding: "8px 12px", fontSize: 12 }}>{copied ? "복사됨 ✓" : "복사"}</button>
      </div>
      <div style={{ fontSize: 11, color: MUTE, marginTop: 8, lineHeight: 1.5 }}>
        📩 제출된 설문은 <b>평가 탭</b> 아래 <b>받은 설문</b>에서 확인하고 결과로 반영할 수 있어요.
      </div>
    </div>
  );
}

// ── ABC 외부 작성 링크 박스 (기록 탭용) ──────────
function AbcLinkBox({ c }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const token = encodeFillToken({ cid: c.id, cn: c.name, tg: c.target || "", sc: "ABC" });
  const base = (typeof window !== "undefined" && window.location)
    ? `${window.location.origin}${window.location.pathname}`
    : "https://aba-geomdan.github.io/bip-maker/";
  const url = `${base}#/fill/abc/${token}`;

  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={() => setOpen((v) => !v)} style={{ ...btnGhost, width: "100%", justifyContent: "center", padding: "10px 12px", fontSize: 13 }}>
        {open ? "▲ 외부 작성 링크 닫기" : "🔗 외부 교사에게 ABC 기록 링크 보내기"}
      </button>
      {open && (
        <div style={{ marginTop: 10, padding: "12px 14px", background: "#FFF9FA", border: `1px dashed ${PK}`, borderRadius: 10 }}>
          <div style={{ fontSize: 12, color: INK, lineHeight: 1.6, marginBottom: 8 }}>
            이 링크를 외부 교사·부모에게 보내면, 앱 설치 없이 <b>{c.name}</b> 아동의 ABC(선행–행동–후속)를 직접 기록·제출할 수 있어요. <b>같은 링크를 계속 열어</b> 사건이 생길 때마다 한 건씩 제출하면 됩니다.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input readOnly value={url} style={{ ...inputStyle, fontSize: 11.5, color: MUTE }} onFocus={(e) => e.target.select()} />
            <button onClick={copy} style={{ ...btnPrimary, flexShrink: 0, padding: "8px 12px", fontSize: 12 }}>{copied ? "복사됨 ✓" : "복사"}</button>
          </div>
          <div style={{ fontSize: 11, color: MUTE, marginTop: 8, lineHeight: 1.5 }}>
            📩 제출된 기록은 아래 <b>받은 ABC 기록</b>에서 확인하고 이 케이스에 반영할 수 있어요.
          </div>
        </div>
      )}
    </div>
  );
}

// ── 완료된 평가 결과 카드 ────────────────────────
function AssessmentResultCard({ a, onRemove }) {
  const [open, setOpen] = useState(false);
  const [preOpen, setPreOpen] = useState(false);
  const scale = SCALES[a.scaleId];
  const maxSum = Math.max(...a.results.map((r) => r.sum), 1);
  // preInfo 중 값이 채워진 항목만 (라벨-값 쌍)
  const preRows = (scale.preInfo && a.preInfo)
    ? scale.preInfo
        .map((f) => {
          const v = a.preInfo[f.key];
          const text = Array.isArray(v) ? v.join(", ") : v;
          return text && String(text).trim() ? { label: f.label, text: String(text) } : null;
        })
        .filter(Boolean)
    : [];

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <span style={{ fontWeight: 800, fontSize: 15, color: PKD }}>{scale.name}</span>
          <span style={{ fontSize: 11, color: MUTE, marginLeft: 8 }}>{a.date}{a.by ? ` · ${a.by}` : ""}</span>
        </div>
        <button onClick={onRemove} style={{ fontSize: 11, color: MUTE, background: "none", border: "none", cursor: "pointer" }}>삭제</button>
      </div>

      {/* 주요 기능 강조 */}
      <div style={{ marginTop: 10, padding: "10px 14px", background: PKL, borderRadius: 10 }}>
        <span style={{ fontSize: 12, color: MUTE }}>추정 주요 기능 </span>
        <span style={{ fontSize: 15, fontWeight: 800, color: PKD }}>{a.top.name}</span>
        <span style={{ fontSize: 12, color: MUTE }}> (합계 {a.top.sum}점)</span>
      </div>

      <button onClick={() => setOpen((v) => !v)} style={{ marginTop: 10, fontSize: 12.5, color: PKD, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
        {open ? "▲ 기능별 점수 접기" : "▼ 기능별 점수 보기"}
      </button>

      {open && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {a.sorted.map((r, i) => (
            <div key={r.f}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
                <span style={{ fontWeight: i === 0 ? 700 : 400, color: i === 0 ? PKD : INK }}>
                  {i === 0 ? "🥇 " : `${i + 1}. `}{r.name}
                </span>
                <span style={{ color: MUTE }}>합계 {r.sum} · 평균 {r.avg.toFixed(1)}</span>
              </div>
              <div style={{ height: 8, background: PKL, borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${(r.sum / maxSum) * 100}%`, height: "100%", background: i === 0 ? PKD : PK, borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {preRows.length > 0 && (
        <>
          <button onClick={() => setPreOpen((v) => !v)} style={{ marginTop: 10, fontSize: 12.5, color: PKD, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
            {preOpen ? "▲ 문제행동 정보 접기" : "▼ 문제행동 정보 보기"}
          </button>
          {preOpen && (
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {preRows.map((row, i) => (
                <div key={i} style={{ background: PKL, borderRadius: 8, padding: "8px 12px" }}>
                  <div style={{ fontSize: 11, color: MUTE, marginBottom: 2 }}>{row.label}</div>
                  <div style={{ fontSize: 12.5, color: INK, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{row.text}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════
//  평가 진행 (문항 응답 → 채점)
// ══════════════════════════════════════════════
function AssessmentRunner({ scaleId, childName, target, onCancel, onComplete }) {
  const scale = SCALES[scaleId];
  const opts = SCALE_OPTIONS[scale.scale];
  const [answers, setAnswers] = useState(() => scale.items.map(() => null));
  const [preInfo, setPreInfo] = useState({}); // FAST 앞부분(해당 척도만)
  const [showResult, setShowResult] = useState(false);
  const [ocrState, setOcrState] = useState("idle"); // idle | loading | done | error
  const [ocrMsg, setOcrMsg] = useState("");
  const setPre = (k, v) => setPreInfo((prev) => ({ ...prev, [k]: v }));

  const answered = answers.filter((a) => a != null && a !== "").length;
  const allDone = answered === scale.items.length;

  const setAnswer = (i, v) => setAnswers((prev) => { const n = [...prev]; n[i] = v; return n; });

  const finish = () => setShowResult(true);

  const result = showResult ? scoreAssessment(scaleId, answers) : null;

  // 종이 설문 사진 → AI가 읽어서 응답 자동 채움
  const onPhoto = async (file) => {
    if (!file) return;
    setOcrState("loading"); setOcrMsg("사진을 읽는 중이에요...");
    try {
      const filled = await readAssessmentPhoto(scaleId, file);
      setAnswers((prev) => {
        const n = [...prev];
        let cnt = 0;
        filled.forEach((v, i) => { if (v != null && i < n.length) { n[i] = v; cnt++; } });
        setOcrMsg(`✓ ${cnt}개 문항을 자동으로 채웠어요. 빈 문항이나 틀린 곳은 직접 확인·수정해 주세요.`);
        return n;
      });
      setOcrState("done");
    } catch (e) {
      setOcrMsg(e.message || "사진 인식에 실패했어요. 직접 입력해 주세요.");
      setOcrState("error");
    }
  };

  if (showResult && result) {
    const maxSum = Math.max(...result.results.map((r) => r.sum), 1);
    return (
      <div>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: PKD, fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "16px 0 10px" }}>‹ 취소</button>
        <div style={{ background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 2px 12px rgba(212,114,138,0.06)", textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 30, marginBottom: 6 }}>✅</div>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{scale.name} 평가 완료</div>
          <div style={{ fontSize: 13, color: MUTE, marginTop: 4 }}>{childName} · {target}</div>
          <div style={{ marginTop: 16, padding: "14px 16px", background: PKL, borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: MUTE }}>추정 주요 기능</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: PKD, marginTop: 2 }}>{result.top.name}</div>
            <div style={{ fontSize: 12, color: MUTE, marginTop: 2 }}>합계 {result.top.sum}점 · 평균 {result.top.avg.toFixed(1)}</div>
          </div>
        </div>

        <div style={{ background: "#fff", borderRadius: 16, padding: 20, boxShadow: "0 2px 12px rgba(212,114,138,0.06)", marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>기능별 점수</div>
          <div style={{ display: "grid", gap: 10 }}>
            {result.sorted.map((r, i) => (
              <div key={r.f}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
                  <span style={{ fontWeight: i === 0 ? 700 : 400, color: i === 0 ? PKD : INK }}>{i === 0 ? "🥇 " : `${i + 1}. `}{r.name}</span>
                  <span style={{ color: MUTE }}>합계 {r.sum} · 평균 {r.avg.toFixed(1)}</span>
                </div>
                <div style={{ height: 10, background: PKL, borderRadius: 5, overflow: "hidden" }}>
                  <div style={{ width: `${(r.sum / maxSum) * 100}%`, height: "100%", background: i === 0 ? PKD : PK, borderRadius: 5 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ ...btnGhost, flex: 1 }}>취소</button>
          <button onClick={() => onComplete({
            scaleId, date: today(), answers,
            results: result.results, sorted: result.sorted, top: result.top,
            preInfo: (scale.preInfo && scale.preInfo.length) ? preInfo : undefined,
          })} style={{ ...btnPrimary, flex: 2 }}>이 결과 저장하기</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onCancel} style={{ background: "none", border: "none", color: PKD, fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "16px 0 10px" }}>‹ 취소</button>

      {/* 헤더 + 진행률 */}
      <div style={{ background: "#fff", borderRadius: 16, padding: 18, boxShadow: "0 2px 12px rgba(212,114,138,0.06)", marginBottom: 16, position: "sticky", top: 62, zIndex: 5 }}>
        <div style={{ fontWeight: 800, fontSize: 17, color: PKD }}>{scale.name}</div>
        <div style={{ fontSize: 12, color: MUTE, marginTop: 2 }}>{scale.fullName}</div>
        <div style={{ fontSize: 12, color: INK, marginTop: 8 }}>대상: <b>{childName}</b> · 목표행동: <b>{target}</b></div>
        <div style={{ marginTop: 10, height: 8, background: PKL, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${(answered / scale.items.length) * 100}%`, height: "100%", background: PK, borderRadius: 4, transition: "width .2s" }} />
        </div>
        <div style={{ fontSize: 11, color: MUTE, marginTop: 5, textAlign: "right" }}>{answered} / {scale.items.length} 문항</div>
      </div>

      {/* 척도 안내 */}
      <div style={{ background: "#FFF9FA", borderRadius: 10, padding: "10px 14px", fontSize: 11.5, color: MUTE, marginBottom: 14, lineHeight: 1.6 }}>
        {scale.scale === "yn" && "각 문항에 예 / 아니오 / 해당없음으로 답해 주세요."}
        {scale.scale === "q0123" && "각 상황에서 목표행동이 얼마나 자주 나타나는지 선택하세요. (X 해당없음 · 0 전혀아님 ~ 3 자주)"}
        {scale.scale === "s0to6" && "각 문항에서 목표행동이 얼마나 자주 나타나는지 선택하세요. (0 전혀아님 ~ 6 언제나)"}
      </div>

      {/* 종이 설문 사진 자동입력 */}
      <div style={{ background: "#fff", borderRadius: 12, padding: 14, marginBottom: 14, border: `1.5px dashed ${PK}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 18 }}>📷</span>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: PKD }}>종이 설문 사진으로 자동입력</div>
            <div style={{ fontSize: 11, color: MUTE, marginTop: 2 }}>외부에서 받은 종이 설문을 찍어 올리면 AI가 응답을 채워요.</div>
          </div>
          <label style={{ ...btnPrimary, cursor: ocrState === "loading" ? "wait" : "pointer", opacity: ocrState === "loading" ? 0.6 : 1, display: "inline-block" }}>
            {ocrState === "loading" ? "읽는 중..." : "사진 올리기"}
            <input type="file" accept="image/*" style={{ display: "none" }} disabled={ocrState === "loading"}
              onChange={(e) => onPhoto(e.target.files && e.target.files[0])} />
          </label>
        </div>
        {ocrMsg && (
          <div style={{ marginTop: 10, fontSize: 12, color: ocrState === "error" ? "#C04040" : ocrState === "done" ? "#2e8b57" : MUTE, lineHeight: 1.5 }}>
            {ocrMsg}
          </div>
        )}
      </div>

      {/* FAST 앞부분 정보 (해당 척도만) */}
      {scale.preInfo && scale.preInfo.length ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: PKD, margin: "4px 2px 10px" }}>문제행동 정보</div>
          <PreInfoFields fields={scale.preInfo} values={preInfo} onChange={setPre} />
          <div style={{ fontSize: 13.5, fontWeight: 800, color: PKD, margin: "18px 2px 10px" }}>기능 평가 문항</div>
        </div>
      ) : null}

      {/* 문항 */}
      <div style={{ display: "grid", gap: 10 }}>
        {scale.items.map((item, i) => (
          <div key={i} style={{ background: "#fff", borderRadius: 12, padding: 14, boxShadow: "0 1px 6px rgba(212,114,138,0.05)", border: answers[i] != null ? `1.5px solid ${PKL}` : `1.5px solid transparent` }}>
            <div style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 10 }}>
              <span style={{ color: PK, fontWeight: 800 }}>{i + 1}.</span> {item.q}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {opts.map((o) => (
                <button key={o.v} onClick={() => setAnswer(i, o.v)} title={o.hint || ""}
                  style={{
                    flex: scale.scale === "yn" ? 1 : "0 0 auto", minWidth: scale.scale === "yn" ? 0 : 42,
                    padding: "9px 10px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700,
                    border: `1.5px solid ${answers[i] === o.v ? PKD : PKL}`,
                    background: answers[i] === o.v ? PKD : "#fff",
                    color: answers[i] === o.v ? "#fff" : MUTE,
                  }}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 하단 완료 버튼 */}
      <div style={{ marginTop: 18, position: "sticky", bottom: 0, paddingBottom: 8 }}>
        <button onClick={finish} disabled={!allDone}
          style={{ ...btnPrimary, width: "100%", padding: "14px", fontSize: 15, opacity: allDone ? 1 : 0.5, cursor: allDone ? "pointer" : "not-allowed" }}>
          {allDone ? "채점하고 결과 보기" : `${scale.items.length - answered}문항 더 응답해 주세요`}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
//  중재안(BIP) 섹션 — 템플릿 기반 생성
// ══════════════════════════════════════════════
function BIPSection({ c, assessments }) {
  const agg = aggregateFunction(assessments);
  const [chosenFunc, setChosenFunc] = useState(null);

  // 평가가 없으면 안내
  if (!agg || !agg.primary) {
    return (
      <div style={{ textAlign: "center", padding: "40px 20px", color: MUTE, background: "#fff", borderRadius: 16 }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>🧩</div>
        중재안을 만들려면 먼저 <b style={{ color: PKD }}>간접평가</b>를 1개 이상 완료해 주세요.<br />
        <span style={{ fontSize: 13 }}>평가 결과의 주요 기능에 맞춰 중재안이 자동 생성됩니다.</span>
      </div>
    );
  }

  // 사용할 기능: 사용자가 고른 것 우선, 없으면 집계 1위
  const activeFunc = chosenFunc || agg.primary;
  const bip = generateBIP(activeFunc, c.name, c.target, c.type);

  return (
    <div>
      {/* 평가 요약 */}
      <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 12px rgba(212,114,138,0.06)", marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>📊 평가 종합 ({assessments.length}개)</div>
        <div style={{ display: "grid", gap: 6 }}>
          {agg.detail.map((d, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
              <span style={{ color: MUTE }}>{SCALES[d.scale].name}</span>
              <span style={{ fontWeight: 600 }}>{d.raw} → {UNIFIED_FUNC_NAME[d.func].split(" (")[0]}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, padding: "8px 12px", background: PKL, borderRadius: 8, fontSize: 12.5 }}>
          종합 추정 주요기능: <b style={{ color: PKD }}>{UNIFIED_FUNC_NAME[agg.primary].split(" (")[0]}</b>
          {agg.detail.length > 1 && agg.ranked[1][1] > 0 && (
            <span style={{ color: MUTE }}> (평가 간 결과가 나뉘면 아래에서 기능을 직접 선택하세요)</span>
          )}
        </div>
      </div>

      {/* 기능 선택 (평가 결과가 갈릴 때 수동 조정) */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: MUTE, marginBottom: 6, fontWeight: 600 }}>중재 대상 기능 선택</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 6 }}>
          {Object.keys(UNIFIED_FUNC_NAME).map((f) => (
            <button key={f} onClick={() => setChosenFunc(f)}
              style={{ padding: "10px 8px", borderRadius: 9, cursor: "pointer", fontSize: 12.5, fontWeight: 700,
                border: `1.5px solid ${activeFunc === f ? PKD : PKL}`,
                background: activeFunc === f ? PKD : "#fff",
                color: activeFunc === f ? "#fff" : MUTE,
                position: "relative" }}>
              {UNIFIED_FUNC_NAME[f].split(" (")[0]}
              {agg.tally[f] > 0 && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.8 }}>({agg.tally[f]})</span>}
            </button>
          ))}
        </div>
      </div>

      {/* 생성된 BIP */}
      <BIPDocument bip={bip} c={c} />
    </div>
  );
}

// ── BIP 문서 렌더 ───────────────────────────────
function BIPDocument({ bip, c, agg }) {
  const [aiState, setAiState] = useState("idle"); // idle | loading | done | error
  const [aiBip, setAiBip] = useState(null); // { antecedent:[], replacement:[], consequence:[] } — 있으면 템플릿 대신 사용
  const [aiErr, setAiErr] = useState("");
  const [viewMode, setViewMode] = useState("expert"); // expert | parent
  const [parentAi, setParentAi] = useState(null); // AI가 변환한 부모님용 { why, prevent, teach, respond }
  const [parentAiState, setParentAiState] = useState("idle"); // idle | loading | error
  const [parentAiErr, setParentAiErr] = useState("");
  const parentContent = parentAi || PARENT_BIP[bip.func] || PARENT_BIP.sensory;

  const runParentAI = async () => {
    setParentAiState("loading"); setParentAiErr("");
    try {
      const r = await enhanceParentBIP(bip, c);
      setParentAi(r);
      setParentAiState("idle");
    } catch (e) {
      setParentAiErr(e.message || "AI 변환 중 문제가 발생했어요.");
      setParentAiState("error");
    }
  };
  const clearParentAI = () => { setParentAi(null); setParentAiState("idle"); setParentAiErr(""); };

  const usingAi = !!aiBip;
  // 표시용: AI 결과가 있으면 AI 것, 없으면 템플릿
  const showAnt = usingAi ? aiBip.antecedent : bip.antecedent;
  const showRep = usingAi ? aiBip.replacement : bip.replacement;
  const showCon = usingAi ? aiBip.consequence : bip.consequence;

  const copyText = () => {
    if (viewMode === "parent") {
      const pc = parentContent;
      const nm = displayName(c.name);
      const lines = [
        `[ ${nm} 가정 지원 안내 ]`,
        "",
        `🤔 ${nm}는 왜 이런 행동을 할까요?`,
        pc.why,
        "",
        "🌱 미리 예방해요",
        ...pc.prevent.map((t, i) => `${i + 1}. ${t}`),
        "",
        "💬 다른 행동을 가르쳐요",
        ...pc.teach.map((t, i) => `${i + 1}. ${t}`),
        "",
        "🤗 이렇게 반응해주세요",
        ...pc.respond.map((t, i) => `${i + 1}. ${t}`),
        "",
        "검단ABA언어행동연구소",
      ];
      if (navigator.clipboard) navigator.clipboard.writeText(lines.join("\n"));
      return;
    }
    const b2 = usingAi ? { ...bip, antecedent: showAnt, replacement: showRep, consequence: showCon } : bip;
    const txt = bipToText(b2, c, agg) + (usingAi ? "\n\n※ 이 계획은 AI가 아동 정보를 반영해 생성했습니다. 전문가 검토 후 사용하세요." : "");
    if (navigator.clipboard) navigator.clipboard.writeText(txt);
  };

  const buildHtml = () => {
    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const tierName = { primary: "1차 기능", secondary: "2차 기능", tertiary: "별도 기능" };
    const fn = (f) => (UNIFIED_FUNC_NAME[f] || f).split(" (")[0];
    const tiers = (agg && agg.tiers ? agg.tiers.filter((t) => t.tier !== "minor") : []);
    const li = (arr) => arr.map((t) => `<div class="item">${esc(t)}</div>`).join("");
    const title = bip.setting === "school" ? "개별 행동중재계획서 (PBIP)" : "행동중재계획 (BIP)";
    const aiBadge = usingAi ? `<span style="display:inline-block;background:#F0E8FB;color:#8A6FB0;font-size:10px;padding:2px 8px;border-radius:4px;margin-left:8px;font-weight:700;">AI 맞춤 생성</span>` : "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(c.name)}_BIP</title>
<style>
*{box-sizing:border-box;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}
@media print{*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}}
body{font-family:'맑은 고딕','Malgun Gothic',sans-serif;color:#3A2C30;line-height:1.7;padding:40px;max-width:740px;margin:auto;}
.topbar{height:6px;background:linear-gradient(90deg,#D4728A,#F5A0B1);border-radius:3px;margin-bottom:18px;}
.brandrow{display:flex;align-items:center;gap:12px;margin-bottom:14px;}
.brandrow img{width:52px;height:52px;object-fit:contain;}
.brandrow .bt{font-size:13px;font-weight:700;color:#C4557A;letter-spacing:.5px;}
.brandrow .bs{font-size:10px;color:#B08A94;margin-top:1px;}
.infobox{display:flex;flex-wrap:wrap;gap:0;border:1.5px solid #F3C9D5;border-radius:10px;overflow:hidden;margin-bottom:26px;}
.infobox .cell{display:flex;min-width:33.33%;flex:1;}
.infobox .ck{background:#FFF0F3;color:#C4557A;font-weight:700;font-size:12px;padding:10px 12px;min-width:56px;display:flex;align-items:center;}
.infobox .cv{padding:10px 12px;font-size:12.5px;display:flex;align-items:center;flex:1;background:#fff;}
h1{font-size:22px;font-weight:800;letter-spacing:-.5px;color:#3A2C30;margin:0 0 6px;}
.subline{font-size:11.5px;color:#B08A94;letter-spacing:.4px;margin-bottom:26px;padding-bottom:14px;border-bottom:1px solid #F3E3E8;}
.sec{margin-bottom:22px;}
.secH{display:flex;align-items:center;gap:10px;background:linear-gradient(90deg,#FFF0F3,#FFF9FA 80%);border-left:4px solid #D4728A;border-radius:0 8px 8px 0;padding:9px 14px;margin-bottom:12px;break-inside:avoid;}
.secH .n{background:#D4728A;color:#fff;min-width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;}
.secH .t{font-size:14.5px;font-weight:800;color:#C4557A;}
.item{position:relative;padding:11px 14px 11px 30px;background:#FFFBFC;border:1px solid #F5E4EA;border-radius:9px;font-size:13px;line-height:1.65;margin-bottom:7px;break-inside:avoid;}
.item::before{content:"";position:absolute;left:13px;top:16px;width:7px;height:7px;border-radius:50%;background:#F5A0B1;}
.hyp{background:linear-gradient(135deg,#FFF0F3,#FFF6F8);border:1px solid #F3C9D5;border-radius:10px;padding:15px 17px;font-size:13.5px;line-height:1.7;margin:10px 0;}
.hyp b{color:#C4557A;}
.meta{font-size:13px;margin:6px 0;padding:0 2px;}
.meta b{color:#3A2C30;}
.tier{display:inline-block;background:#D4728A;color:#fff;font-size:11px;padding:2px 10px;border-radius:20px;margin-right:6px;font-weight:600;}
.foot{margin-top:34px;border-top:2px solid #F5A0B1;padding-top:12px;color:#B5A8AD;font-size:10.5px;text-align:center;letter-spacing:.3px;}
</style></head><body>
<div class="topbar"></div>
<div class="brandrow"><img src="${LOGO_B64}" alt="로고"/><div><div class="bt">검단ABA언어행동연구소</div><div class="bs">개별화된 데이터 기반 중재 · 언어/행동 통합적 접근</div></div></div>
<h1>${title}${aiBadge}</h1>
<div class="infobox">
<div class="cell"><div class="ck">대상</div><div class="cv">${esc(c.name)}${(c.age || c.school) ? " (" + [c.age, c.school].filter(Boolean).join(", ") + ")" : ""}</div></div>
<div class="cell"><div class="ck">환경</div><div class="cv">${bip.setting === "school" ? "학교 (통합/특수 학급)" : "ABA 센터"}</div></div>
<div class="cell"><div class="ck">작성</div><div class="cv">${todayKr()}</div></div>
</div>

<div class="sec">
<div class="secH"><span class="n">1</span><span class="t">행동의 기능 및 가설</span></div>
<div class="meta"><b>표적행동</b> · ${esc(c.target)}</div>
<div class="meta">${tiers.map((t) => `<span class="tier">${tierName[t.tier]}</span>${fn(t.func)} — ${esc(FUNC_HYPOTHESIS_SHORT[t.func])}`).join("<br>")}</div>
<div class="hyp"><b>주 기능: ${esc(bip.funcName)}</b><br>${esc(bip.hypothesis)}</div>
<div class="meta"><b>행동의 의미</b><br>${esc(FUNC_MEANING(bip.func, c.name, c.target, bip.setting))}</div>
</div>

<div class="sec">
<div class="secH"><span class="n">2</span><span class="t">선행중재 (예방 전략)</span></div>
${li(showAnt)}
</div>

<div class="sec">
<div class="secH"><span class="n">3</span><span class="t">대체행동중재 (교수 전략)</span></div>
${li(showRep)}
</div>

<div class="sec">
<div class="secH"><span class="n">4</span><span class="t">후속결과중재 (반응 전략)</span></div>
${li(showCon)}
</div>

<div class="sec">
<div class="secH"><span class="n">5</span><span class="t">시각지원 자료 (인쇄용)</span></div>
${getVisualCards(bip.func).map((card) => visualCardToHtml(card, esc)).join("")}
</div>

${usingAi ? `<div style="font-size:10.5px;color:#9A8A8F;font-style:italic;margin-top:8px;">※ 본 계획의 중재안(2~4)은 AI가 아동 정보를 반영해 생성했습니다. 전문가 검토 후 사용하세요.</div>` : ""}
<div class="foot">© 검단ABA언어행동연구소 (민다혜). All rights reserved.</div>
</body></html>`;
  };

  const buildParentHtml = () => {
    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const nm = displayName(c.name);
    const pc = parentContent;
    const listBlock = (emoji, title, items, accent, bg) => `
<div class="pblock">
  <div class="ph"><span class="pe">${emoji}</span><span class="pt" style="color:${accent}">${esc(title)}</span></div>
  ${items.map((t, i) => `<div class="pitem" style="background:${bg}"><span class="pn" style="color:${accent}">${i + 1}</span><span>${esc(t)}</span></div>`).join("")}
</div>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(c.name)}_가정지원안내</title>
<style>
*{box-sizing:border-box;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}
@media print{*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}}
body{font-family:'맑은 고딕','Malgun Gothic',sans-serif;color:#3A2C30;line-height:1.7;padding:40px;max-width:720px;margin:auto;}
.topbar{height:6px;background:linear-gradient(90deg,#D4728A,#F5A0B1);border-radius:3px;margin-bottom:18px;}
.brandrow{display:flex;align-items:center;gap:12px;margin-bottom:14px;}
.brandrow img{width:50px;height:50px;object-fit:contain;}
.brandrow .bt{font-size:13px;font-weight:700;color:#C4557A;}
.brandrow .bs{font-size:10px;color:#B08A94;margin-top:1px;}
h1{font-size:21px;font-weight:800;color:#3A2C30;margin:0 0 4px;}
.intro{font-size:12.5px;color:#9A7A82;background:#FFF9FA;border-radius:10px;padding:11px 14px;margin:14px 0 22px;line-height:1.7;}
.pblock{margin-bottom:20px;break-inside:avoid;}
.ph{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.pe{font-size:20px;}
.pt{font-size:15.5px;font-weight:800;}
.pdesc{font-size:13.5px;line-height:1.85;border-radius:12px;padding:15px 17px;}
.pitem{display:flex;gap:11px;font-size:13.5px;line-height:1.75;border-radius:12px;padding:13px 15px;margin-bottom:8px;break-inside:avoid;}
.pn{flex-shrink:0;font-weight:800;}
.foot{margin-top:32px;border-top:2px solid #F5A0B1;padding-top:12px;color:#B5A8AD;font-size:10.5px;text-align:center;}
</style></head><body>
<div class="topbar"></div>
<div class="brandrow"><img src="${LOGO_B64}" alt="로고"/><div><div class="bt">검단ABA언어행동연구소</div><div class="bs">개별화된 데이터 기반 중재 · 언어/행동 통합적 접근</div></div></div>
<h1>${esc(nm)} 가정 지원 안내</h1>
<div class="intro">💛 이 안내는 <b>${esc(nm)} 부모님</b>을 위해 쉽게 풀어 쓴 가정 지원 자료예요. 집에서 이렇게 도와주시면 ${esc(nm)}에게 큰 힘이 됩니다.</div>
<div class="pblock">
  <div class="ph"><span class="pe">🤔</span><span class="pt" style="color:#D4728A">${esc(nm)}는 왜 이런 행동을 할까요?</span></div>
  <div class="pdesc" style="background:#FFF0F3">${esc(pc.why)}</div>
</div>
${listBlock("🌱", "미리 예방해요 (이렇게 해보세요)", pc.prevent, "#5C9A72", "#F0F7F1")}
${listBlock("💬", "다른 행동을 가르쳐요", pc.teach, "#5B7BB5", "#EEF3FB")}
${listBlock("🤗", "이렇게 반응해주세요", pc.respond, "#C99A4B", "#FFF6EC")}
<div class="foot">© 검단ABA언어행동연구소 (민다혜). All rights reserved.</div>
</body></html>`;
  };

  const [printWarn, setPrintWarn] = useState(false);
  const doPrint = () => {
    setPrintWarn(false);
    const w = window.open("", "_blank");
    if (!w) { setPrintWarn(true); return; }
    w.document.write(viewMode === "parent" ? buildParentHtml() : buildHtml());
    w.document.close();
    setTimeout(() => w.print(), 400);
  };

  const runAI = async () => {
    setAiState("loading"); setAiErr("");
    try {
      const result = await enhanceBIPWithAI(bip, c);
      setAiBip(result);
      setAiState("done");
    } catch (e) {
      setAiErr(e.message || "AI 생성 중 문제가 발생했어요. 다시 시도해 주세요.");
      setAiState("error");
    }
  };

  const clearAI = () => { setAiBip(null); setAiState("idle"); setAiErr(""); };

  return (
    <div style={{ background: "#fff", borderRadius: 16, padding: 22, boxShadow: "0 2px 12px rgba(212,114,138,0.06)" }}>
      {/* 전문가용 ↔ 부모님용 토글 */}
      <div style={{ display: "flex", background: PKL, borderRadius: 10, padding: 4, marginBottom: 12 }}>
        <button onClick={() => setViewMode("expert")} style={{ flex: 1, padding: "8px 12px", fontSize: 13, fontWeight: 700, border: "none", borderRadius: 7, cursor: "pointer", background: viewMode === "expert" ? "#fff" : "transparent", color: viewMode === "expert" ? PKD : MUTE, boxShadow: viewMode === "expert" ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>👩‍⚕️ 전문가용</button>
        <button onClick={() => setViewMode("parent")} style={{ flex: 1, padding: "8px 12px", fontSize: 13, fontWeight: 700, border: "none", borderRadius: 7, cursor: "pointer", background: viewMode === "parent" ? "#fff" : "transparent", color: viewMode === "parent" ? PKD : MUTE, boxShadow: viewMode === "parent" ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>👨‍👩‍👧 부모님용</button>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 4 }}>
        <button onClick={copyText} style={{ ...btnGhost, padding: "6px 12px", fontSize: 12 }}>📋 복사</button>
        <button onClick={doPrint} style={{ ...btnPrimary, padding: "6px 12px", fontSize: 12 }}>📄 PDF 저장</button>
      </div>
      {printWarn && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "#FFF0F0", border: "1px solid #F0B0B0", borderRadius: 10, padding: "10px 12px", marginBottom: 10, fontSize: 12.5, color: "#C04040", lineHeight: 1.6 }}>
          <span style={{ flexShrink: 0 }}>⚠️</span>
          <span>팝업이 차단되어 새 창을 열 수 없어요. 주소창 오른쪽의 팝업 차단 아이콘에서 <b>이 사이트 팝업 허용</b>을 선택한 뒤 다시 눌러 주세요.</span>
          <button onClick={() => setPrintWarn(false)} style={{ marginLeft: "auto", flexShrink: 0, background: "none", border: "none", color: "#C04040", cursor: "pointer", fontSize: 14 }}>✕</button>
        </div>
      )}
      {/* 대상 정보 표 */}
      <div style={{ border: `1px solid ${PKL}`, borderRadius: 10, overflow: "hidden", marginBottom: 12, marginTop: 6 }}>
        <InfoRow label="대상" value={`${c.name}${(c.age||c.school)? " ("+[c.age,c.school].filter(Boolean).join(", ")+")":""}`} />
        <InfoRow label="환경" value={bip.setting === "school" ? "학교 (통합/특수 학급)" : "ABA 센터"} />
        <InfoRow label="작성" value={`검단ABA언어행동연구소 · ${todayKr()}`} last />
      </div>

      <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: bip.setting === "school" ? "#5B7BB5" : PKD, background: bip.setting === "school" ? "#EEF3FB" : PKL, padding: "5px 11px", borderRadius: 20, marginBottom: 16 }}>
        {bip.setting === "school" ? "🏫 학교(PBS) 맞춤 — 개별교수 제약 반영" : "🏛 센터(ABA) 맞춤"}
      </div>

      {viewMode === "parent" ? (
        <>
        <ParentView content={parentContent} childName={c.name} />
        <div style={{ marginTop: 16, borderTop: `1px dashed ${PKL}`, paddingTop: 16 }}>
          {!parentAi && (
            <>
              <button onClick={runParentAI} disabled={parentAiState === "loading"} style={{ ...btnPrimary, width: "100%", opacity: parentAiState === "loading" ? 0.6 : 1 }}>
                {parentAiState === "loading" ? "✨ AI가 이 아이 맞게 쓰는 중..." : "✨ AI로 우리 아이 맞춤 안내 만들기"}
              </button>
              <div style={{ fontSize: 11, color: MUTE, textAlign: "center", marginTop: 8, lineHeight: 1.5 }}>
                위 기본 안내는 즉시 제공돼요. AI 맞춤은 눌렀을 때만, 이 아이의 기록·정보를 반영해 더 자연스럽게 써줍니다.
              </div>
            </>
          )}
          {parentAiState === "error" && (
            <div style={{ marginTop: 10, padding: "10px 14px", background: "#FFF0F0", border: "1px solid #F0B0B0", borderRadius: 10, fontSize: 12.5, color: "#C04040" }}>{parentAiErr}</div>
          )}
          {parentAi && (
            <div style={{ padding: "12px 14px", background: "#F5F0FA", border: "1px solid #D9C9F0", borderRadius: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 15 }}>✨</span>
                <span style={{ fontWeight: 700, fontSize: 14, color: "#6B5B8A" }}>AI 맞춤 안내 표시 중</span>
                <button onClick={runParentAI} disabled={parentAiState === "loading"} style={{ marginLeft: "auto", fontSize: 11, color: "#8A6FB0", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>{parentAiState === "loading" ? "쓰는 중..." : "↻ 다시"}</button>
                <button onClick={clearParentAI} style={{ fontSize: 11, color: MUTE, background: "none", border: "none", cursor: "pointer" }}>기본으로</button>
              </div>
            </div>
          )}
        </div>
        </>
      ) : (
      <>
      <BIPBlock num="1" title="행동의 기능 및 가설" accent>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 5 }}>표적행동 (도전적 행동)</div>
          <div style={{ padding: "10px 12px", background: "#FFF9FA", borderRadius: 8, fontSize: 13, lineHeight: 1.6 }}>
            {c.target || "목표행동 미설정"}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 6 }}>기능 가설</div>
          <div style={{ display: "grid", gap: 8 }}>
            {agg && agg.tiers.filter((t) => t.tier === "primary" || t.tier === "secondary" || t.tier === "tertiary").map((t) => (
              <div key={t.func} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: "#fff", background: TIER_COLOR[t.tier], padding: "3px 9px", borderRadius: 10, minWidth: 58, textAlign: "center", marginTop: 1 }}>
                  {TIER_LABEL[t.tier]}
                </span>
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                  <b style={{ color: PKD }}>{UNIFIED_FUNC_NAME[t.func].split(" (")[0]}</b>
                  {" — "}{FUNC_HYPOTHESIS_SHORT[t.func]}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: "12px 14px", background: PKL, borderRadius: 10, fontSize: 13.5, lineHeight: 1.7, marginBottom: 12 }}>
          <span style={{ fontWeight: 700, color: PKD }}>주 기능: {bip.funcName}</span><br />
          {bip.hypothesis}
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 5 }}>행동의 의미</div>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: INK }}>
            {FUNC_MEANING(bip.func, c.name, c.target, bip.setting)}
          </div>
        </div>
      </BIPBlock>

      <BIPBlock num="2" title="선행중재 (예방 전략)">
        <BulletList items={showAnt} />
      </BIPBlock>

      <BIPBlock num="3" title="대체행동중재 (교수 전략)">
        <BulletList items={showRep} />
      </BIPBlock>

      <BIPBlock num="4" title="후속결과중재 (반응 전략)">
        <BulletList items={showCon} />
      </BIPBlock>

      <BIPBlock num="5" title="시각지원 자료 (인쇄용)">
        <div style={{ fontSize: 12, color: MUTE, marginBottom: 12, lineHeight: 1.6 }}>
          이 기능에 맞춰 자동 생성된 시각카드예요. 화면 그대로 인쇄해 교실·가정에서 사용할 수 있어요.
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          {getVisualCards(bip.func).map((card, i) => <VisualCard key={i} card={card} />)}
        </div>
      </BIPBlock>

      {/* AI 맞춤 생성 */}
      <div style={{ marginTop: 18, borderTop: `1px dashed ${PKL}`, paddingTop: 16 }}>
        {!usingAi && (
          <>
            <button onClick={runAI} disabled={aiState === "loading"} style={{ ...btnPrimary, width: "100%", opacity: aiState === "loading" ? 0.6 : 1 }}>
              {aiState === "loading" ? "✨ AI가 이 아동에 맞게 작성 중..." : "✨ AI로 이 아동 맞춤 BIP 생성하기"}
            </button>
            <div style={{ fontSize: 11, color: MUTE, textAlign: "center", marginTop: 8, lineHeight: 1.5 }}>
              위 기본 중재안은 크레딧 없이 즉시 생성돼요. AI 맞춤 생성은 눌렀을 때만, 케이스의 ABC 기록·평가 정보를 반영해 중재안을 새로 작성합니다.
            </div>
          </>
        )}

        {aiState === "error" && (
          <div style={{ marginTop: 10, padding: "10px 14px", background: "#FFF0F0", border: "1px solid #F0B0B0", borderRadius: 10, fontSize: 12.5, color: "#C04040" }}>
            {aiErr}
          </div>
        )}

        {usingAi && (
          <div style={{ padding: "12px 14px", background: "#F5F0FA", border: "1px solid #D9C9F0", borderRadius: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 15 }}>✨</span>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#6B5B8A" }}>AI 맞춤 생성본 표시 중</span>
              <button onClick={runAI} disabled={aiState === "loading"} style={{ marginLeft: "auto", fontSize: 11, color: "#8A6FB0", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>
                {aiState === "loading" ? "생성 중..." : "↻ 다시 생성"}
              </button>
              <button onClick={clearAI} style={{ fontSize: 11, color: MUTE, background: "none", border: "none", cursor: "pointer" }}>기본으로</button>
            </div>
            <div style={{ fontSize: 11, color: "#8A6FB0", marginTop: 8, lineHeight: 1.6 }}>
              2~4번 중재안이 이 아동 정보(ABC 기록·평가)를 반영한 AI 생성본으로 바뀌었어요. <b>전문가 검토 후 사용</b>하세요. PDF·복사에도 이 내용이 반영됩니다.
            </div>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}

// ── Claude API 호출: 이 아동 맞춤 BIP 전체 재작성 ───
async function enhanceBIPWithAI(bip, c) {
  const isPbs = c.type === "pbs";

  // 케이스에 쌓인 ABC 기록을 요약해 프롬프트에 반영 (있으면)
  const records = (c.records || []).slice(0, 12);
  let abcSummary = "기록 없음";
  if (records.length) {
    abcSummary = records.map((r, i) =>
      `${i + 1}) ${[r.datetime && `[${r.datetime}]`, r.antecedent && `선행:${r.antecedent}`, r.behavior && `행동:${r.behavior}`, r.consequence && `후속:${r.consequence}`].filter(Boolean).join(" ")}`
    ).join("\n");
  }

  // 위험 행동이면 안전 계획을 포함하도록 지시 (표적행동 문자열 기반 추정)
  const target = String(c.target || "");
  const isRisky = /공격|자해|폭력|던지|때리|물기|머리|위험|난폭|소리지르|이탈|도주|뛰쳐/.test(target);
  const displayNm = (() => {
    const raw = (c.name || "").trim();
    if (!raw) return "아동";
    const allHangul = [...raw].every((ch) => { const x = ch.charCodeAt(0); return x >= 0xac00 && x <= 0xd7a3; });
    if (!allHangul) return raw;
    let g = raw.length >= 3 ? raw.slice(1) : raw;
    const last = g.charCodeAt(g.length - 1);
    const hasJong = (last - 0xac00) % 28 !== 0;
    return hasJong ? g + "이" : g;
  })();

  const prompt = `당신은 ABA(응용행동분석) 전문가입니다. 아래 정보를 바탕으로 이 아동에게 딱 맞는 행동중재계획(BIP)의 세 영역(선행중재·대체행동중재·후속결과중재)을 작성하세요.

[아동 정보]
- 이름: ${c.name} (문장에서 아동을 지칭할 때는 "${displayNm}"로 부르고, 한국어 조사를 올바르게 붙이세요. 예: "${displayNm}는", "${displayNm}가")
- 연령/학년: ${c.age || "미기재"}
- 환경: ${isPbs ? `학교(${c.school || "일반학교"})` : "ABA 센터 (1:1 치료 가능)"}
- 표적행동: ${c.target || "미기재"}${c.behaviorDetail ? `\n- 행동의 구체적 모습: ${c.behaviorDetail}` : ""}${c.likes ? `\n- 좋아하는 것(강화제로 활용): ${c.likes}` : ""}${c.comm ? `\n- 의사소통 수준: ${c.comm}` : ""}${c.triggers ? `\n- 심해지는·진정되는 상황: ${c.triggers}` : ""}

[기능평가 결과]
- 추정 주기능: ${bip.funcName}
- 기능 가설: ${bip.hypothesis}

[실제 관찰기록 (ABC)]
${abcSummary}

[작성 지침]

■ 각 영역의 역할 (반드시 구분해서 작성)
- 선행중재(antecedent): 행동이 일어나기 '전에' 환경·상황을 바꿔 도전행동의 동기 자체를 낮추는 예방 전략. (동기조작, 환경조정, 예측가능성 제공 등)
- 대체행동중재(replacement): 도전행동과 '같은 기능'을 하되 사회적으로 수용 가능하고 더 효율적인 행동을 '가르치는' 교수 전략. ★핵심: 대체행동은 반드시 표적행동과 동일한 기능(같은 강화를 얻음)을 해야 하며, 도전행동보다 쉽고 빠르게 그 강화를 얻을 수 있어야 한다(반응효율성).
- 후속결과중재(consequence): 행동이 일어난 '후에' 어떻게 반응할지 — 적절행동은 강화하고, 도전행동은 강화하지 않는(소거) 전략.

■ 품질 기준 (아래 대조를 반드시 지킬 것)
- 나쁜 예(추상적, 금지): "유사한 감각을 주는 활동을 환경에 풍부하게 배치한다"
- 좋은 예(구체적, 권장): "착석 자리에 커튼과 비슷한 촉감의 술 리본을 붙여, 자리를 뜨지 않고도 촉각을 얻게 한다"
- 즉 '무엇을 / 언제 / 어떻게'가 드러나고, 이 아동의 실제 상황(관찰기록·표적행동)에 밀착된 문장을 쓸 것. 교과서적 일반론은 금지.

■ 개별화 지침
- 위 ABC 기록에서 드러나는 이 아동의 구체적 패턴(어떤 자극/상황에서, 무엇을 하고, 어떤 결과가 따르는지)을 반드시 반영하세요. 기록이 있으면 일반론이 아니라 "이 아이"의 사례에 근거해 쓰세요.
- 표적행동('${c.target || "미기재"}')이 위 추정 주기능(${bip.funcName})을 어떻게 충족하는지 구체적으로 해석하고, 그 해석에 맞는 중재를 쓰세요. 관찰기록이 있으면 그 기록에서 근거를 찾으세요.
${c.likes ? `- 강화(보상)가 필요한 부분에서는 이 아이가 좋아하는 것(${c.likes})을 구체적으로 활용해 쓰세요.\n` : ""}${c.comm ? `- 대체행동·의사소통 방법은 이 아이의 의사소통 수준(${c.comm})에 맞춰 쓰세요. 수준을 넘는 방법(예: 무발화 아동에게 긴 문장 말하기)은 피하세요.\n` : ""}${c.triggers ? `- 이 아이가 심해지거나 진정되는 상황(${c.triggers})을 선행중재에 반드시 반영하세요.\n` : ""}- ${c.age ? `아동의 연령/언어수준(${c.age})에 맞는 대체행동과 의사소통 방법을 쓰세요.` : "연령 정보가 없으니 일반적 수준으로 쓰되 과하게 어렵지 않게."}
- ${isPbs
  ? "학교 상황입니다. 교사 1명이 학급 전체를 지도하므로 1:1 개별개입이 어렵습니다. 선행조정·환경세팅·또래활용·학급차원 지원·자기관리 위주로 교사가 혼자 실행 가능하게 쓰세요."
  : "ABA 센터로 치료사가 1:1 지도 가능한 환경입니다."}
${isRisky ? "- 이 표적행동은 안전 위험이 있을 수 있습니다. 후속결과중재에 위기 상황 대응·안전 확보(주변 정리, 위해 예방, 진정 절차 등) 항목을 최소 1개 포함하세요.\n" : ""}
■ 형식·용어
- 각 영역당 3~4개 항목. 각 항목은 관찰·측정 가능하게(누가 봐도 실행 여부를 판단할 수 있게) 한 문장으로 쓰세요. 모호한 표현("적절히", "충분히", "잘") 대신 구체적 조건·빈도·방법을 명시하세요. 문장은 간결하게(한 항목이 너무 길지 않게).
- 올바른 ABA 용어를 정확히 사용하세요(NCR, FCT, DRA, DRO, 촉구·용암, 행동탄력, 소거, 프리맥 등). 단, 용어만 나열하지 말고 이 아동에게 실제로 어떻게 적용하는지를 함께 쓰세요.
- 관찰기록이 없으면, 표적행동과 기능가설만으로 최대한 구체적으로 추정해 쓰되 무리한 단정은 피하세요.

반드시 아래 형식의 JSON 객체만 출력하세요(설명·마크다운·서론 절대 금지):
{"antecedent":["...","..."],"replacement":["...","..."],"consequence":["...","..."]}`;

  const SUPABASE_FN_URL = "https://vdubgrxwijydwfabwpnk.supabase.co/functions/v1/claude-relay";
  const res = await fetch(SUPABASE_FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ prompt, max_tokens: 1500 }),
  });
  if (!res.ok) {
    let msg = "AI 서버 응답 오류";
    try { const e = await res.json(); if (e.error) msg = e.error; } catch (_) {}
    throw new Error(msg);
  }
  const data = await res.json();
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
    : (data.text || "");

  // JSON 파싱 → 실패 시 잘린 응답도 최대한 복구
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const arr = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

  let result = null;
  // 1차: 정상 JSON 파싱 시도
  try {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      result = { antecedent: arr(parsed.antecedent), replacement: arr(parsed.replacement), consequence: arr(parsed.consequence) };
    }
  } catch (_) { result = null; }

  // 2차: 정상 파싱 실패(응답 잘림 등) → 각 배열을 정규식으로 부분 추출
  if (!result || (!result.antecedent.length && !result.replacement.length && !result.consequence.length)) {
    const pick = (key) => {
      const m = cleaned.match(new RegExp('"' + key + '"\\s*:\\s*\\[([\\s\\S]*?)(\\]|$)'));
      if (!m) return [];
      // "문자열" 항목들만 추출 (마지막 미완성 토막은 제외)
      const items = m[1].match(/"((?:[^"\\]|\\.)*)"/g) || [];
      return items.map((s) => { try { return JSON.parse(s); } catch { return s.replace(/^"|"$/g, ""); } }).map((x) => String(x).trim()).filter(Boolean);
    };
    result = { antecedent: pick("antecedent"), replacement: pick("replacement"), consequence: pick("consequence") };
  }

  if (!result.antecedent.length && !result.replacement.length && !result.consequence.length) {
    throw new Error("AI가 내용을 생성하지 못했어요. 다시 시도해 주세요.");
  }
  return result;
}

// ── 부모님용 쉬운 안내를 AI가 이 아이 맞춤으로 재작성 ───
async function enhanceParentBIP(bip, c) {
  const records = (c.records || []).slice(0, 12);
  let abcSummary = "기록 없음";
  if (records.length) {
    abcSummary = records.map((r, i) =>
      `${i + 1}) ${[r.datetime && `[${r.datetime}]`, r.antecedent && `상황:${r.antecedent}`, r.behavior && `행동:${r.behavior}`, r.consequence && `그후:${r.consequence}`].filter(Boolean).join(" ")}`
    ).join("\n");
  }
  const displayNm = (() => {
    const raw = (c.name || "").trim();
    if (!raw) return "아이";
    const allHangul = [...raw].every((ch) => { const x = ch.charCodeAt(0); return x >= 0xac00 && x <= 0xd7a3; });
    if (!allHangul) return raw;
    let g = raw.length >= 3 ? raw.slice(1) : raw;
    const last = g.charCodeAt(g.length - 1);
    return ((last - 0xac00) % 28 !== 0) ? g + "이" : g;
  })();

  const prompt = `당신은 따뜻한 ABA 부모교육 전문가입니다. 아래 아이의 정보를 바탕으로, 부모님이 집에서 읽고 바로 실천할 수 있는 쉬운 가정 지원 안내를 작성하세요.

[아이 정보]
- 이름(애칭): ${displayNm}
- 나이: ${c.age || "미기재"}
- 문제 행동: ${c.target || "미기재"}${c.behaviorDetail ? `\n- 구체적 모습: ${c.behaviorDetail}` : ""}${c.likes ? `\n- 좋아하는 것: ${c.likes}` : ""}${c.comm ? `\n- 의사소통 수준: ${c.comm}` : ""}${c.triggers ? `\n- 심해지는·진정되는 상황: ${c.triggers}` : ""}
- 행동의 이유(기능): ${bip.funcName} — ${bip.hypothesis}

[집에서의 관찰기록]
${abcSummary}

[작성 지침]
- 전문용어(NCR, DRA, 소거, 촉구 등)를 절대 쓰지 마세요. 대신 부모님이 이해할 쉬운 말로 풀어 쓰세요.
- 따뜻하고 격려하는 말투("~해주세요", "~하면 좋아요")로 쓰세요. 부모를 탓하는 느낌이 들지 않게.
- 위 관찰기록이 있으면 그 상황을 예로 들어 구체적으로 쓰세요.
- 아이를 "${displayNm}"로 부르고 한국어 조사를 올바르게 쓰세요.
- why: 이 행동을 왜 하는지 2~3문장으로 따뜻하게 설명(말썽이 아니라 마음의 표현이라는 관점).
- prevent(미리 예방): 집에서 미리 할 수 있는 구체적 방법 3~4개.
- teach(다른 행동 가르치기): 적절한 표현·행동을 가르치는 방법 2~3개.
- respond(반응 방법): 문제행동과 바른행동에 어떻게 반응할지 2~3개.
- prevent/teach/respond의 각 항목은 한 문장으로 구체적이고 실천 가능하게.

반드시 아래 JSON 형식만 출력하세요(설명·마크다운 절대 금지):
{"why":"...","prevent":["...","..."],"teach":["...","..."],"respond":["...","..."]}`;

  const SUPABASE_FN_URL = "https://vdubgrxwijydwfabwpnk.supabase.co/functions/v1/claude-relay";
  const res = await fetch(SUPABASE_FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ prompt, max_tokens: 1500 }),
  });
  if (!res.ok) {
    let msg = "AI 서버 응답 오류";
    try { const e = await res.json(); if (e.error) msg = e.error; } catch (_) {}
    throw new Error(msg);
  }
  const data = await res.json();
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
    : (data.text || "");
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const arr = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

  let out = null;
  try {
    const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
    if (s !== -1 && e !== -1 && e > s) {
      const p = JSON.parse(cleaned.slice(s, e + 1));
      out = { why: String(p.why || "").trim(), prevent: arr(p.prevent), teach: arr(p.teach), respond: arr(p.respond) };
    }
  } catch (_) { out = null; }

  // 잘린 응답 복구
  if (!out || (!out.why && !out.prevent.length && !out.teach.length && !out.respond.length)) {
    const pickStr = (k) => { const m = cleaned.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1].replace(/\\"/g, '"') : ""; };
    const pickArr = (k) => {
      const m = cleaned.match(new RegExp('"' + k + '"\\s*:\\s*\\[([\\s\\S]*?)(\\]|$)'));
      if (!m) return [];
      return (m[1].match(/"((?:[^"\\]|\\.)*)"/g) || []).map((s) => { try { return JSON.parse(s); } catch { return s.replace(/^"|"$/g, ""); } }).map((x) => String(x).trim()).filter(Boolean);
    };
    out = { why: pickStr("why"), prevent: pickArr("prevent"), teach: pickArr("teach"), respond: pickArr("respond") };
  }

  if (!out.why && !out.prevent.length && !out.teach.length && !out.respond.length) {
    throw new Error("AI가 내용을 생성하지 못했어요. 다시 시도해 주세요.");
  }
  // 빈 항목은 기존 템플릿으로 보완
  const base = PARENT_BIP[bip.func] || PARENT_BIP.sensory;
  return {
    why: out.why || base.why,
    prevent: out.prevent.length ? out.prevent : base.prevent,
    teach: out.teach.length ? out.teach : base.teach,
    respond: out.respond.length ? out.respond : base.respond,
  };
}

// ── 종이 설문 사진 인식 (Claude 비전) ───────────
// 이미지 + 문항목록 → 각 문항 응답값 배열(JSON)
async function readAssessmentPhoto(scaleId, file) {
  const scale = SCALES[scaleId];
  const opts = SCALE_OPTIONS[scale.scale];
  const validValues = opts.map((o) => o.v).join(", ");

  // 파일 → base64
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("사진을 불러오지 못했어요."));
    r.readAsDataURL(file);
  });
  const mediaType = file.type || "image/jpeg";

  const itemsText = scale.items.map((it, i) => `${i + 1}. ${it.q}`).join("\n");
  const scaleGuide =
    scale.scale === "yn" ? "각 문항 응답은 'yes'(예), 'no'(아니오), 'na'(해당없음) 중 하나."
    : scale.scale === "q0123" ? "각 문항 응답은 'x'(해당없음), '0','1','2','3' 중 하나."
    : "각 문항 응답은 '0','1','2','3','4','5','6' 중 하나.";

  const promptText = `이 이미지는 '${scale.name}' 도전행동 간접평가 설문지를 작성한 것입니다.
아래 ${scale.items.length}개 문항 각각에 대해, 이미지에서 체크/표시된 응답을 읽어주세요.

[문항 목록]
${itemsText}

[응답 규칙]
${scaleGuide}
- 유효한 응답값: ${validValues}
- 이미지에서 명확히 읽히지 않는 문항은 null.

반드시 아래 형식의 JSON 배열만 출력하세요(설명·마크다운 금지). 길이는 정확히 ${scale.items.length}:
[{"n":1,"v":"응답값 또는 null"}, ...]`;

  // 배포 환경: 공용 claude-relay Edge Function 사용 (이미지 지원 버전)
  let raw;
  const SUPABASE_FN_URL = "https://vdubgrxwijydwfabwpnk.supabase.co/functions/v1/claude-relay";
  const res = await fetch(SUPABASE_FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ prompt: promptText, image: { media_type: mediaType, data: base64 }, max_tokens: 1500 }),
  });
  if (!res.ok) {
    let msg = "사진 인식 서버 오류";
    try { const e = await res.json(); if (e.error) msg = e.error; } catch (_) {}
    throw new Error(msg);
  }
  {
    const data = await res.json();
    raw = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : (data.text || "");
  }

  // JSON 파싱 → answers 배열로 변환
  const cleaned = String(raw).replace(/```json|```/g, "").trim();
  let parsed;
  try {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new Error("사진에서 응답을 해석하지 못했어요. 더 선명한 사진으로 다시 시도하거나 직접 입력해 주세요.");
  }

  const validSet = new Set(opts.map((o) => o.v));
  const answers = scale.items.map(() => null);
  parsed.forEach((row) => {
    const idx = (Number(row.n) || 0) - 1;
    const v = row.v;
    if (idx >= 0 && idx < answers.length && v != null && validSet.has(String(v))) {
      answers[idx] = String(v);
    }
  });
  return answers;
}

// ── ABC 관찰기록 사진 인식 → {when, antecedent, behavior, consequence} ──
async function readAbcPhoto(file) {
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("사진을 불러오지 못했어요."));
    r.readAsDataURL(file);
  });
  const mediaType = file.type || "image/jpeg";

  const promptText = `이 이미지는 아동의 도전행동을 관찰 기록한 ABC 기록지(또는 손으로 쓴 메모)입니다.
이미지에서 다음 항목을 읽어 정리해 주세요.

- when: 언제/어떤 상황(시간·수업·장소 등). 없으면 빈 문자열.
- antecedent: 선행사건 A (행동 직전에 일어난 일). 없으면 빈 문자열.
- behavior: 행동 B (관찰된 도전행동). 없으면 빈 문자열.
- consequence: 후속결과 C (행동 직후 일어난 일/어른의 반응). 없으면 빈 문자열.

[규칙]
- 이미지에 적힌 내용을 최대한 그대로 옮기되, 문장은 자연스럽게 다듬어도 됩니다.
- 지어내지 말고, 이미지에서 읽히는 것만 채우세요. 안 보이면 빈 문자열.

반드시 아래 형식의 JSON 객체만 출력하세요(설명·마크다운 금지):
{"when":"","antecedent":"","behavior":"","consequence":""}`;

  const SUPABASE_FN_URL = "https://vdubgrxwijydwfabwpnk.supabase.co/functions/v1/claude-relay";
  const res = await fetch(SUPABASE_FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ prompt: promptText, image: { media_type: mediaType, data: base64 }, max_tokens: 1200 }),
  });
  if (!res.ok) {
    let msg = "사진 인식 서버 오류";
    try { const e = await res.json(); if (e.error) msg = e.error; } catch (_) {}
    throw new Error(msg);
  }
  const data = await res.json();
  const raw = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
    : (data.text || "");

  const cleaned = String(raw).replace(/```json|```/g, "").trim();
  let parsed;
  try {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new Error("사진에서 내용을 해석하지 못했어요. 더 선명한 사진으로 다시 시도하거나 직접 입력해 주세요.");
  }
  return {
    when: String(parsed.when || "").trim(),
    antecedent: String(parsed.antecedent || "").trim(),
    behavior: String(parsed.behavior || "").trim(),
    consequence: String(parsed.consequence || "").trim(),
  };
}

// ── PDF 내보내기용 시각카드 아이콘 SVG 문자열 (화면 CardIcon과 동일) ──
function cardIconSvg(name) {
  // 이모지로 표현 (표정·사람·사물)
  const emojiMap = {
    help: "🙋", rest: "😌", look: "👀", together: "🤝", me: "🙋",
    wait: "⏳", give: "🤲", want: "❤️", corner: "🏠", happy: "😊", sad: "😢",
  };
  if (emojiMap[name]) {
    return `<span style="font-size:30px;line-height:1;">${emojiMap[name]}</span>`;
  }
  // SVG 유지 (yes/stop/fidget)
  const P = {
    yes: '<circle cx="24" cy="24" r="16" fill="#DCF0E1" stroke="#5C9A72" stroke-width="2.4"/><path d="M16 24l5 5 11-11" fill="none" stroke="#5C9A72" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
    stop: '<path d="M18 6h12l12 12v12L30 42H18L6 30V18z" fill="#F8D2D2" stroke="#D45C5C" stroke-width="2.4" stroke-linejoin="round"/><path d="M18 18l12 12M30 18L18 30" stroke="#D45C5C" stroke-width="3" stroke-linecap="round"/>',
    fidget: '<circle cx="24" cy="24" r="13" fill="#D9C9F0" stroke="#8A6FB0" stroke-width="2"/><g fill="#B79AE0"><circle cx="24" cy="9" r="3.5"/><circle cx="24" cy="39" r="3.5"/><circle cx="9" cy="24" r="3.5"/><circle cx="39" cy="24" r="3.5"/><circle cx="13" cy="13" r="3"/><circle cx="35" cy="13" r="3"/><circle cx="13" cy="35" r="3"/><circle cx="35" cy="35" r="3"/></g><circle cx="24" cy="24" r="5" fill="#fff" opacity="0.6"/>',
  };
  const body = P[name] || P.yes;
  return `<svg width="30" height="30" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// 시각카드 1장 → 워드용 HTML 문자열
function visualCardToHtml(card, esc) {
  const frame = (inner) =>
    `<div style="border:1px solid #FFF0F3;border-radius:12px;padding:12px;margin:8px 0;">
      <div style="font-size:12px;font-weight:700;color:#D4728A;margin-bottom:8px;">${esc(card.title)}</div>${inner}</div>`;
  if (card.type === "sequence") {
    const cells = card.steps.map((s, i) =>
      `<td style="border:2px solid #F5A0B1;background:#FFF0F3;border-radius:10px;padding:12px 8px;text-align:center;font-weight:700;font-size:13px;">${esc(s)}</td>` +
      (i < card.steps.length - 1 ? `<td style="border:none;text-align:center;color:#D4728A;font-size:18px;">&#8594;</td>` : "")
    ).join("");
    return frame(`<table style="border-collapse:collapse;width:100%;"><tr>${cells}</tr></table>`);
  }
  if (card.type === "strip") {
    const rows = card.items.map((it) => {
      const label = typeof it === "string" ? it : it.label;
      const emoji = typeof it === "string" ? "" : it.emoji;
      const icon = (typeof it === "string" || !it.icon) ? "" : cardIconSvg(it.icon);
      const iconHtml = emoji ? `<span style="font-size:24px;line-height:1;">${emoji}</span>` : icon;
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#FFF0F3;border:2px solid #F5A0B1;border-radius:10px;margin:6px 0;">
        <span style="display:inline-block;width:32px;height:32px;background:#fff;border-radius:8px;text-align:center;line-height:32px;">${iconHtml}</span>
        <span style="font-size:14px;font-weight:700;color:#3A2C30;">${esc(label)}</span></div>`;
    }).join("");
    return frame(rows);
  }
  if (card.type === "choice") {
    const cols = card.options.map((op, i) => {
      const label = typeof op === "string" ? op : op.label;
      const icon = typeof op === "string" ? "" : cardIconSvg(op.icon);
      const bg = i === 0 ? "#EAF5EC" : "#FDECEC", bd = i === 0 ? "#7FB77E" : "#E89AAC";
      return `<td style="width:50%;text-align:center;padding:14px 8px;background:${bg};border:2px solid ${bd};border-radius:12px;">
        <div>${icon}</div><div style="font-size:14px;font-weight:800;color:#3A2C30;margin-top:4px;">${esc(label)}</div></td>`;
    }).join(`<td style="width:8px;border:none;"></td>`);
    return frame(`<table style="border-collapse:separate;width:100%;"><tr>${cols}</tr></table>`);
  }
  if (card.type === "token") {
    const dots = Array.from({ length: card.count }).map(() =>
      `<span style="display:inline-block;width:32px;height:32px;border:2px dashed #F5A0B1;border-radius:50%;color:#E89AAC;text-align:center;line-height:30px;font-size:16px;margin:3px;">&#9733;</span>`
    ).join("");
    return frame(`<div style="text-align:center;">${dots}<div style="font-size:11px;color:#9A8A8F;margin-top:4px;">모으면 좋아하는 활동!</div></div>`);
  }
  return "";
}

function getVisualCards(func) {
  // 여러 기능에 공통으로 유용한 카드 (이모지 기반)
  const emotionScale = { type: "strip", title: "감정 온도계", items: [
    { label: "편안해요", emoji: "😌" },
    { label: "조금 힘들어요", emoji: "😟" },
    { label: "많이 힘들어요", emoji: "😣" },
    { label: "폭발하기 직전!", emoji: "😡" },
  ] };
  const breathing = { type: "strip", title: "진정 심호흡 (숨쉬기 순서)", items: [
    { label: "코로 천천히 들이쉬기", emoji: "🌬️" },
    { label: "잠깐 멈추기 (하나·둘·셋)", emoji: "✋" },
    { label: "입으로 후~ 내쉬기", emoji: "😮‍💨" },
  ] };
  const reinforcerMenu = { type: "strip", title: "강화제 메뉴판 (하나 고르기)", items: [
    { label: "간식", emoji: "🍬" },
    { label: "좋아하는 장난감", emoji: "🧸" },
    { label: "영상 보기", emoji: "📱" },
    { label: "안아주기·칭찬", emoji: "🤗" },
  ] };
  const dailySchedule = { type: "strip", title: "오늘의 일과 (순서)", items: [
    { label: "아침 준비", emoji: "☀️" },
    { label: "공부·활동", emoji: "📚" },
    { label: "밥·간식", emoji: "🍽️" },
    { label: "놀이·휴식", emoji: "🧩" },
    { label: "집에 가기", emoji: "🏠" },
  ] };

  const sets = {
    escape: [
      { type: "sequence", title: "활동 순서판", steps: ["앉기", "3개 하기", "쉬기"] },
      { type: "strip", title: "도움 요청 카드", items: [
        { label: "도와주세요", icon: "help" },
        { label: "쉬고 싶어요", icon: "rest" },
      ] },
      { type: "choice", title: "선택판", options: [
        { label: "더 할래요", icon: "yes" },
        { label: "그만할래요", icon: "stop" },
      ] },
      dailySchedule,
      emotionScale,
    ],
    attention: [
      { type: "strip", title: "관심 요청 카드", items: [
        { label: "봐 주세요", icon: "look" },
        { label: "같이 해요", icon: "together" },
      ] },
      { type: "token", title: "토큰판", count: 5 },
      { type: "choice", title: "차례 카드", options: [
        { label: "내 차례", icon: "me" },
        { label: "기다리기", icon: "wait" },
      ] },
      reinforcerMenu,
    ],
    tangible: [
      { type: "sequence", title: "지금-다음 카드", steps: ["지금은 안돼요", "이따가"] },
      { type: "strip", title: "요청 카드", items: [
        { label: "주세요", icon: "give" },
        { label: "하고 싶어요", icon: "want" },
      ] },
      { type: "token", title: "기다리기 토큰판", count: 3 },
      reinforcerMenu,
    ],
    sensory: [
      { type: "strip", title: "감각 도구 카드", items: [
        { label: "감각 도구", icon: "fidget" },
        { label: "쉼 공간 (조용한 코너)", icon: "corner" },
      ] },
      { type: "sequence", title: "자기조절 순서", steps: ["멈추기", "숨쉬기", "도구 쓰기"] },
      { type: "choice", title: "지금 기분", options: [
        { label: "괜찮아요", icon: "happy" },
        { label: "힘들어요", icon: "sad" },
      ] },
      breathing,
      emotionScale,
    ],
  };
  return sets[func] || sets.escape;
}

function CardFrame({ title, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #FFF0F3", borderRadius: 14, padding: 14, boxShadow: "0 1px 6px rgba(212,114,138,0.05)" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#D4728A", marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

// ── 시각카드용 컬러 픽토그램 아이콘 (화면용, 워드 대신 PDF에서 렌더) ──
function CardIcon({ name, size = 34 }) {
  // 이모지로 표현하는 아이콘 (표정·사람 동작·명확한 사물)
  const emojiMap = {
    help: "🙋", rest: "😌", look: "👀", together: "🤝", me: "🙋",
    wait: "⏳", give: "🤲", want: "❤️", corner: "🏠", happy: "😊", sad: "😢",
  };
  if (emojiMap[name]) {
    return <span style={{ fontSize: size * 1.15, lineHeight: 1, display: "inline-block" }}>{emojiMap[name]}</span>;
  }
  // SVG로 유지하는 아이콘 (브랜드 톤·ABA 상징성 중요: yes/stop/fidget)
  const svg = { width: size, height: size, viewBox: "0 0 48 48", xmlns: "http://www.w3.org/2000/svg" };
  const icons = {
    // 예/더하기 — 체크 동그라미(초록)
    yes: <><circle cx="24" cy="24" r="16" fill="#DCF0E1" stroke="#5C9A72" strokeWidth="2.4" /><path d="M16 24l5 5 11-11" fill="none" stroke="#5C9A72" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></>,
    // 그만 — 팔각형(빨강)
    stop: <><path d="M18 6h12l12 12v12L30 42H18L6 30V18z" fill="#F8D2D2" stroke="#D45C5C" strokeWidth="2.4" strokeLinejoin="round" /><path d="M18 18l12 12M30 18L18 30" stroke="#D45C5C" strokeWidth="3" strokeLinecap="round" /></>,
    // 감각 도구 — 별모양 감각공
    fidget: <><circle cx="24" cy="24" r="13" fill="#D9C9F0" stroke="#8A6FB0" strokeWidth="2" /><g fill="#B79AE0"><circle cx="24" cy="9" r="3.5" /><circle cx="24" cy="39" r="3.5" /><circle cx="9" cy="24" r="3.5" /><circle cx="39" cy="24" r="3.5" /><circle cx="13" cy="13" r="3" /><circle cx="35" cy="13" r="3" /><circle cx="13" cy="35" r="3" /><circle cx="35" cy="35" r="3" /></g><circle cx="24" cy="24" r="5" fill="#fff" opacity="0.6" /></>,
  };
  return <svg {...svg}>{icons[name] || icons.yes}</svg>;
}

function VisualCard({ card }) {
  if (card.type === "sequence") {
    const n = card.steps.length, W = 300, bw = (W - 20 - (n - 1) * 24) / n;
    return (
      <CardFrame title={card.title}>
        <svg viewBox={`0 0 ${W} 96`} style={{ width: "100%", height: "auto" }}>
          {card.steps.map((s, i) => {
            const x = 10 + i * (bw + 24);
            return (
              <g key={i}>
                <rect x={x} y={18} width={bw} height={60} rx={10} fill="#FFF0F3" stroke="#F5A0B1" strokeWidth="2" />
                <text x={x + bw / 2} y={13} textAnchor="middle" fontSize="11" fill="#9A8A8F">{i + 1}</text>
                <text x={x + bw / 2} y={53} textAnchor="middle" fontSize="13" fontWeight="700" fill="#3A2C30">{s}</text>
                {i < n - 1 && <text x={x + bw + 12} y={53} textAnchor="middle" fontSize="18" fill="#D4728A">{"\u2192"}</text>}
              </g>
            );
          })}
        </svg>
      </CardFrame>
    );
  }
  if (card.type === "strip") {
    return (
      <CardFrame title={card.title}>
        <div style={{ display: "grid", gap: 8 }}>
          {card.items.map((it, i) => {
            const label = typeof it === "string" ? it : it.label;
            const icon = typeof it === "string" ? null : it.icon;
            const emoji = typeof it === "string" ? null : it.emoji;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "#FFF0F3", border: "2px solid #F5A0B1", borderRadius: 12 }}>
                <span style={{ width: 34, height: 34, borderRadius: 9, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {emoji ? <span style={{ fontSize: 22, lineHeight: 1 }}>{emoji}</span> : icon ? <CardIcon name={icon} size={22} /> : <span style={{ color: "#D4728A", fontWeight: 800 }}>{i + 1}</span>}
                </span>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#3A2C30" }}>{label}</span>
              </div>
            );
          })}
        </div>
      </CardFrame>
    );
  }
  if (card.type === "choice") {
    return (
      <CardFrame title={card.title}>
        <div style={{ display: "flex", gap: 10 }}>
          {card.options.map((op, i) => {
            const label = typeof op === "string" ? op : op.label;
            const icon = typeof op === "string" ? null : op.icon;
            return (
              <div key={i} style={{ flex: 1, textAlign: "center", padding: "16px 8px", background: i === 0 ? "#EAF5EC" : "#FDECEC", border: `2px solid ${i === 0 ? "#7FB77E" : "#E89AAC"}`, borderRadius: 14 }}>
                {icon && <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}><CardIcon name={icon} size={30} /></div>}
                <div style={{ fontSize: 15, fontWeight: 800, color: "#3A2C30" }}>{label}</div>
              </div>
            );
          })}
        </div>
      </CardFrame>
    );
  }
  if (card.type === "token") {
    return (
      <CardFrame title={card.title}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", padding: "8px 0" }}>
          {Array.from({ length: card.count }).map((_, i) => (
            <div key={i} style={{ width: 40, height: 40, borderRadius: "50%", border: "2px dashed #F5A0B1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "#E89AAC" }}>{"\u2605"}</div>
          ))}
        </div>
        <div style={{ textAlign: "center", fontSize: 11.5, color: "#9A8A8F", marginTop: 4 }}>모으면 좋아하는 활동!</div>
      </CardFrame>
    );
  }
  return null;
}

function BIPBlock({ num, title, children, accent }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: accent ? PKD : PK, color: "#fff", fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{num}</span>
        <span style={{ fontWeight: 700, fontSize: 14.5 }}>{title}</span>
      </div>
      <div style={{ paddingLeft: 32 }}>{children}</div>
    </div>
  );
}

function BulletList({ items }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {items.map((t, i) => (
        <div key={i} style={{ display: "flex", gap: 8, fontSize: 13.5, lineHeight: 1.6 }}>
          <span style={{ color: PK, flexShrink: 0, fontWeight: 800 }}>·</span>
          <span>{t}</span>
        </div>
      ))}
    </div>
  );
}

// 부모님용 쉬운 뷰
function ParentView({ content, childName }) {
  const nm = displayName(childName);
  const Block = ({ emoji, title, desc, items, bg, accent }) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 20 }}>{emoji}</span>
        <span style={{ fontWeight: 800, fontSize: 15, color: accent }}>{title}</span>
      </div>
      {desc ? <div style={{ fontSize: 13.5, lineHeight: 1.8, color: INK, background: bg, borderRadius: 12, padding: "14px 16px" }}>{desc}</div> : null}
      {items ? (
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((t, i) => (
            <div key={i} style={{ display: "flex", gap: 10, fontSize: 13.5, lineHeight: 1.7, background: bg, borderRadius: 12, padding: "12px 14px" }}>
              <span style={{ flexShrink: 0, color: accent, fontWeight: 800 }}>{i + 1}</span>
              <span>{t}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
  return (
    <div>
      <div style={{ fontSize: 12.5, color: MUTE, marginBottom: 16, lineHeight: 1.6, background: "#FFF9FA", borderRadius: 10, padding: "10px 12px" }}>
        💛 이 내용은 <b>{nm} 부모님</b>을 위해 쉽게 풀어 쓴 가정 지원 안내예요. 집에서 이렇게 도와주시면 큰 힘이 됩니다.
      </div>
      <Block emoji="🤔" title={`${nm}는 왜 이런 행동을 할까요?`} desc={content.why} bg="#FFF0F3" accent={PKD} />
      <Block emoji="🌱" title="미리 예방해요 (이렇게 해보세요)" items={content.prevent} bg="#F0F7F1" accent="#5C9A72" />
      <Block emoji="💬" title="다른 행동을 가르쳐요" items={content.teach} bg="#EEF3FB" accent="#5B7BB5" />
      <Block emoji="🤗" title="이렇게 반응해주세요" items={content.respond} bg="#FFF6EC" accent="#C99A4B" />
    </div>
  );
}

// AI 맞춤 추가 항목 (보라색 🤖 표시)


// BIP → 복사용 텍스트
function bipToText(bip, c, agg) {
  const line = "-".repeat(30);
  const tierName = { primary: "1차 기능", secondary: "2차 기능", tertiary: "별도 기능" };
  const fn = (f) => (UNIFIED_FUNC_NAME[f] || f).split(" (")[0];
  const tierLines = (agg && agg.tiers ? agg.tiers.filter((t) => t.tier !== "minor").map((t) => "  [" + tierName[t.tier] + "] " + fn(t.func)) : []);
  return [
    bip.setting === "school" ? "[ 개별 행동중재계획서 (PBIP) ]" : "[ 행동중재계획 (BIP) ]",
    "대상: " + c.name,
    line,
    "1. 행동의 기능 및 가설",
    "표적행동: " + (c.target || "-"),
    ...tierLines,
    "주 기능: " + bip.funcName,
    bip.hypothesis,
    FUNC_MEANING(bip.func, c.name, c.target, bip.setting),
    "",
    "2. 선행중재",
    ...bip.antecedent.map((t) => "  - " + t),
    "",
    "3. 대체행동중재",
    ...bip.replacement.map((t) => "  - " + t),
    "",
    "4. 후속결과중재",
    ...bip.consequence.map((t) => "  - " + t),
    line,
    "© 검단ABA언어행동연구소 (민다혜)",
  ].join(String.fromCharCode(10));
}

// ── 케이스 추가 폼 ──────────────────────────────
function AddForm({ isPbs, onAdd }) {
  const [name, setName] = useState("");
  const [birth, setBirth] = useState("");
  const [age, setAge] = useState("");
  const [target, setTarget] = useState("");
  const [school, setSchool] = useState("");
  const [likes, setLikes] = useState("");        // 좋아하는 것(강화제)
  const [comm, setComm] = useState("");           // 의사소통 수준
  const [behaviorDetail, setBehaviorDetail] = useState(""); // 행동의 구체적 모습
  const [triggers, setTriggers] = useState("");   // 심해지는·진정되는 상황

  // 생년월일 → 만 나이(년/개월) 자동 계산
  const autoAge = React.useMemo(() => {
    if (!birth) return "";
    const b = new Date(birth);
    if (isNaN(b.getTime())) return "";
    const now = new Date();
    let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
    if (now.getDate() < b.getDate()) months -= 1;
    if (months < 0) return "";
    const y = Math.floor(months / 12), m = months % 12;
    return m > 0 ? `${y}세 ${m}개월` : `${y}세`;
  }, [birth]);

  const submit = () => {
    if (!name.trim()) return;
    // 센터: 생년월일 기반 자동 나이 / PBS: 입력한 학년(없으면 자동 나이)
    const ageValue = isPbs ? (age.trim() || autoAge) : autoAge;
    onAdd({ name: name.trim(), birth, age: ageValue, target: target.trim(), likes: likes.trim(), comm: comm.trim(), behaviorDetail: behaviorDetail.trim(), triggers: triggers.trim(), ...(isPbs ? { school: school.trim() } : {}) });
  };

  return (
    <div style={{ background: "#fff", borderRadius: 16, padding: 20, marginBottom: 16, boxShadow: "0 4px 20px rgba(212,114,138,0.1)", border: `1.5px solid ${PKL}` }}>
      <div style={{ fontWeight: 700, marginBottom: 14, color: PKD }}>새 케이스 추가</div>
      <Field label="아동 이름" value={name} onChange={setName} placeholder="예: 김○○" />
      <Field label="생년월일" value={birth} onChange={setBirth} type="date" />
      {isPbs && <Field label="학년" value={age} onChange={setAge} placeholder="예: 고1" />}
      {isPbs && <Field label="학교" value={school} onChange={setSchool} placeholder="예: 인천영종고" />}
      <Field label="목표행동" value={target} onChange={setTarget} placeholder="예: 수업 중 자리 이탈" />

      <div style={{ marginTop: 6, marginBottom: 4, padding: "10px 12px", background: "#FBF8FE", border: "1px dashed #D9C9F0", borderRadius: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#8A6FB0", marginBottom: 2 }}>✨ AI 맞춤 생성용 정보 (선택)</div>
        <div style={{ fontSize: 11, color: MUTE, lineHeight: 1.5, marginBottom: 10 }}>아래를 채우면 AI가 이 아이에 훨씬 맞는 BIP를 만들어요. 비워둬도 됩니다.</div>
        <Field label="좋아하는 것 (강화제)" value={likes} onChange={setLikes} placeholder="예: 자동차 장난감, 유튜브, 젤리, 안아주기" />
        <Field label="의사소통 수준" value={comm} onChange={setComm} placeholder="예: 2~3단어 구어 / 그림카드 사용 / 무발화" />
        <Field label="행동의 구체적 모습" value={behaviorDetail} onChange={setBehaviorDetail} placeholder="예: 10분쯤 앉아있다 일어나 커튼을 만지작거림" />
        <Field label="심해지는 · 진정되는 상황" value={triggers} onChange={setTriggers} placeholder="예: 조용한 시간에 심해짐 / 안아주면 진정됨" />
      </div>

      <button onClick={submit} style={{ ...btnPrimary, width: "100%", marginTop: 6 }}>추가하기</button>
    </div>
  );
}

// ── 확인 모달 (브라우저 confirm 대체) ───────────
function ConfirmModal({ title, message, confirmLabel = "확인", onConfirm, onCancel }) {
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, padding: 24, maxWidth: 340, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: MUTE, lineHeight: 1.6, marginBottom: 20 }}>{message}</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ ...btnGhost, flex: 1 }}>취소</button>
          <button onClick={onConfirm} style={{ flex: 1, padding: "10px 16px", borderRadius: 10, border: "none", cursor: "pointer", background: "#D85A5A", color: "#fff", fontWeight: 700, fontSize: 14 }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ── 푸터 (저작권) ───────────────────────────────
function Footer() {
  return (
    <div style={{ textAlign: "center", padding: "18px 16px 24px", fontSize: 11, color: MUTE, borderTop: `1px solid ${PKL}`, background: "#fff" }}>
      {COPYRIGHT}
    </div>
  );
}

// ── 공통 UI 조각 ────────────────────────────────
const inputStyle = { width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 9, border: `1.5px solid ${PKL}`, fontSize: 14, outline: "none", background: "#FFFBFB" };

// 문서 정보 행 (라벨-값)
function InfoRow({ label, value, last }) {
  return (
    <div style={{ display: "flex", borderBottom: last ? "none" : `1px solid ${PKL}`, fontSize: 12.5 }}>
      <div style={{ flexShrink: 0, width: 68, padding: "8px 10px", background: "#FFF9FA", color: MUTE, fontWeight: 600 }}>{label}</div>
      <div style={{ flex: 1, padding: "8px 12px", color: INK }}>{value}</div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = "text", onEnter }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: MUTE, marginBottom: 5, fontWeight: 600 }}>{label}</div>
      <input type={type} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }}
        style={inputStyle}
        onFocus={(e) => (e.target.style.borderColor = PK)}
        onBlur={(e) => (e.target.style.borderColor = PKL)}
      />
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: "12px 8px", borderRadius: 12, border: "none", cursor: "pointer",
      fontWeight: 700, fontSize: 14, transition: "all .15s",
      background: active ? PK : "#fff", color: active ? "#fff" : MUTE,
      boxShadow: active ? "0 4px 14px rgba(245,160,177,0.4)" : "0 1px 4px rgba(0,0,0,0.04)",
    }}>{children}</button>
  );
}

function Badge({ children }) {
  return <span style={{ display: "inline-block", minWidth: 18, padding: "1px 6px", borderRadius: 10, fontSize: 11, background: "rgba(255,255,255,0.3)", marginLeft: 4 }}>{children}</span>;
}

const btnPrimary = { padding: "10px 16px", borderRadius: 10, border: "none", cursor: "pointer", background: PK, color: "#fff", fontWeight: 700, fontSize: 14, boxShadow: "0 4px 12px rgba(245,160,177,0.35)" };

const btnGhost = { padding: "10px 16px", borderRadius: 10, border: `1.5px solid ${PK}`, cursor: "pointer", background: "#fff", color: PKD, fontWeight: 700, fontSize: 14 };

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayKr() {
  const d = new Date();
  return `${d.getFullYear()}. ${d.getMonth() + 1}.`;
}

function nowLocal() {
  const d = new Date();
  const mm = d.getMonth() + 1, dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0"), mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}월 ${dd}일 ${hh}:${mi}`;
}
