# Daily Strategy Brief — 2026-06-01

> สังเคราะห์อัตโนมัติจาก 3 ชั้นข้อมูล: options positioning + macro + CFTC COT (+ ข่าว/ปฏิทิน)
> อัปเดต: 2026-06-01T07:10 UTC
> _(เชิงการศึกษา ไม่ใช่คำแนะนำลงทุน — ไม่มีคำสั่ง entry/stop/target จริง)_

---

## 🥇 Gold (GC) — futures 4,531.9

**สรุป:** Lean bullish (มั่นใจปานกลาง) — real yield ร่วง -7bp และ DXY อ่อนค่า -0.38%/5d หนุน macro tailwind ขณะที่ Managed Money เพิ่ม net long ต่อเนื่อง แต่ positioning options สัปดาห์นี้ยัง neutral-to-bearish รอทดสอบ 4,550

### เหตุผล 3 ชั้น

| ชั้น | ทิศทาง | คะแนน | ตัวเลขสำคัญ |
|---|---|---|---|
| Positioning (wt 0.45) | neutral / สวนเล็กน้อย | −6.1 | call/put wall ที่ 4,550 (today); Friday options bearish −30.9 |
| Macro (wt 0.35) | **หนุน (tailwind)** | +33 | real yield 10Y 2.06% −7bp/5d · DXY 98.94 −0.38%/5d |
| COT (wt 0.20) | **หนุน (bullish)** | +40 | Managed Money net long **+97,446** (+3,906/wk) pct_rank 0.75 |

**ชั้น Positioning (neutral, headwind เล็กน้อย):**
Options positioning รวมถ่วงน้ำหนักได้ -6.11 — สัญญาณแยกตามกรอบเวลา:

| Contract | DTE | Score | Call Wall | Put Wall | Largest OI |
|---|---|---|---|---|---|
| G1MM6 (today) | 0.44 | neutral −0.5 | 4,550 | 4,550 | 4,550 |
| G1TM6 (tomorrow) | 1.44 | neutral +4.4 | 4,500 | 4,585 | 4,500 |
| OG1M6 (Friday) | 4.44 | **bearish −30.9** | 4,850 | 4,500 | 4,500 |
| OGN6 (monthly Jun) | 24.44 | neutral −3.0 | 5,000 | 4,000 | 4,400 |

จุดน่าสังเกต: สัญญา Friday (OG1M6) มี score bearish −30.9 ชัดเจน — put wall หนักที่ 4,500 และ largest open interest อยู่ที่ 4,500 เช่นกัน หมายความว่า gamma ด้านล่างหนาแน่นกว่าด้านบนในระยะสั้น ทำให้ชั้นนี้เป็น **headwind เล็กน้อย** จนกว่าจะหมดอายุ

**ชั้น Macro (หนุน, +33):**
- **Real yield 10Y: 2.06%** ลดลง −7bp ใน 5 วัน → tailwind ชัด (ทองเคลื่อนตาม inverse real yield)
- **DXY: 98.94** ลดลง −0.38% ใน 5 วัน → ดอลลาร์อ่อน = ทองแพงขึ้นในสกุลอื่น
- 10Y nominal: 4.45% (−12bp/5d, trend down) · breakeven inflation: 2.38% (flat) → real yield ลดจาก nominal ลด ไม่ใช่ inflation กระโดด

**ชั้น COT (หนุน, +40):**
- **Managed Money net long: +97,446** เพิ่มขึ้น +3,906 สัปดาห์ที่แล้ว, trend rising, pct_rank 0.75 — กองทุนยังคงเพิ่ม long ไม่ใช่ crowded extreme
- Swap Dealer net: −166,256 (pct_rank 1.0 — extreme short ตามประวัติ) สะท้อน hedge ฝั่ง OTC ไม่ใช่ directional bearish
- Producer/Merchant net: −19,510 (hedger short ปกติ)
- Open interest รวม: 353,489 contracts; Managed Money long = 35.2% ของ OI ทั้งหมด

Agreement: **2 ชั้นหนุน (macro + COT) / 0 ชั้นสวนโดยตรง** → overall lean_bullish score 16.8

---

### Key Levels — GC

| ประเภท | ระดับ | หมายเหตุ |
|---|---|---|
| **Magnet / Resistance ใกล้สุด** | **4,550** | call wall + put wall today; magnet ราคาดึง |
| Resistance | 4,585 | put wall G1TM6 (tomorrow) |
| Resistance | 4,850 | call wall Friday options |
| Resistance | 5,000 | call wall monthly |
| **Support ใกล้สุด** | **4,500** | put wall + largest OI หลายสัญญา |
| Support | 4,400 | largest position monthly |
| Support | 4,000 | put wall monthly |

