# VM Deploy — Oracle Cloud Free Tier

ไฟล์ใน folder นี้ใช้สำหรับ deploy scraper ไปรันบน Oracle Cloud VM แทน GitHub Actions  
ข้อดี: รันได้ **ทุก 1 นาที** ตรงเวลา 100%

---

## Quick Start

### 1. สร้าง Oracle Cloud VM (ฟรี)

1. สมัคร [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/)
2. สร้าง VM Instance:
   - Shape: **VM.Standard.A1.Flex** (ARM, 4 OCPU, 24GB RAM ฟรี)
   - OS: **Ubuntu 22.04**
   - SSH key: ใส่ public key ของตัวเอง
3. เปิด port 22 (SSH) ใน Security List

### 2. SSH เข้า VM แล้วรัน setup

```bash
ssh ubuntu@<VM_IP>

# Clone repo
git clone https://github.com/kitkonsss/vacant-exoplanet.git
cd vacant-exoplanet

# Run setup (ติดตั้ง Chrome, Python, etc.)
sudo bash vm-deploy/setup.sh
```

### 3. ตั้ง Credentials

```bash
sudo -u scraper bash
nano ~/.env
```

ใส่:
```
CME_EMAIL=your_email@example.com
CME_PASSWORD=your_password
```

### 4. ตั้ง GitHub Push Access

สร้าง [Personal Access Token (PAT)](https://github.com/settings/tokens) ที่มี `repo` scope แล้ว:

```bash
sudo -u scraper bash
cd ~/vacant-exoplanet
git remote set-url origin https://<YOUR_PAT>@github.com/kitkonsss/vacant-exoplanet.git
```

### 5. ทดสอบ

```bash
sudo -u scraper bash ~/vacant-exoplanet/vm-deploy/scrape_and_push.sh
# ดู log:
cat /home/scraper/logs/scrape_$(date +%Y%m%d).log
```

### 6. ติดตั้ง Cron

```bash
sudo -u scraper bash ~/vacant-exoplanet/vm-deploy/install_cron.sh
```

---

## Schedule

| ช่วงเวลา (ICT) | UTC | ความถี่ |
|---|---|---|
| 12:00 - 18:59 | 05:00 - 11:59 | ทุก 1 นาที |
| 19:00 - 21:30 | 12:00 - 14:30 | ทุก 1 นาที |
| 22:00 | 15:00 | 1 ครั้ง (EOD) |

**เฉพาะ จันทร์-ศุกร์**

## Files

| File | Description |
|---|---|
| `setup.sh` | ติดตั้ง Chrome, Python, venv บน VM |
| `scrape_and_push.sh` | Cron script: รัน scraper → git push |
| `install_cron.sh` | ติดตั้ง crontab |

## Logs

- อยู่ที่ `/home/scraper/logs/scrape_YYYYMMDD.log`
- เก็บ 7 วัน ลบอัตโนมัติ

## Troubleshooting

```bash
# ดู log วันนี้
tail -50 /home/scraper/logs/scrape_$(date +%Y%m%d).log

# ดู cron ปัจจุบัน
sudo -u scraper crontab -l

# รัน manual
sudo -u scraper bash /home/scraper/vacant-exoplanet/vm-deploy/scrape_and_push.sh

# เช็ค Chrome
google-chrome --version
```
