# OpenWork

OpenWork คือแอปพลิเคชัน desktop แบบฟรีและโอเพนซอร์ส (รองรับ macOS, Windows, Linux) สำหรับทำงานร่วมกับ AI agents บนไฟล์ของคุณเอง — เป็นทางเลือกโอเพนซอร์สแทน Claude Cowork และ Codex นำ LLM กว่า 50 รายการมาใช้ด้วย API key ของผู้ให้บริการที่คุณเลือกเอง ขยายความสามารถของ agents ด้วย skills, plugins และ MCP servers และแชร์การตั้งค่าทั้งหมดให้ทีมด้วยลิงก์เดียว


## หลักปรัชญาหลัก

- **Local-first, cloud-ready**: OpenWork รันบนเครื่องของคุณด้วยคลิกเดียว ส่งข้อความได้ทันที
- **Composable**: ใช้เป็น desktop app, Slack/Telegram connector หรือ server ใช้ในรูปแบบที่เหมาะกับคุณ ไม่ผูกมัดกับแพลตฟอร์มใด
- **Ejectable**: OpenWork ขับเคลื่อนด้วย OpenCode ทุกสิ่งที่ OpenCode ทำได้ก็ใช้งานได้ใน OpenWork แม้จะยังไม่มี UI รองรับ
- **Sharing is caring**: เริ่มต้นใช้งานคนเดียวบน localhost แล้วค่อยเลือกเปิดใช้งานการแชร์ระยะไกลเมื่อต้องการ

<p align="center">
  <img src="../app-demo.gif" alt="OpenWork demo" width="800" />
</p>

OpenWork ถูกออกแบบมาโดยมีแนวคิดว่าคุณสามารถนำ agentic workflows ของคุณไปใช้กับทีมได้อย่างง่ายดาย ในรูปแบบกระบวนการที่ทำซ้ำได้และเป็นมาตรฐาน

