# บทวิเคราะห์กลยุทธ์ประจำวัน
**วันที่: 2026-06-02** | สร้างอัตโนมัติจากข้อมูล Vol2Vol Dashboard  
*(GC generated_at: 2026-06-02T00:10:41+00:00 | macro: 2026-06-01 | COT report date: 2026-05-26)*

---

## 🥇 GC — ทองคำ Futures
**ราคาอ้างอิง: 4,499.7** | Contract หลัก: OGN6 (monthly)

### สรุป 1 ประโยค
GC อยู่ใน **neutral** (score +6.7, confidence **low**) — ดึงกัน 2 ต่อ 2: macro + COT หนุน bullish แต่ options positioning ทุก tenor bearish และราคากำลัง "นั่งทับ" gamma wall ใหญ่สุดที่ **4,500 (γ250)** แบบแทบไม่มีระยะห่าง

---

### เหตุผล 3 ชั้น

| ชั้น | Score (weight) | Label | ทิศทาง |
|------|:--------------:|-------|:------:|
| Positioning | −16.6 (×0.45) | bearish | **สวน** |
| Macro | +32.0 (×0.35) | tailwind | **หนุน** |
| COT | +40.0 (×0.20) | bullish | **หนุน** |

**Positioning — สวน (ชั้นหนักสุด weight 0.45):**  
Position bias รวม −16.6 (bearish) ทุก tenor โดยเฉพาะ friday OG1M6 score −27.5 (high confidence bearish) ที่มี dominant call wall **4,750** กับ put wall **4,500** OI magnet ที่ใหญ่ที่สุดอยู่ที่ **4,400 ด้านล่าง** (4,888 OI, mixed, ×4 confluence: gamma_wall + oi_build + oi_wall + round_100) — heatmap contract flow bias = **downside_magnet** โดย monthly OGN6 เพิ่ม OI ด้านล่างราคา 1,949 contracts มากกว่าด้านบน 1,660 contracts ในวันล่าสุด; execution_read ชี้ primary path = **downside_momentum_to_first_gamma_wall**

**Macro — หนุน:**  
real yield 10Y ลดลง **−7bp/5d** มาอยู่ที่ **2.06%** (TIPS, as of 2026-05-28); DXY **98.97** อ่อนตัว **−0.35%/5d** → ทั้งสองปัจจัยหลักเป็น tailwind ให้ทอง; 10Y nominal **4.45%** (−12bp/5d) และ 2Y **3.99%** (−5bp/5d) curve steep +46bp (2s10s); breakeven inflation **2.38%** (flat); VIX **15.74** (−1.02/5d) บ่งชี้ risk-on เล็กน้อย → ไม่มี fear-driven demand หนุนทองระยะสั้น

**COT — หนุน (แต่ระวัง lag):**  
Managed Money net long **+97,446** สัญญา (+3,906/สัปดาห์, rising); pct_rank = 0.75 → อยู่ใน top quartile ของ historic range แต่ยังไม่ extreme; swap dealer net short **−166,256** (ปกติสำหรับ hedge); report date **2026-05-26** (lag ~7 วัน)

---

### Key Levels

| ระดับ | ประเภท | แหล่งที่มา / รายละเอียด |
|------:|--------|------------------------|
| **5,000** | Resistance (deep) | call wall 4,877 OI (4,333 calls); γ126 |
| **4,800** | Resistance | call wall 4,609 OI; γ235; ×3 confluence |
| **4,750** | Resistance — call wall สำคัญ | call wall 2,897 OI; γ166; oi_build +567; ×4 confluence |
| **4,585** | Resistance | put wall 4,585 (tomorrow contract) |
| **4,500** | **Gamma Magnet / Resistance ใกล้สุด** | γ250 (ใหญ่สุด monthly); put wall 4,093 OI; ×3 confluence; 0.3 pts จากราคา |
| **4,499.7** | ราคาปัจจุบัน | — |
| **4,450** | Gamma ด่านแรกด้านล่าง | γ79 |
| **4,400** | **Support + OI Magnet หลัก** | γ235; 4,888 OI mixed; oi_build +488; put wall +123; ×4 confluence |
| **4,300** | Support | put wall 2,703 OI; γ89; ×3 confluence |
| **4,000** | Deep support | put wall 4,549 OI (4,549 puts) |

---

### Scenarios

**📈 Upside — trigger → then → invalidation**  
trigger: ราคายืนเหนือ **4,500** ได้อย่างต่อเนื่อง (break gamma wall γ250 + put wall 4,093 OI)  
→ then: path ต่อไปที่ **4,550** (γ87 current contract) จากนั้น **4,585** และ **4,600** (mixed wall 3,260 OI)  
→ invalidation: ราคาหล่นกลับใต้ **4,400**

**📉 Downside — trigger → then → invalidation**  
trigger: ราคาหลุด **4,400** (×4 confluence, OI magnet ที่ใหญ่สุด)  
→ then: path ต่อไปที่ **4,300** (put wall 2,703 OI, ×3 confluence)  
→ invalidation: ราคา reclaim **4,500** กลับขึ้นมาได้

