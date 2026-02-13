# Gold Vol2Vol — Intraday Expected Range & OI Indicator

เครื่องมือแสดง Vol2Vol Expected Range และ Open Interest สำหรับ Gold (GC)
ดึงข้อมูลอัตโนมัติจาก [pageth/Vol2VolData](https://github.com/pageth/Vol2VolData)

---

## 🌐 Web App (เปิดใน Browser)

### วิธีใช้
1. เปิดไฟล์ `index.html` ใน browser (Chrome/Edge/Firefox)
2. รอ 2-3 วินาทีให้ดึงข้อมูลจาก GitHub
3. เสร็จ! กราฟจะแสดง:
   - 📊 **OI Bars** ด้านซ้าย (ฟ้า = Call, ส้ม = Put)
   - ➖ **Round Number Lines** ทุก $25 (เส้นประสีส้ม)
   - 🏷️ **Expected Range** ที่แต่ละ strike
   - 📈 **Info Panel** ด้านล่าง (Vol Settle, P/C Ratio, Max OI)

### ฟีเจอร์
- Auto-refresh ทุก 60 วินาที
- กดปุ่ม ⟳ Refresh เพื่ออัปเดตทันที
- Dark theme สไตล์ TradingView

> **หมายเหตุ**: Candlestick data เป็น sample data — ถ้าต้องการ real price data 
> สามารถเชื่อมต่อ API เพิ่มได้ (เช่น OANDA, Yahoo Finance)

---

## 🖥️ ATAS Custom Indicator

### ขั้นตอนการติดตั้ง

1. **เปิด Visual Studio** (Community edition ฟรี)
2. **เปิดโปรเจค** `GC_Vol2Vol_ATAS/GC_Vol2Vol_ATAS.csproj`
3. **แก้ path** ของ `ATAS.Indicators.dll` ใน `.csproj` ให้ตรงกับที่ติดตั้ง ATAS
4. **Build** โปรเจค (Ctrl+Shift+B)
5. **Copy** ไฟล์ `.dll` ที่ได้ไปไว้ใน:
   ```
   C:\Users\<USERNAME>\Documents\ATAS\Indicators\
   ```
6. **เปิด ATAS** → เพิ่ม indicator "Vol2Vol Gold - OI & Expected Range" บนกราฟ GC

### Settings
| Setting | Default | คำอธิบาย |
|---|---|---|
| Strike Interval | $25 | ระยะห่างเส้น round number |
| Visible Range | $300 | ช่วงราคาที่แสดง (±$300 จาก underlying) |
| Auto Refresh | 60 sec | ดึงข้อมูลใหม่ทุกกี่วินาที |
| Line Color | Orange | สีเส้น horizontal |
| Call OI Color | Light Sky Blue | สีแท่ง Call OI |
| Put OI Color | Orange | สีแท่ง Put OI |
