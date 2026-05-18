# GitHub Instructions

## General Guidelines

1. **อย่า Overengineering** — เขียนโค้ดให้เรียบง่าย ตรงไปตรงมา ไม่ต้องเพิ่มความซับซ้อนหรือ abstraction ที่ไม่จำเป็น

2. **Push code ขึ้น GitHub ทุกครั้งหลังแก้ไขเสร็จ** — สำหรับโปรเจ็กต์นี้ หลังแก้โค้ดเสร็จต้องรัน validation ที่เกี่ยวข้องก่อนทุกครั้ง เช่น build, test, lint, หรือ syntax check ตามส่วนที่แก้ ให้แน่ใจว่าไม่มี error หรือ warning ที่เกิดจากงานนี้ แล้วค่อย `git commit` และ `git push` ทันที ห้ามจบงานโดยยังไม่ push
