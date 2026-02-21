# GitHub Instructions

## 1. อย่า Over-engineer
- เขียนโค้ดให้เรียบง่าย ตรงประเด็น ไม่ซับซ้อนเกินความจำเป็น
- แก้ปัญหาเฉพาะที่มีอยู่จริง อย่าเพิ่ม feature หรือ abstraction ที่ยังไม่จำเป็น
- เลือก solution ที่ง่ายที่สุดที่ทำงานได้ก่อนเสมอ

## 2. Push Code ขึ้น GitHub ทุกครั้งหลังแก้ไขเสร็จ
- หลังแก้ไขโค้ดเสร็จทุกครั้ง ให้ commit และ push ขึ้น GitHub ทันที
- เขียน commit message ให้ชัดเจน บอกว่าแก้ไขอะไร
- ตัวอย่าง:
  ```bash
  git add .
  git commit -m "fix: แก้ไข ..."
  git push
  ```
