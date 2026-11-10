# 攤位電子叫號系統（Cloudflare Workers 免費版）

給市集／展場攤位用的線上叫號系統。**不需要電腦主機**：程式跑在 Cloudflare 的免費雲端上，24 小時在線、不會休眠，排隊資料也不會不見。攤主只要一支手機就能叫號。

- 來賓**付款後掃 QR code 取號**，就可以先離開去逛
- 來賓頁面即時顯示「目前叫號／前面還有幾組／預估等待時間」
- **剩 3 組時**，手機跳出「快輪到你了」的提醒（組數可以調整）
- 攤主按「叫下一號」，**被叫到的來賓手機會跳出推播通知**
- 過號、再叫一次、排回隊伍、完成都可以操作

| 網址 | 用途 |
|---|---|
| `/` | 來賓頁：取號、看進度、開啟通知 |
| `/admin` | 攤主叫號台（第一次打開時設定密碼） |
| `/poster` | QR code 加排隊規則的海報，可以列印或截圖 |

---

## 只用手機部署（大約 10 分鐘，完全免費）

全程用手機瀏覽器就能完成。如果畫面太擠，可以在瀏覽器選單打開「要求電腦版網站」。

1. 到 **dash.cloudflare.com** 註冊免費帳號，不用信用卡。
2. 左側選單點 **Workers 和 Pages** → **建立應用程式（Create）** → **匯入存放庫（Import a repository）**。
3. 點 **連接 GitHub（Connect GitHub）**，授權 Cloudflare 讀取 `queue-system` 這個 repo。
4. 選擇 `queue-system` repo，設定：
   - **專案名稱：`queue-system`**（一定要跟 `wrangler.jsonc` 裡的 `name` 一樣）
   - **部署指令**：`npx wrangler deploy`（預設值，不用改）
   - **分支**：選放程式碼的分支（例如 `main`）
5. 按 **部署（Deploy）**，等 1～2 分鐘。完成後會拿到網址，例如
   `https://queue-system.你的帳號.workers.dev`
6. 用手機打開 `https://…workers.dev/admin`，**設定攤主密碼**（第一次打開時才會出現）。
   ⚠️ 部署完成後請**馬上設定**，避免被別人搶先。
7. 在叫號台的「⚙️ 設定與 QR code」裡改攤位名稱，再打開海報頁列印或截圖。完成！

之後只要 GitHub 上的程式碼有更新，Cloudflare 就會自動重新部署，排隊資料會保留。

### 不需要設定的東西
- **推播金鑰**：第一次啟動時會自動產生，並永久保存在 Cloudflare 上。
- **資料庫**：用 Cloudflare Durable Objects 儲存，免費方案就有。

### 忘記密碼怎麼辦
到 Cloudflare 後台 → 你的 Worker → **設定（Settings）** → **變數和密碼（Variables and Secrets）**，新增一個 **Secret**：名稱填 `ADMIN_PIN`，值填新密碼。設定之後就固定用這組密碼登入，叫號台裡的「修改密碼」功能會停用。

### 免費額度夠用嗎？
即時更新用的是 WebSocket，每筆變更直接推給所有手機，不需要一直重新整理，所以很省流量。一般攤位一天幾百組來賓，遠低於免費額度（每天 10 萬次請求）。

---

## 手機通知支援

| 裝置 | 怎麼收到通知 |
|---|---|
| Android（Chrome、Edge、Samsung 瀏覽器） | 按「開啟通知」，鎖定螢幕也收得到 |
| iPhone / iPad（iOS 16.4 以上） | 先用 **Safari**「分享 → 加入主畫面」，從主畫面打開後再按「開啟通知」 |
| 其他瀏覽器 | 頁面開著時，叫到號會有聲音和震動，畫面也會即時更新 |

攤主叫號台上，有開通知的號碼會顯示 🔔，沒開的顯示 🔕，沒開的可以改用現場喊號。

**小提醒**：很多人會用 LINE 或 IG 掃 QR code，App 內建的瀏覽器收不到通知。請提醒來賓點右上角，選「用瀏覽器開啟」。

---

## 給開發者

```bash
npm install
npm run dev      # 本機測試：http://localhost:8787
npm run deploy   # 用 wrangler 直接部署
```

- `src/index.js`：Worker 和 Durable Object（排隊邏輯、管理 API、WebSocket 廣播）
- `src/webpush.js`：只用 WebCrypto 寫成的 Web Push 加密（RFC 8291）和 VAPID 簽章（RFC 8292）
- `public/`：前端頁面，由 Cloudflare 靜態資產直接提供
- 選用的環境變數：`ADMIN_PIN`（固定密碼）、`BOOTH_NAME`（第一次啟動時的攤位名稱）、`VAPID_SUBJECT`
