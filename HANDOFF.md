# HANDOFF — chrome-cdp skill

Phiên làm việc: 2026-09-20. Nhánh `main`, commit gốc `3a8f08f`.
Mục tiêu phiên: sửa friction lớn nhất của skill — **mỗi lệnh CLI tự đóng page**.

---

## Trạng thái repo khi bàn giao

Thay đổi **chưa commit** (4 file):

```
 M SKILL.md
 M cli.js
 M references/api.md
 M test/unit.test.js
```

`node --test`: **33/33 pass**. Đã dọn `.tmp/` và server test local (port 8931).

---

## ĐÃ LÀM — CLI giữ được page qua nhiều lệnh

Vấn đề gốc: mọi lệnh `cli.js` là một round trip `connect → goto → act → closePage → disconnect`,
nên lệnh sau luôn bắt đầu từ page lạnh — mất login, mất SPA route, mất `scriptId`.
Chuỗi `search-sources` → `deobfuscate` vì thế bắt buộc phải viết script.

### `cli.js`

- **`--keep-open`** (global): để page mở khi thoát thay vì `closePage()`.
- **`session <url>`**: load page, in URL + title, để tab lại cho các lệnh sau.
- **`-` ở bất kỳ ô `<url>`** = "dùng tab đang mở, bỏ qua navigate". Phần chính giải quyết vấn đề:

  ```bash
  node cli.js session https://target.com
  node cli.js search-sources - "sign"        # -> scriptId 4821
  node cli.js deobfuscate - 4821 clean.js    # cùng một lần load, id còn hiệu lực
  node cli.js eval 'window.__APP_STATE__'
  ```

  `-` tự hàm ý `--keep-open` (không được đóng page mà nó đi vay).
- **`eval`**: nhận `-f <file>`, `-f -` (stdin), hoặc pipe không cần arg; luôn attach nên không đóng page.
- **`--wait <ms>`** cho `traffic`/`har`: giữ recording thêm N ms trước khi đọc.
- **`require.main === module` guard** + `module.exports = { parseGlobalOptions, isAttach, harName, readExpression }`
  → require file này không còn lái Chrome, nhờ đó unit-test được phần logic thuần.
- `dump-forms -` / `dump-storage -` in **URL thật của page** (`targetUrl()`), không in `-`.
- `har -` không còn crash ở `new URL('-')`: tên file mặc định lấy từ page sau khi attach (`harName()`).

### Bẫy phát sinh và cách xử lý (quan trọng, đừng bỏ)

Recording là **per-process** — `connect()` mới chỉ ghi từ lúc nó attach. Nên `traffic -` / `har -`
trả về **0 entry**, đúng kiểu "empty đọc thành absence" mà chính SKILL.md cảnh báo.
Không im lặng: cả hai giờ báo `scope: { startedAt: "attach", waitedMs, note }`
(HAR: `log._scope` + nối vào `log.comment`) và gợi ý `--wait`.

### Tài liệu

- `SKILL.md`: rút gọn section "CLI or script?" — tiêu chí "phải viết script" thu hẹp còn 2 trường hợp
  thật (cần hai lần đọc trong một tick; cần tương tác rồi đọc). Thêm 1 dòng troubleshooting `about:blank`.
- `references/api.md`: cập nhật bảng CLI, ghi chú `-`/`session`, global flags mới.

### Test (thêm 3, tổng 33)

- `parseGlobalOptions` với `--keep-open` / `--wait` (kể cả `--wait -1`, `--wait soon`), và `-` phải
  sống sót như positional chứ không bị đọc thành flag.
- `isAttach` chỉ đúng với dash trần; `harName` với `about:blank` / `-`.
- `readExpression` từ `-f`, `--file`, argv, và case thiếu path.

**Lưu ý cho người sau:** `readExpression(rest, io)` có tham số `io.isTty` để inject. Bắt buộc —
trong `node --test`, `process.stdin` không phải TTY, nên test gọi `readExpression([])` mà không
inject sẽ **treo vô hạn** khi đọc stdin. Đã mất thời gian debug đúng chỗ này.

### Đã verify chạy thật

Chrome thật (CloakBrowser, profile `~/.local/share/chrome-cdp/profile`) + server local:
`session` → `dump-forms -` → `search-sources -` (thấy scriptId) → `deobfuscate - 7` → `eval` cả 4 dạng
input; xác nhận lệnh mặc định vẫn đóng page, `--keep-open` thì không;
`traffic - --wait 5000` bắt được request phát sinh trong lúc chờ.

---

## CHƯA LÀM — backlog, theo thứ tự đề xuất

### 2. `references/api.md` chỉ phủ ~một nửa API
Chính SKILL.md thừa nhận: page interaction, worker eval, performance trace, cache/cookie control
không xuất hiện trong cả `api.md` lẫn `workflows.md` → model sẽ không dùng, hoặc tự đoán signature rồi sai.
Bổ sung bảng cho `src/worker-controller.js`, `src/performance-controller.js`, phần cookie/cache của
`src/network-controller.js` — hoặc sinh `api.md` tự động từ JSDoc để không lệch khi code đổi.

### 3. Thiếu CI
`.github/` chỉ có `README.md` + `chrome-logo.png`, không có workflow. Một `test.yml` chạy `npm test`
trên push là ~15 dòng; test suite đã đủ tốt để bảo vệ các invariant (eviction, redirect hop, timebase).
Cân nhắc kèm `npm audit` / kiểm tra version pin vì deps đang pin cứng.

### 4. Không có smoke test chạy Chrome thật
33 test đều là unit trên CDP event giả — không bắt được regression ở tầng launch, đúng chỗ dễ vỡ nhất
(CloakBrowser download, `--no-sandbox`, profile path, timeout 9222). Đề xuất `npm run test:e2e` tách
riêng (không chạy trong CI mặc định): launch → `goto` một `http.createServer` local → assert
`getTraffic()` thấy request. Server + kịch bản dùng trong phiên này có thể tái dụng làm khung.

### 5. Mảng workflow còn trống trong `references/workflows.md`
- **Luồng có đăng nhập**: log in trong automation profile rồi inspect — SKILL.md nêu đây là lý do chính
  phải viết script nhưng không có code mẫu. (Giờ có `session` + `-` nên recipe này nên dùng CLI trước.)
- **Service worker / worker**: `src/worker-controller.js` tồn tại mà không có recipe nào.
- **Reload-diff**: so sánh traffic giữa hai lần load để tách phần động khỏi phần tĩnh — hay dùng khi
  reverse thuật toán signing.

### 6. Việc nhỏ
- `dump-storage` trả cookie thật → nên có `--redact` (mặc định bật?) để khớp policy redact ở section
  Safety. Hiện policy chỉ nằm ở văn bản, tool không giúp thực thi.
- `package.json` vẫn `version: 1.0.0` sau nhiều commit feature → bump + CHANGELOG, vì SKILL.md mô tả
  hành vi (đường dẫn profile, CloakBrowser) mà user có thể pin theo version.
- `cli.js` tự phát hiện thiếu `node_modules` và in đúng một dòng `run npm install in <dir>`, thay vì để
  failure mode `Cannot find module 'puppeteer-extra'` phải xử lý bằng tài liệu.

---

## Bước tiếp theo ngay

1. Review diff 4 file, rồi commit (phiên trước **chưa** commit vì không được yêu cầu).
2. Chọn (3) CI — ít code, lợi ngay — hoặc (2) bổ sung `api.md`.
