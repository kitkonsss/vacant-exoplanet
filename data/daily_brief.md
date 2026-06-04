# 📊 Vol2Vol Daily Brief — 4 มิถุนายน 2026

**Data timestamp:** `2026-06-04T00:10:43 UTC`
**Asset ที่วิเคราะห์:** GC (Gold Futures) | NQ (Nasdaq-100) — หมายเหตุ: ไม่มี NQ data ใน repo วันนี้

---

## 🥇 GC — ทองคำ Futures

### บรรทัดสรุป
**lean_bullish / confidence: medium** — macro เป็น tailwind หลัก (real yield ลง -7bp/5d, DXY อ่อน -0.35%/5d) แต่ positioning เป็น neutral และราคาอยู่ไกลใต้ daily VWAP ~4.2 SD ทำให้ upside ถูกจำกัดโดย gamma wall หนาที่ 4500

---

### เหตุผล 3 ชั้น

#### ชั้น 1 — Positioning (score: 4.5 / 100 = neutral | weight: 45%) ⚠️ ขัดแย้งภายใน
- **สั้น (current week G1WM6):** bullish score +26.5 — OI build ด้านบนหนักกว่าล่าง (+713 above vs +185 below), put wall ใกล้ราคาที่ 4465 ช่วยพยุง
- **กลาง (friday OG1M6, tomorrow G1RM6):** neutral ทั้งคู่ — call wall/put wall ยังห่างจากราคาปัจจุบัน (put wall 4500, call wall 4550/4610)
- **ยาว (monthly OGN6):** bearish score -21.5 — largest OI bloc คือ put wall ที่ 4000 และ call wall 5000 บีบเป็น wide range; ราคาอยู่กลาง ไม่มีแรงกดใด
- **⚠️ ข้อขัดแย้ง:** สัญญา short-term bullish แต่ monthly bearish → ไม่ได้ยืนยันกันทุก tenor, overall positioning รวมออกมา neutral เท่านั้น

#### ชั้น 2 — Macro (score: 32 / 100 = tailwind | weight: 35%) ✅ หนุน
| ตัวแปร | ค่า | 5d change | ผลต่อทอง |
|---|---|---|---|
| 10Y Real Yield (TIPS) | 2.06% | -7bp | Tailwind ✅ |
| DXY (yfinance) | 98.97 | -0.35% | Tailwind ✅ |
| 10Y Nominal Yield | 4.45% | -12bp | Tailwind ✅ |
| 2Y Nominal Yield | 3.99% | -5bp | — |
| 2s10s Curve | +46bp | — | Normal slope |
| VIX (live) | 15.88 | -0.71/5d | ลดลง = risk-on บางส่วน |
| Breakeven Inflation | 2.38% | -1bp | Flat |

- real yield ลดลงต่อเนื่อง = opportunity cost ของการถือทองลด → bullish
- DXY ต่ำกว่า 99 = ทองแพงขึ้นในสกุลเงินอื่น → เพิ่ม demand
- **⚠️ ข้อขัดแย้ง:** VIX 15.88 อยู่ต่ำ = ตลาดไม่กลัว → demand ทองในฐานะ safe haven ลดลง; macro tailwind มาจาก rate direction ไม่ใช่ fear

#### ชั้น 3 — COT (score: 18 / 100 = lean_bullish | weight: 20%) ✅ หนุน (แต่ lag)
- **Managed Money net long:** +97,446 contracts (pct_rank 0.30 = subdued, 30th percentile จาก ~2 ปี)
  - เพิ่มขึ้น +3,906/wk จากสัปดาห์ก่อน = rising momentum
  - ยังต่ำกว่า peak ปลายปี 2025 (~136,000) มาก = มีที่ว่างสำหรับ long เพิ่ม
- **Commercial / Smart Money:** net -185,766 (hedge), weekly change +5,863 (z=0.36) = neutral, ไม่มีสัญญาณ contrarian
- **⚠️ ข้อควรระวัง:** COT รายงานล่าช้า — ข้อมูลล่าสุดคือ 26 พ.ค. 2026 (lag ~9 วัน), ราคาอาจเคลื่อนไหวไปแล้วก่อนที่รายงานจะสะท้อน

---

### Key Levels (GC)

