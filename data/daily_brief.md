# Vol2Vol — บทวิเคราะห์กลยุทธ์ประจำวัน

**วันที่:** 5 มิถุนายน 2026 | generated_at: `2026-06-05T00:10:46 UTC`
**ข้อมูล positioning อ้างอิง:** 2026-06-04 | **COT report:** 2026-05-26 | **Macro:** 2026-06-01

---

## 🥇 Gold Futures (GC) — ราคา $4,509.0

### สรุปทิศทาง (1 ประโยค)
**Neutral** (confidence: medium) — macro tailwind จาก real yield ที่ลดลง −7bp/5d และ DXY อ่อนค่า −0.35%/5d หนุนทอง แต่ถูกหักล้างโดย options positioning bearish ที่กองกำแพง put/gamma ใต้ราคา ทำให้ weighted score อยู่ที่ +8.4 (neutral zone)

---

### เหตุผล 3 ชั้น

#### ชั้น 1 — Positioning (น้ำหนัก 45%, score −13.8) ⚠️ **สวนทาง — กดคะแนน**

Options OI รวมทุก tenor ให้ position bias **bearish** (−13.78 weighted):

- **Put wall ที่ 4500** คือกำแพงที่ใกล้ราคาที่สุด (ห่างเพียง −9 pts): OI รวม 4,450 contracts (put ครอง 2,996, call 1,454), intraday activity_vs_oi สูง 0.66 — กำแพงนี้ active มาก
- **Gamma magnet ที่ 4400** (γ=362, ห่าง −109 pts) เป็น gamma หนักที่สุดในระบบ — dealer hedging จะดึงราคากลับไปทดสอบ 4400 หากแรง support ที่ 4500 แตก
- **OI build รายวัน เทกองใต้ราคา:** +4,746 contracts below vs +1,616 above — ตลาด options กำลังซื้อการป้องกันขาลง
- **Friday contract (OG1M6):** เพิ่ม +1,013 contracts ที่ 4300 (ลักษณะ tail hedge) และ +253 ที่ 4425 put — แรงหนักขาลงระยะสั้น
- **Upside: call wall แรกที่ 4600** (γ=207, OI 3,064 mixed) แล้ว call wall หนักที่ 4700 (OI 3,073 calls, +178 contracts ใหม่) — ฝาเพดานชัดเจน

#### ชั้น 2 — Macro (น้ำหนัก 35%, score +32) ✅ **หนุน**

| ตัวชี้วัด | ค่าล่าสุด | เปลี่ยน 5d | ทิศทาง |
|-----------|-----------|-----------|--------|
| 10Y Real Yield (TIPS) | 2.06% | **−7bp** | ↓ Tailwind ทอง |
| 10Y Nominal | 4.45% | −12bp | ↓ |
| 2Y Nominal | 3.99% | −5bp | ↓ |
| 2s10s Curve | +46bp | — | Steepening |
| DXY | 98.972 | **−0.35%** | ↓ Tailwind ทอง |
| VIX (live) | 15.88 | −0.71 /5d | ↓ ความกังวลลด |
| Breakeven Inflation 10Y | 2.38% | −1bp | Stable |

ทั้ง real yield และ DXY เดินหน้าลง — เงื่อนไข macro เอื้อต่อทองในช่วง 5 วันที่ผ่านมา อย่างไรก็ตาม real yield 2.06% ยังสูงในเชิงประวัติศาสตร์ — ไม่ใช่ tailwind แบบ structural ยังต้องเห็น trend ลงต่อเนื่อง

#### ชั้น 3 — COT (น้ำหนัก 20%, score +18) ✅ **หนุนอ่อน** (ข้อมูล lag ~10 วัน)

| กลุ่ม | Net Position | เปลี่ยน/สัปดาห์ | Percentile | สัญญาณ |
|-------|-------------|----------------|-----------|--------|
| Managed Money (MM) | **+97,446** long | +3,906 | 30th = subdued | Momentum bullish |
| Commercial (Smart Money) | −185,766 net | +5,863 | z=0.4 | **Neutral** |
| Producer/Merchant | −19,510 | −1,596 | **95th = near-extreme** | ⚠️ Hedge ลดมาก |

- MM net long 97,446 อยู่ที่ percentile 30 — ยังไม่ crowded (peak คือ ~137,000 เมื่อ ม.ค. 2026) มีแรงซื้อเพิ่มได้อีก → **momentum bullish แต่ไม่ใช่ contrarian sell signal**
- Commercial z-score 0.4 = neutral — ไม่มี "smart money edge" ชัดเจน
- ⚠️ **จุดสังเกต:** Producer/Merchant percentile 95 (near-extreme long) = miners ลด hedge น้อยมาก อาจสะท้อนว่าผู้ผลิตมองราคาจะขึ้น → bullish signal ระยะกลาง

---

### Key Levels

```
4700 ████████  call wall (OI 3,073 calls, γ150)     ← เป้าขาขึ้น
4600 ████      call wall/speed bump (γ207, OI 3,064) ← Resistance หลัก
4575           resistance (key level)
4550           resistance (key level)
4540.68        VWAP รายวัน                            ← Mean reversion target
4526.67        Weekly VWAP
4510           Nearest micro resistance               ← Vol2Vol intraday call wall
──── 4509 ─── ราคาปัจจุบัน ──────────────────────────
4505           Nearest micro support                  ← Vol2Vol
4500 ████████  PUT WALL + gamma (γ349, OI 4,450)    ← กำแพงหนักใต้ราคา = แนวรับหลัก
4450           support (γ118 + oi_build +149)
4425           support (put OI 635, friday contract)
4400 ████████  GAMMA MAGNET (γ362, OI 4,935 mixed)  ← แรงดึงหลัก หากแตก 4500
4350           support (γ113 + put build +147)
4300 ████      put wall ใหญ่ (γ154, OI 2,755 puts)
```