> [!TIP]
> **ต้องการ [แผน Enterprise](https://openworklabs.com/enterprise)?** [พูดคุยกับทีมขายของเราวันนี้](https://calendar.app.google/86QpCENvhfEzDFLu5)
>
> รับความสามารถเพิ่มเติม เช่น การจัดลำดับความสำคัญของฟีเจอร์, SSO, การรองรับ SLA, เวอร์ชัน LTS และอื่นๆ อีกมากมาย

## UI ทางเลือก

- **OpenWork Orchestrator (CLI host)**: รัน OpenCode + OpenWork server โดยไม่ต้องใช้ desktop UI
  - ติดตั้ง: `npm install -g openwork-orchestrator`
  - รัน: `openwork start --workspace /path/to/workspace --approval auto`
  - เอกสาร: [apps/orchestrator/README.md](../apps/orchestrator/README.md)

## เริ่มต้นใช้งาน

ดาวน์โหลด desktop app ได้จาก [openworklabs.com/download](https://openworklabs.com/download), ดาวน์โหลดเวอร์ชันล่าสุดจาก [GitHub release](https://github.com/different-ai/openwork/releases) หรือ build จาก source code ตามขั้นตอนด้านล่าง

- ดาวน์โหลดสำหรับ macOS และ Linux มีให้โดยตรง
- การใช้งานบน Windows ต้องสมัครแผนบริการแบบชำระเงินที่ [openworklabs.com/pricing#windows-support](https://openworklabs.com/pricing#windows-support)
- OpenWork Cloud workers แบบ hosted จะเปิดใช้งานจาก web app หลังชำระเงิน แล้วเชื่อมต่อจาก desktop app ผ่าน `Add a worker` -> `Connect remote`

## นโยบายการลงนามโค้ด

บริการลงนามโค้ดฟรีโดย [SignPath.io](https://about.signpath.io), ใบรับรองโดย [SignPath Foundation](https://signpath.org)

- Committers และ reviewers: ผู้ร่วมงาน OpenWork repository ที่มีสิทธิ์ write access และ maintainers ที่ได้รับการอนุมัติใน [Different AI organization](https://github.com/orgs/different-ai/people)
- Approvers: [เจ้าของ Different AI organization](https://github.com/orgs/different-ai/people?query=role%3Aowner)
- นโยบายความเป็นส่วนตัว: [OpenWork Privacy Policy](https://openworklabs.com/privacy)

## ทำไมต้อง OpenWork

CLI และ GUI ปัจจุบันสำหรับ opencode มุ่งเน้นนักพัฒนาเป็นหลัก ทำให้เน้นที่ file diffs, ชื่อ tools และความสามารถที่ขยายได้ยากโดยไม่ต้องเปิดเผย CLI ในรูปแบบใดรูปแบบหนึ่ง

OpenWork ถูกออกแบบให้:

- **ขยายได้ (Extensible)**: skill และ opencode plugins เป็นโมดูลที่ติดตั้งได้
- **ตรวจสอบได้ (Auditable)**: แสดงให้เห็นว่าเกิดอะไรขึ้น เมื่อไหร่ และทำไม
- **มีการจัดการสิทธิ์ (Permissioned)**: การเข้าถึง flows ที่มีสิทธิ์พิเศษ
- **Local/Remote**: OpenWork ทำงานได้ทั้งในเครื่องและเชื่อมต่อกับ remote servers

## สิ่งที่รวมอยู่

- **Host mode**: รัน opencode ในเครื่องของคุณ
- **Client mode**: เชื่อมต่อกับ OpenCode server ที่มีอยู่ผ่าน URL
- **Sessions**: สร้าง/เลือก sessions และส่ง prompts
- **Live streaming**: การ subscribe SSE `/event` สำหรับอัปเดตแบบ realtime
- **Execution plan**: แสดง OpenCode todos เป็น timeline
- **Permissions**: แสดงคำขอสิทธิ์และตอบกลับ (อนุญาตครั้งเดียว / เสมอ / ปฏิเสธ)
- **Templates**: บันทึกและรัน workflows ทั่วไปซ้ำ (เก็บในเครื่อง)
- **Debug exports**: คัดลอกหรือส่งออกรายงาน debug runtime และ developer log stream จาก Settings -> Debug เมื่อต้องการรายงานบัก
- **Skills manager**:
  - แสดงรายการโฟลเดอร์ `.opencode/skills` ที่ติดตั้งไว้
  - นำเข้าโฟลเดอร์ skill ในเครื่องไปยัง `.opencode/skills/<skill-name>`

## Skill Manager

<img width="1292" height="932" alt="image" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />

## ทำงานได้ทั้งบนเครื่องและ servers

<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 05 16 PM" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />

## Build จาก Source

### ความต้องการของระบบ

- Node.js + `pnpm`
- Rust toolchain (สำหรับ Tauri): ติดตั้งผ่าน `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Tauri CLI: `cargo install tauri-cli`
- OpenCode CLI ที่ติดตั้งแล้วและสามารถใช้ได้บน PATH: `opencode`

### ข้อกำหนดเบื้องต้นสำหรับ Local Dev (Desktop)

ก่อนรัน `pnpm dev` ให้ตรวจสอบว่าติดตั้งสิ่งเหล่านี้แล้วและใช้งานได้ใน shell ของคุณ:

- Node + pnpm (repo ใช้ `pnpm@10.27.0`)
- **Bun 1.3.9+** (`bun --version`)
- Rust toolchain (สำหรับ Tauri) พร้อม Cargo จาก `rustup` stable ปัจจุบัน (รองรับ `Cargo.lock` v4)
- Xcode Command Line Tools (macOS)
- บน Linux ต้องมี WebKitGTK 4.1 development packages เพื่อให้ `pkg-config` สามารถ resolve `webkit2gtk-4.1` และ `javascriptcoregtk-4.1` ได้

### การตรวจสอบเบื้องต้นใน 1 นาที

รันจาก root ของ repo:

```bash
git checkout dev
git pull --ff-only origin dev
pnpm install --frozen-lockfile

which bun
bun --version
pnpm --filter @openwork/desktop exec tauri --version
```

### ติดตั้ง

```bash
pnpm install
```

OpenWork อยู่ใน `apps/app` (UI) และ `apps/desktop` (desktop shell)

### รัน (Desktop)

```bash
pnpm dev
```

`pnpm dev` เปิดใช้งาน `OPENWORK_DEV_MODE=1` โดยอัตโนมัติ ทำให้การพัฒนา desktop ใช้ OpenCode state แบบ isolated แยกจากการตั้งค่า/auth/ข้อมูลส่วนตัวของคุณ

### รัน (Web UI เท่านั้น)

```bash
pnpm dev:ui
```

ทุก entrypoints `dev` ใน repo จะเลือกใช้ dev-mode isolation เดียวกัน เพื่อให้การทดสอบในเครื่องใช้ OpenWork-managed OpenCode state อย่างสม่ำเสมอ

### สำหรับผู้ใช้ Arch Linux:

```bash
sudo pacman -S --needed webkit2gtk-4.1
curl -fsSL https://opencode.ai/install | bash -s -- --version "$(node -e "const fs=require('fs'); const parsed=JSON.parse(fs.readFileSync('constants.json','utf8')); process.stdout.write(String(parsed.opencodeVersion||'').trim().replace(/^v/,''));")" --no-modify-path
```

## สถาปัตยกรรม (ภาพรวม)

- ใน **Host mode** OpenWork รัน local host stack และเชื่อมต่อ UI กับมัน
  - Runtime เริ่มต้น: `openwork` (ติดตั้งจาก `openwork-orchestrator`) ซึ่ง orchestrate `opencode`, `openwork-server` และ `opencode-router` (ตัวเลือก)
  - Runtime สำรอง: `direct` ที่ desktop app จะ spawn `opencode serve --hostname 127.0.0.1 --port <free-port>` โดยตรง

เมื่อคุณเลือกโฟลเดอร์ project OpenWork จะรัน host stack ในเครื่องโดยใช้โฟลเดอร์นั้น และเชื่อมต่อ desktop UI ทำให้คุณรัน agentic workflows ส่ง prompts และดูความคืบหน้าได้ทั้งหมดบนเครื่องของคุณโดยไม่ต้องมี remote server

- UI ใช้ `@opencode-ai/sdk/v2/client` เพื่อ:
  - เชื่อมต่อกับ server
  - แสดงรายการ/สร้าง sessions
  - ส่ง prompts
  - subscribe SSE events (Server-Sent Events ใช้สำหรับ stream การอัปเดตแบบ realtime จาก server ไปยัง UI)
  - อ่าน todos และคำขอสิทธิ์

## Folder Picker

Folder picker ใช้ Tauri dialog plugin
สิทธิ์ความสามารถถูกกำหนดไว้ใน:

- `apps/desktop/src-tauri/capabilities/default.json`

## OpenCode Plugins

Plugins คือวิธี **native** ในการขยาย OpenCode OpenWork จัดการ plugins เหล่านี้จากแท็บ Skills โดยการอ่านและเขียน `opencode.json`

- **Project scope**: `<workspace>/opencode.json`
- **Global scope**: `~/.config/opencode/opencode.json` (หรือ `$XDG_CONFIG_HOME/opencode/opencode.json`)

คุณยังสามารถแก้ไข `opencode.json` ด้วยตนเองได้ OpenWork ใช้รูปแบบเดียวกับ OpenCode CLI:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

## คำสั่งที่มีประโยชน์

```bash
pnpm dev
pnpm dev:ui
pnpm typecheck
pnpm build
pnpm build:ui
pnpm test:e2e
```

## การแก้ไขปัญหา

หากต้องการรายงานบักเกี่ยวกับ desktop หรือ session ให้เปิด Settings -> Debug และส่งออกทั้ง runtime debug report และ developer logs ก่อนรายงานปัญหา

### Linux / Wayland (Hyprland)

หาก OpenWork crash เมื่อเปิดใช้งานพร้อม WebKitGTK errors เช่น `Failed to create GBM buffer` ให้ปิดใช้งาน dmabuf หรือ compositing ก่อนเปิดโปรแกรม ลองใช้ environment flags ดังนี้

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 openwork
```

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 openwork
```

## หมายเหตุด้านความปลอดภัย

- OpenWork ซ่อน model reasoning และ tool metadata ที่ละเอียดอ่อนโดยค่าเริ่มต้น
- Host mode ผูกกับ `127.0.0.1` โดยค่าเริ่มต้น

## การมีส่วนร่วม

- อ่าน `AGENTS.md` พร้อมกับ `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md` และ `ARCHITECTURE.md` เพื่อทำความเข้าใจเป้าหมายของ product ก่อนทำการเปลี่ยนแปลง
- ตรวจสอบให้แน่ใจว่าติดตั้ง Node.js, `pnpm`, Rust toolchain และ `opencode` ก่อนทำงานใน repo
- รัน `pnpm install` ครั้งเดียวต่อการ checkout จากนั้นตรวจสอบการเปลี่ยนแปลงด้วย `pnpm typecheck` และ `pnpm test:e2e` (หรือ subset ที่ต้องการ) ก่อนเปิด PR
- ใช้ `.github/pull_request_template.md` เมื่อเปิด PRs และใส่คำสั่งที่รัน ผลลัพธ์ ขั้นตอนการตรวจสอบด้วยตนเอง และหลักฐาน
- หาก CI ล้มเหลว ให้ระบุสาเหตุใน PR body ว่าเป็น code-related regressions หรือ external/environment/auth blockers
- เพิ่ม PRDs ใหม่ไปที่ `apps/app/pr/<name>.md` ตาม conventions ใน `.opencode/skills/prd-conventions/SKILL.md` ที่อธิบายไว้ใน `AGENTS.md`

เอกสารชุมชน:

- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `SUPPORT.md`
- `TRIAGE.md`

Checklist สำหรับการมีส่วนร่วมครั้งแรก:

- [ ] รัน `pnpm install` และคำสั่งตรวจสอบพื้นฐาน
- [ ] ยืนยันว่าการเปลี่ยนแปลงของคุณมี issue link และ scope ที่ชัดเจน
- [ ] เพิ่ม/อัปเดต tests สำหรับการเปลี่ยนแปลงพฤติกรรม
- [ ] ใส่คำสั่งที่รันและผลลัพธ์ใน PR ของคุณ
- [ ] เพิ่ม screenshots/video สำหรับการเปลี่ยนแปลงที่ผู้ใช้มองเห็นได้

## ภาษาที่รองรับ

README ที่แปลแล้ว: [`translated_readmes/`](./README.md) มีให้ในภาษา English, 简体中文, 繁體中文, 日本語 และ ภาษาไทย

แอปพลิเคชันรองรับภาษาดังต่อไปนี้:
- ภาษาอังกฤษ (`en`)
- ภาษาฝรั่งเศส (`fr`)
- ภาษาสเปน (`es`)
- ภาษาคาตาลัน (`ca`)
- ภาษาโปรตุเกสบราซิล (`pt-BR`)
- ภาษาญี่ปุ่น (`ja`)
- ภาษาจีนตัวย่อ (`zh`)
- ภาษาไทย (`th`)
- ภาษาเวียดนาม (`vi`)
- ภาษารัสเซีย (`ru`)

## สำหรับทีมและธุรกิจ

สนใจใช้ OpenWork ในองค์กรของคุณ? เราอยากพูดคุยด้วย — ติดต่อได้ที่ [ben@openworklabs.com](mailto:ben@openworklabs.com) เพื่อแชร์ use case ของคุณ

## สัญญาอนุญาต

MIT — ดูที่ `LICENSE`