| ระดับ | บทบาท | ที่มา / Confluence |
|---|---|---|
| **4500** | Resistance / Gamma magnet หลัก | γ340 + OI wall (4550 OI) + OI build (+506 put) + round 100 = **×4 confluence** |
| **4550** | Resistance ลำดับถัดไป | OI wall (put wall OG1M6) + round 50 |
| **4575** | Resistance | OG1M6 call wall + VWAP -2SD ref |
| **4610** | Resistance | call wall G1RM6 (tomorrow) |
| **4470** | แนวต้านใกล้สุด (micro) | put wall G1WM6 — เพียง 3 pt บนราคา |
| **4466.9** | **ราคาปัจจุบัน (future)** | — |
| **4465** | แนวรับใกล้สุด (micro) | put wall G1WM6 — เพียง 2 pt ใต้ราคา |
| **4450** | **Magnet / แนวรับ** | γ108 + round 50 = ×2 — downside magnet จาก heatmap |
| **4400** | แนวรับแกร่ง | γ310 (major gamma wall) + OI wall (4887 OI mixed) + round 100 = **×3 confluence** |
| **4000** | แนวรับโครงสร้าง | put wall ใหญ่สุด monthly (4573 OI puts) |

> **VWAP context:** Daily VWAP 4540.68 (SD=17.64) — ราคาอยู่ต่ำกว่า VWAP ประมาณ 4.2 SD = แนวรับ mean-reversion แต่ regime เป็น trending (momentum) ดังนั้น playbook = momentum ไม่ใช่ fade

---

### Scenarios

#### 📈 Upside Scenario — Momentum Continuation
| Step | รายละเอียด |
|---|---|
| **Trigger** | Sustained break + close above **4500** (×4 confluence) พร้อม volume ยืนยัน |
| **Then** | Path toward **4550** (OI wall + round 50) / เป้าถัดไป 4575 |
| **Invalidation** | ราคาหลุดกลับมาใต้ **4450** หลัง break 4500 |

#### 📉 Downside Scenario — Magnet Pull
| Step | รายละเอียด |
|---|---|
| **Trigger** | Break below **4450** (gamma wall γ108 + round 50) — ปัจจุบันราคาห่างแค่ 17 pt |
| **Then** | ดึงลงหา **4400** (major gamma wall γ310) — heatmap ระบุ 4450 เป็น downside magnet |
| **Invalidation** | Reclaim **4500** พร้อม OI build ด้านล่างเพิ่มขึ้น |

---

### อะไรจะทำให้เปลี่ยนมุมมอง (What Would Change My Mind)

- **เปลี่ยนเป็น bullish มากขึ้น:** real yield ทะลุต่ำกว่า 2.0% + DXY หลุด 98 พร้อมกัน AND Managed Money net long ขยับขึ้นเหนือ 110,000 (pct_rank > 0.5) — ยืนยันว่า fund flow จริงๆ เข้ามา
- **เปลี่ยนเป็น bearish:** 10Y real yield กลับขึ้นเกิน 2.15% (reversal หลัง Fed hawkish surprise) หรือ DXY เด้งกลับเหนือ 100 ชัดเจน; หรือ OI build ด้านล่างสูงกว่าด้านบนอย่างมีนัย
- **Neutral / ออกจากมุมมอง:** ราคาย่ำอยู่ระหว่าง 4450–4500 เกิน 2 วัน = ไม่มี momentum → รอ catalyst ใหม่

---

### ⚠️ ข้อควรระวัง

1. **ความขัดแย้งระหว่างชั้น:** Macro tailwind แต่ positioning neutral + monthly contract bearish — 2/3 หนุน แต่ชั้น positioning (น้ำหนักสูงสุด 45%) ยังไม่ยืนยัน → เหตุที่ confidence ออกมาแค่ medium
2. **ราคา vs VWAP ห่างมาก:** อยู่ ~4.2 SD ใต้ daily VWAP = ผิดปกติ มีความเสี่ยง mean-reversion ขึ้นไปที่ 4540 แต่ในระบบ trending/momentum playbook นี้ไม่ใช่สัญญาณ sell
3. **COT lag:** รายงานล่าช้า 9 วัน — หาก sentiment เปลี่ยนหลัง 26 พ.ค. data จะยังไม่สะท้อน
4. **Micro range แคบมาก:** put wall support ที่ 4465 และ resistance ที่ 4470 ห่างกันเพียง 5 pt — ราคาอยู่ใน squeeze zone, breakout ทิศใดก็ได้มักรุนแรง
5. **VIX ต่ำ (15.88):** ตลาดอยู่ใน risk-on mode — ถ้า risk-off กลับมา ทองอาจขึ้นได้จาก safe haven แต่ถ้า risk-on ต่อ demand ทองลดลง