---

### Scenarios

**🔼 Scenario ขาขึ้น**

| | |
|--|--|
| **Trigger** | ราคายืนทะลุและปิดเหนือ **4600** (confluence ×3: γ207 + OI wall + round_100) พร้อม volume ยืนยัน |
| **Then** | เปิดเส้นทาง → **4700** (call wall หลัก, OI 3,073 calls) อาจพักที่ 4650–4680 |
| **Invalidation** | ราคากลับลงต่ำกว่า **4500** หลัง breakout = false break |

**🔽 Scenario ขาลง**

| | |
|--|--|
| **Trigger** | ราคาทะลุและปิดต่ำกว่า **4500** (put wall + gamma wall พัง) |
| **Then** | → 4450 → **4400** (gamma magnet, แรงดึงหนักสุด) |
| **Invalidation** | กลับขึ้นยืนเหนือ **4600** ได้ = false breakdown |

---

### อะไรจะทำให้เปลี่ยนมุมมอง

- **Flip to Bullish:** call wall เหนือ 4600 หยุดสะสมหรือ OI ลด, MM net long ไต่ขึ้นผ่าน 115,000+, real yield ดิ่งลงแรง (>−15bp/5d), DXY หลุดต่ำกว่า 97
- **Flip to Bearish:** DXY กลับแข็งค่าเหนือ 101, real yield กลับขึ้นเกิน 2.20%, OI build เปลี่ยนทิศกองเหนือราคา, MM net long ดิ่งลงเร็ว

---

### ⚠️ ข้อควรระวัง

1. **ความขัดแย้งหลัก (Core Conflict):** Positioning (−13.8, bearish) ชนกับ Macro+COT (+32/+18, bullish) — ระบบออก neutral เพราะ positioning มีน้ำหนัก 45% ดึงคะแนนลง ความขัดแย้งนี้คือ edge: ถ้า macro ชนะ → breakout เร็ว; ถ้า positioning ชนะ → ราคาอาจร่วงแรง
2. **COT lag:** รายงาน 26 พ.ค. lag ~10 วัน อาจไม่สะท้อน flow หลัง macro events ล่าสุด
3. **VWAP zone:** ราคา 4509 อยู่ระหว่าง −1sd (4523) และ −2sd (4505) ของ VWAP รายวัน — mean reversion กลับ 4540 อาจเกิดก่อน breakout ใดๆ
4. **Gamma pinning:** Gamma หนาแน่นรอบ 4400–4500 กดความผันผวนในกรอบนี้ — ต้องการ catalyst ใหม่ (macro event) เพื่อ break ออก

---

## 📊 Nasdaq-100 (NQ)

> **สถานะ:** ยังไม่มีข้อมูล NQ ใน repository นี้ (`strategy_fetch.py` รองรับเฉพาะ GC) — NQ data pipeline อยู่ในแผน implementation เฟสถัดไป เมื่อพร้อมจะปรากฏที่ `data/nq/daily_strategy.json`

---

## 📰 ข่าว & แคตาลิสต์วันนี้

> **หมายเหตุ:** Bigdata.com subscription หมดอายุ + network ถูก restrict — ไม่สามารถดึงข่าวสดได้ในเซสชันนี้ ข้อมูลด้านล่างอ้างอิงจากบริบท macro ใน repo

**ปัจจัย macro ที่ต้องจับตา:**

- **Real yield trend (−7bp/5d):** หาก NFP ออกแข็งแกร่ง → yield พุ่งกลับ → กด thesis bullish ทอง | อ่อน → ยิ่งหนุน
- **DXY (−0.35%/5d):** ดอลลาร์อ่อนต่อเนื่อง — ดูว่า Fed speakers สัปดาห์นี้จะ push back หรือไม่
- **VIX 15.88 (ลดลง):** ตลาดไม่ panic — ทองขาด safe-haven premium ระยะสั้น แต่ถ้า VIX กลับพุ่งทองได้ประโยชน์ทันที

**ปฏิทินเหตุการณ์เศรษฐกิจสหรัฐสัปดาห์ 2–6 มิ.ย. 2026:**

| วัน | เหตุการณ์ | ผลคาดต่อ GC | ผลคาดต่อ NQ |
|-----|----------|-----------|-----------|
| พ. 4 มิ.ย. | ISM Services PMI | แข็ง → bearish GC | แข็ง → bullish NQ |
| พฤ. 5 มิ.ย. | Jobless Claims รายสัปดาห์ | สูง (อ่อนงาน) → bullish GC | อ่อน → ระวัง NQ |
| ศ. 6 มิ.ย. | **Non-Farm Payrolls (NFP)** | ตัวเลขหลัก — อ่อน → bullish GC | อ่อน → bearish NQ |
| ต่อเนื่อง | Fed speeches (post-blackout) | Hawkish → bearish GC | Hawkish → bearish NQ |

> ⚡ **จุดที่ข้อมูลขัดกัน (edge):** Macro+COT บอกทอง "ควรขึ้น" แต่ options positioning กำลังสร้างกำแพงใต้ราคา — ถ้า NFP ออกอ่อนกว่าคาด (trigger macro bullish) แต่ positioning ยังไม่ shift → ทองอาจวิ่งขึ้นแรงกว่าปกติเพราะ dealer hedging ถูกบีบ (gamma squeeze scenario)

---

*⚠️ Disclaimer: บทวิเคราะห์นี้จัดทำเพื่อการศึกษาเชิงวิเคราะห์เท่านั้น ไม่ใช่คำแนะนำการลงทุน ไม่มีคำสั่ง entry/stop/target จริง*