ราคาปัจจุบัน 4,531.9 อยู่ **ใต้ magnet 4,550 ประมาณ 18 pts**

---

### Scenarios — GC

**Upside:**
- **Trigger:** ราคา sustained เหนือ 4,550 (ทะลุ call/put wall + magnet)
- **Then:** เปิดทางสู่ 4,585 และระยะกลางถึง 4,850
- **Invalidation:** กลับลงใต้ 4,500

**Downside:**
- **Trigger:** หลุดใต้ 4,500 อย่างชัดเจน (put wall + largest OI พัง)
- **Then:** ดิ่งสู่ 4,400 (support ถัดไป)
- **Invalidation:** กลับขึ้นเหนือ 4,550

**จะเปลี่ยนมุมมองเมื่อ:**
Real yield พลิกขึ้น หรือ DXY แข็งค่ากลับ หรือ Managed Money เริ่ม unwind net long (COT รายงานถัดไป) หรือราคาหลุดปิดใต้ 4,500 พร้อม volume สูง

**ข้อควรระวัง:**
- สัญญา Friday options bearish score −30.9 อาจกดราคาระยะสั้น
- Swap Dealer ที่ pct_rank 1.0 (extreme short history) มี mean-reversion risk
- NFP (Jun 5) เป็น event risk หลักที่จะเขย่าทั้ง real yield และ DXY ก่อน/หลัง

---

## 💻 Nasdaq-100 (NQ) — futures 30,585.2

**สรุป:** Lean bullish (มั่นใจต่ำ) — macro tailwind แรงสุดในสามชั้น (10Y −12bp/5d, VIX 15.3 ลด) แต่ leveraged funds ยัง net short เพิ่มขึ้นต่อเนื่องสร้าง COT headwind ที่แบ่งทิศทาง ทำให้ conviction ต่ำกว่าทอง รอ breakout 31,000 ยืนยัน

### เหตุผล 3 ชั้น

| ชั้น | ทิศทาง | คะแนน | ตัวเลขสำคัญ |
|---|---|---|---|
| Positioning (wt 0.45) | neutral | −5.6 | ไม่มี options granular data สำหรับ NQ |
| Macro (wt 0.35) | **หนุนแรง (tailwind)** | +53 | 10Y −12bp/5d · VIX 15.32 −8.3%/5d |
| COT (wt 0.20) | neutral / headwind | −10 | Lev funds net **−51,679** falling · AM net +85,063 rising |

**ชั้น Macro (หนุนแรงสุด, +53):**
- **10Y nominal yield: 4.45%** ลดลง −12bp ใน 5 วัน → discount rate ลด หนุน growth/tech valuation
- **VIX live: 15.32** ลดลง −8.26% ใน 5 วัน (จากประมาณ 16.7) → risk-on environment ชัดเจน
- 2s10s curve: +0.46% (ไม่ inverted, steepening เล็กน้อย)

**ชั้น COT (แตกสัญญาณสองทิศ):**

| กลุ่ม | Net Position | เปลี่ยน/สัปดาห์ | pct_rank | ทิศทาง |
|---|---|---|---|---|
| **Leveraged Funds** | **−51,679** | −6,308 | **0.17** | falling (เพิ่ม short) |
| **Asset Managers** | **+85,063** | −7,238 | 0.75 | rising (ยัง net long สูง) |
| Dealers | −45,022 | +13,848 | 0.42 | neutral |

Leveraged funds (HF) เพิ่ม short +6,308 สัญญาในสัปดาห์ที่แล้ว — pct_rank 0.17 หมายความว่า net short ระดับนี้เกิดขึ้นเพียง 17% ของช่วงเวลาในประวัติ (มีแนว short squeeze ถ้าตลาดดีขึ้น แต่ยังเป็น headwind ปัจจุบัน) ขณะที่ asset managers ถือ long ที่ pct_rank 0.75 แต่ลดลง 7,238 สัปดาห์ที่แล้ว — divergence นี้ต้องติดตาม

Agreement: **1 ชั้นหนุน (macro) / 1 ชั้นสวน (COT HF short) / 1 neutral (positioning)** → overall lean_bullish score 14.0, confidence LOW

---

### Key Levels — NQ

