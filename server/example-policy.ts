export const practicalExamplePolicy = `
教學必須包含至少一個、通常 2–4 個貼近核心概念的實作案例，放在最相關的 sections，而不是只用文字定義或生活比喻。每個案例使用該段的 code、language，並附上 codeExample。
先依主題選擇學習者實際會遇到的材料，language 填寫實際格式名稱（例如 c、python、json、yaml、hexdump、riscv-asm、shell）：
- 程式語言、演算法與資料結構：可執行的小程式，沿用來源語言；未指定時，系統與底層主題用 C，前端與一般程式／演算法概念優先用可在瀏覽器沙盒直接執行的純標準 JavaScript（以 console.log 印出關鍵步驟與結果），資料科學或特定生態系用 Python。演算法案例要看得出狀態如何逐步變化（例如 frontier、堆疊或 DP 表），並在 walkthrough 交代時間與空間複雜度。
- 雲端與設定（AWS、IAM、容器、CI/CD）：真實格式的設定或政策，例如 IAM identity／trust policy JSON、ECS task definition、Dockerfile、YAML；帳號、ARN、網域一律使用 123456789012、example.com 這類保留值。
- 網路與協定：訊框或封包的十六進位傾印，walkthrough 依位元組位移逐段解讀欄位；可加上 Wireshark 顯示過濾式或指令與推導的輸出。退避、學習表、狀態機這類流程主題可改用小型模擬程式。
- 組合語言與計算機組織：短組合語言片段，搭配 pc、暫存器與記憶體的逐步追蹤表。
- 資安與除錯：最小可重現的程式與觸發輸入，加上 gdb 或 sanitizer 指令；沒有實際執行的輸出一律標示為推導。
每個案例專注一個實際問題，通常 8–35 行，最多 80 行；包含可理解的輸入、核心內容與可觀察的結果，不要只有未定義函式、省略號或 TODO。若需要 SDK、套件、檔案、設定或雲端資源，environment 清楚列出前提，不能把模擬流程描述成真正呼叫服務。依一般知識撰寫的公開格式（政策 JSON、封包欄位、指令選項）要在 environment 註明「依一般知識撰寫，未對照最新官方文件」；沒有依據時不要虛構 API 或欄位。
codeExample.title 是案例名稱；scenario 先描述學習者要解決的具體問題；environment 說明執行環境與前提；walkthrough 用 2–8 步白話拆解，每步說明「這幾行做了什麼、為何需要、對應哪個概念」，不可只重述語法：若是需要逐步觀察執行過程與輸出結果的可執行程式或演算法案例，walkthrough 應依實際執行順序排列，每步填寫 state（該步當下的關鍵變數／資料結構中間狀態快照，純文字如 "count = 1, queue = [2, 3]"，不加 LaTeX），並只在真正印出輸出的那一步填寫 output（該步新增印出的單段輸出），讓讀者能逐步看到中間過程與累積輸出；若是靜態設定檔（JSON／YAML／IAM 政策）、封包傾印或純指令參考，則不填 output，維持靜態分段解說。startLine/endLine 為 code 字串的 1 起算行號，必須是存在的行，且 startLine <= endLine。不要把程式碼塞進 body 或 explanation。
expectedOutput 提供具體的預期輸出或狀態，清楚區分推導與實測；平台不會執行程式，不可聲稱測試通過。學習者會先預測結果再展開 expectedOutput，所以答案只放在這裡，不要寫在同段 body。application 說明可以用在哪種真實情境，以及這個小案例省略的正式環境需求。codeExample 不是完整專案的部署承諾。
scenario、walkthrough 與 application 寫到數學式（例如複雜度 \\(O(n \\log n)\\)）時同樣用 LaTeX；code 與程式輸出照原樣寫，不加 LaTeX。
概念介紹、總結等不需要案例的段落可以省略 codeExample、保留 code 空字串，但整篇不能完全沒有實作案例。不要把只重複印出定義的程式當成實作案例。`;