---

## 📉 NQ — Nasdaq-100 Futures

> **⚠️ ไม่มีข้อมูล NQ ใน repository (`data/nq/` ไม่มีอยู่)** — ไม่สามารถวิเคราะห์ด้าน positioning, COT หรือ key levels ของ NQ ได้ในรอบนี้
>
> **Macro context สำหรับ NQ (จาก macro.json):**
> - VIX 15.88 ลดลง -0.71/5d = risk appetite เปิด → เอื้อ NQ ขึ้นในระยะสั้น
> - 2s10s curve +46bp (positive slope) = ไม่มี inversion → ไม่ส่งสัญญาณ recession
> - 10Y yield ลง -12bp/5d = multiple expansion เป็นไปได้สำหรับ growth stocks
> - อย่างไรก็ตาม ไม่มีข้อมูล options positioning จึงไม่สามารถระบุ key levels หรือ scenarios ที่มีคุณภาพได้

---

## 📰 ข่าว & แคตาลิสต์วันนี้

> **หมายเหตุ:** Bigdata.com subscription หมดอายุในรอบนี้ — ไม่สามารถดึงข่าวและปฏิทินเศรษฐกิจแบบ real-time ได้ ให้ตรวจสอบแหล่งข่าวภายนอกเพิ่มเติม (CME Group, Bloomberg, Reuters)

### ปัจจัยหลักที่ควรติดตามสัปดาห์นี้

**สำหรับทอง GC:**
- Fed speakers / FOMC minutes — ถ้า hawkish เกินคาด = bearish ทอง (real yield ขึ้น)
- NFP (Non-Farm Payrolls) ถ้าออกแข็ง = USD แข็ง = bearish ทอง
- ความเสี่ยงภูมิรัฐศาสตร์ = ทองขึ้น safe haven
- Central bank gold demand: EM central banks ยังเป็น structural support

**สำหรับ NQ Nasdaq-100:**
- AI capex / earnings revisions จาก big tech
- Fed rate path: yield ลง = เอื้อ growth/tech
- CPI / PCE — ถ้า inflation กลับมา = Fed hawkish = NQ ลง

### ปฏิทินเหตุการณ์สำคัญ (ตรวจสอบกับ CME/Bloomberg จริง)
| เหตุการณ์ | ผลที่คาดต่อ GC | ผลที่คาดต่อ NQ |
|---|---|---|
| NFP (ถ้าอยู่ในสัปดาห์นี้) | แข็ง = bearish; อ่อน = bullish | แข็ง = mixed (growth ดี vs rate ขึ้น) |
| FOMC Minutes / Fed Speech | Hawkish = bearish GC; Dovish = bullish | Hawkish = bearish |
| CPI / PCE | สูงกว่าคาด = bearish ทั้งคู่ (real yield ขึ้น) | สูงกว่าคาด = bearish |

---

## 🔑 จุดที่ข้อมูล "ขัดกัน" — Edge ที่น่าสนใจ

| ความขัดแย้ง | ผลที่ควร monitor |
|---|---|
| Macro tailwind แต่ positioning neutral | ถ้า fund flow ยังไม่ตาม macro → upside อาจ delay |
| Heatmap ระบุ downside magnet 4450 แต่ macro สนับสนุน upside | ราคาอยู่ที่ 4466.9 ห่าง 4450 แค่ 17pt และ ห่าง 4500 แค่ 33pt → breakout direction ทิศใดก็ได้ |
| MM net long subdued (30th pct) แต่ rising | Fund ยังไม่ all-in → ถ้า macro ยืนยัน อาจมีการ add long เพิ่ม = 2nd leg up |
| VIX ต่ำ (risk-on) ขณะ gold rising | driver ไม่ใช่ fear แต่เป็น real yield drop → bullish quality ดีกว่าการขึ้นจาก panic |

---

*บทวิเคราะห์นี้จัดทำเพื่อการศึกษาและวิเคราะห์เชิงวิชาการเท่านั้น ไม่ใช่คำแนะนำการลงทุน ไม่มีคำสั่ง entry/stop/target จริง ผู้ใช้มีความรับผิดชอบต่อการตัดสินใจลงทุนของตนเอง*