---

### อะไรจะทำให้เปลี่ยนมุมมอง (What Would Change My Mind)

- **Flip more bullish:** call walls เหนือ 4,500 เริ่ม unwound (OI ลด) + fresh OI build ย้ายมากองบนด้านบน + real yield ลงต่อใต้ **2.0%** + DXY ทะลุต่ำกว่า **98.5**
- **Flip more bearish:** COT Managed Money net long ลดลงต่ำกว่า **90,000** + DXY กลับแข็งเหนือ **100** + positioning score ดิ่งต่ำกว่า −25 ทุก tenor
- **ตัวที่น่ากังวลที่สุดตอนนี้:** หาก call walls ยังสะสมต่อ (ตามที่ what_would_change_my_mind ระบุ) ราคาจะถูก cap ไว้ที่ 4,500–4,550 ไม่ว่า macro จะดีแค่ไหน

---

### ข้อควรระวัง

1. **ความขัดแย้งระหว่างชั้น (สำคัญที่สุด):** 4 layers ดึงกัน 2+2 เสมอกัน (macro+COT หนุน vs. positioning ระยะสั้น+ยาวต้าน) → confidence ต่ำ อย่า oversize position
2. **Gamma pinning:** ราคา 4,499.7 ห่างจาก gamma wall 4,500 เพียง **0.3 points** — ช่วงใกล้ expiry มักเกิด choppy/pin action รอบ strike ใหญ่
3. **COT lag ~7 วัน:** report date 2026-05-26 ราคาและ sentiment อาจ shift ไปแล้วในสัปดาห์ที่ผ่านมา ใช้ COT เป็น structural read ไม่ใช่ timing
4. **Downside magnet แข็งแกร่ง:** heatmap bias = downside_magnet และ execution_read = downside_momentum แม้ macro หนุน short-term flow อาจยังกด

---

## 📊 NQ — Nasdaq-100 Futures

> **ข้อมูลไม่พร้อมใช้งาน:** ไม่พบไฟล์ `data/nq/daily_strategy.json` หรือ `data/nq/cot.json` ใน repo  
> scraper NQ ยังไม่ถูก implement หรือยังไม่มีข้อมูลถูก commit ไว้  
> ข้ามการวิเคราะห์ NQ จนกว่าจะมีข้อมูล

**Macro context สำหรับ NQ (จาก macro.json — ใช้ประกอบเท่านั้น):**  
- VIX **15.74** (−1.02/5d) → ลดลง, risk-on เล็กน้อย → neutral-positive สำหรับ equities  
- 10Y nominal **4.45%** (−12bp/5d) → yield ลง หนุน high-multiple tech  
- Breakeven inflation **2.38%** (flat) → inflation pressure ไม่ escalate  
- 2s10s curve **+46bp** → ไม่มีสัญญาณ recession risk เร่งตัว

---

## 📰 ข่าว & แคตาลิสต์วันนี้

> **Bigdata.com subscription หมดอายุ** — ไม่สามารถดึงข่าวและปฏิทินเศรษฐกิจ real-time ได้ในรอบนี้  
> ([Bigdata.com](https://bigdata.com) — ต่อ subscription เพื่อเปิดใช้งาน)

**เหตุการณ์เศรษฐกิจสำคัญที่ควรติดตามในสัปดาห์นี้ (ตรวจสอบเวลาที่แน่นอนกับ economic calendar):**

| เหตุการณ์ | คาดผลต่อ GC | คาดผลต่อ NQ |
|-----------|------------|------------|
| NFP / Jobs report (~6 Jun) | แข็ง = bearish (yield ขึ้น, DXY แข็ง); อ่อน = bullish | แข็ง = mixed; อ่อน = bullish (Fed pivot) |
| ISM Manufacturing PMI | อ่อน = bullish GC (risk-off + yield ลง) | อ่อน = bearish / stagflation concern |
| PCE Core (inflation) | สูงกว่าคาด = bearish GC (real yield ขึ้น) | สูงกว่าคาด = bearish NQ (rate hike concern) |
| FOMC speaker / Minutes | Hawkish = bearish GC; Dovish = bullish | Dovish = bullish NQ |

**จุดขัดแย้งที่เป็น edge สำหรับ GC:**  
macro บอก tailwind (real yield ลง, DXY อ่อน) แต่ options structure บอก downside magnet ที่ 4,400 — ถ้า NFP ออกอ่อน macro จะยิ่งหนุน GC แต่ positioning ต้านทาน → โอกาสเกิด gamma squeeze ขึ้นผ่าน 4,500 ถ้ามีแรงซื้อเพียงพอ

---

*วิเคราะห์เชิงการศึกษาจาก options positioning + macro + CFTC COT เท่านั้น ไม่ใช่คำแนะนำการลงทุน ไม่มีคำสั่ง entry/stop/target จริง*