| ประเภท | ระดับ | หมายเหตุ |
|---|---|---|
| Resistance | **31,000** | resistance เดี่ยวที่ระบุ |
| Support ใกล้สุด | **30,430** | support แรก |
| **Magnet** | **30,350** | magnet + support |
| Support | 30,300 | support ถัด |
| Support | 29,850 | support ไกล |

ราคาปัจจุบัน 30,585 อยู่ **เหนือ support แรก 30,430 ประมาณ 155 pts** และ **ห่างจาก resistance 31,000 ประมาณ 415 pts**

---

### Scenarios — NQ

**Upside:**
- **Trigger:** ราคา sustained เหนือ 31,000
- **Then:** momentum extension สู่ all-time high territory ต่อไป
- **Invalidation:** กลับลงใต้ 30,430

**Downside:**
- **Trigger:** หลุดใต้ 30,430
- **Then:** ทดสอบ magnet 30,350 และ support 30,300
- **Invalidation:** กลับขึ้นเหนือ 31,000

**จะเปลี่ยนมุมมองเมื่อ:**
Leveraged funds เพิ่ม short ต่อเนื่อง (COT rolls over) หรือ asset managers เริ่ม unwind long ชัดเจน หรือ 10Y yield พลิกขึ้น / VIX spike

**ข้อควรระวัง:**
- Confidence ต่ำสุดในสองสินทรัพย์ — ชั้นข้อมูล COT แตกทิศทางสร้างความไม่แน่นอน
- Leveraged funds short pct_rank 0.17 มีศักยภาพ short squeeze ถ้าข่าวดี แต่ก็คือ headwind ตอนนี้
- Event risk สูง: NFP Jun 5 + FOMC Jun 16-17 จะกำหนดทิศของทั้งสัปดาห์และเดือนหน้า

---

## 📰 ข่าว & แคตาลิสต์สัปดาห์นี้

### ทอง (Gold / GC)
- **US-Iran ceasefire extension:** มีรายงานการขยายระยะสงบศึก กดดันให้ safe-haven premium จากภูมิรัฐศาสตร์ลดลงบ้าง แต่ถ้า deal ล้มเหลวอาจดัน gold spike
- **CPI เมษายนร้อนกว่าคาด:** ตลาดปรับ pricing ออก Fed cut ทั้งปี 2026 แล้ว บาง scenario เริ่มราคา rate hike ก่อนสิ้นปี — stagflationary backdrop ประวัติศาสตร์มักหนุนทอง
- **Central bank diversification:** ธนาคารกลางทั่วโลกยังคงกระจายสำรองออกจาก USD สู่ทอง เป็น structural demand ต่อเนื่อง
- ราคาทองในตลาดสัปดาห์นี้อยู่แถว ~$4,580/oz (ปรับขึ้น 2 วันติด ณ วันที่รายงาน)

### Nasdaq-100 (NQ)
- **AI infrastructure ยังคงเป็นธีมขับราคาหลัก:** Dell Technologies +32% จาก AI-related upgrade เป็นตัวอย่างล่าสุด — ดีมานด์ GPU/server ยังแข็งแกร่ง
- **Nasdaq 100 แตะ all-time high:** สัปดาห์ที่ผ่านมาตลาด risk-on รวมกับ yield ลด ดัน multiple expansion สำหรับ growth stocks
- **Higher-for-longer rate ยังกดดัน:** แม้ macro tailwind ระยะสั้น แต่ตราบใด Fed ไม่ลด rate ความเสี่ยงด้าน valuation ยังอยู่

### ปฏิทินเศรษฐกิจสหรัฐฯ ที่ต้องติดตาม

| กำหนดการ | รายการ | ผลต่อตลาด |
|---|---|---|
| **Jun 5** | **Non-Farm Payrolls (NFP)** | สูงมาก — ชี้ทิศ Fed + real yield + DXY |
| **Jun 10–11** | CPI + PPI (พฤษภาคม) | สูง — inflation path → กระทบ real yield ทอง |
| **Jun 16–17** | **FOMC Meeting** | สูงมาก — rate decision + dot plot ชี้ทิศทั้งปี |

*PCE และ ISM: ไม่พบวันที่ชัดเจนในแหล่งข่าว ควรตรวจสอบ economic calendar ก่อน trading จริง*

---

*Disclaimer: เนื้อหานี้จัดทำเพื่อการศึกษาและวิเคราะห์เชิงกลยุทธ์เท่านั้น ไม่ใช่คำแนะนำในการลงทุน และไม่มีคำสั่ง entry/stop/target จริง ผู้ใช้ต้องรับผิดชอบการตัดสินใจการลงทุนด้วยตนเอง*
