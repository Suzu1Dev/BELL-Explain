import type { CodeExample } from "./types";

export interface DemoCodeExampleEntry {
  code: string;
  language: string;
  example: CodeExample;
}

const DEMO_CODE_EXAMPLES: Record<string, DemoCodeExampleEntry> = {
  "demo-closure:closure-environment": {
    language: "javascript",
    code: `function createCounter(initial = 0) {
  let count = initial;
  return function increment() {
    count += 1;
    return count;
  };
}

const counter = createCounter();
console.log(typeof counter, counter());`,
    example: {
      title: "追蹤閉包誕生與第一次呼叫",
      scenario:
        "建立一個從 0 起算的計數器函式，先確認拿到的是函式本身，再呼叫一次觀察外層變數如何被讀寫。",
      environment: "JavaScript（瀏覽器隔離沙盒 / ES2022）",
      walkthrough: [
        {
          startLine: 1,
          endLine: 2,
          explanation:
            "呼叫 createCounter() 時建立這次呼叫專屬的詞法環境，並初始化區域變數 count = 0。",
          state: "initial = 0, count = 0",
        },
        {
          startLine: 3,
          endLine: 6,
          explanation:
            "建立並回傳內層函式 increment；因為它定義在 createCounter 內部，會持續抓著外層的 count。",
          state: "return increment (綁定外層 count)",
        },
        {
          startLine: 9,
          endLine: 9,
          explanation:
            "createCounter() 執行結束，回傳的函式存入 counter。此時尚未呼叫 counter()，count 仍停在 0。",
          state: "counter = [Function: increment], count = 0",
        },
        {
          startLine: 10,
          endLine: 10,
          explanation:
            "先印出 typeof counter 為 'function'，接著執行 counter() 把同一個 count 從 0 加到 1 並回傳。",
          state: "count: 0 → 1",
          output: "function 1",
        },
      ],
      expectedOutput: "function 1",
      application:
        "需要在不暴露內部變數、也不汙染全域作用域的前提下保留私有狀態（例如計數器、快取或事件處理器設定）時使用。",
    },
  },

  "demo-closure:closure-state": {
    language: "javascript",
    code: `function createCounter(initial = 0) {
  let count = initial;
  return () => {
    count += 1;
    return count;
  };
}

const counter = createCounter();
console.log('第 1 次：', counter());
console.log('第 2 次：', counter());`,
    example: {
      title: "連續呼叫同一個閉包，狀態一路延續",
      scenario:
        "對同一個 counter 連續呼叫兩次，驗證閉包保留的是「可繼續讀寫的變數連結」，而不是建立當下的數值快照。",
      environment: "JavaScript（瀏覽器隔離沙盒 / ES2022）",
      walkthrough: [
        {
          startLine: 9,
          endLine: 9,
          explanation:
            "建立一組詞法環境（count = 0），並將回傳的箭頭函式指定給 counter。",
          state: "count = 0",
        },
        {
          startLine: 10,
          endLine: 10,
          explanation:
            "第一次呼叫 counter()：進入第 4–5 行把外層 count 由 0 改為 1，印出第 1 次結果。",
          state: "count: 0 → 1",
          output: "第 1 次： 1",
        },
        {
          startLine: 11,
          endLine: 11,
          explanation:
            "第二次呼叫 counter()：不會重建環境，而是讀到剛才更新後的 count = 1，累加為 2 後回傳。",
          state: "count: 1 → 2",
          output: "第 2 次： 2",
        },
      ],
      expectedOutput: "第 1 次： 1\n第 2 次： 2",
      application:
        "適合封裝跨多次事件觸發仍需累積的狀態，例如重試次數、分頁游標或表單步驟索引。",
    },
  },

  "demo-closure:closure-instances": {
    language: "javascript",
    code: `function createCounter(initial = 0) {
  let count = initial;
  return () => ++count;
}

const counter = createCounter();
counter();
const firstNow = counter();

const anotherCounter = createCounter(10);
console.log('anotherCounter:', anotherCounter());
console.log('counter 仍是:', firstNow);`,
    example: {
      title: "兩個計數器各自擁有獨立環境",
      scenario:
        "分別建立預設起點與從 10 起跳的兩個計數器，確認第二個實例更新時不會覆蓋第一個實例的狀態。",
      environment: "JavaScript（瀏覽器隔離沙盒 / ES2022）",
      walkthrough: [
        {
          startLine: 6,
          endLine: 8,
          explanation:
            "第一次呼叫 createCounter() 建立環境 #1（count = 0），連續執行兩次 counter() 後環境 #1 的 count 變為 2。",
          state: "環境 #1 count = 2",
        },
        {
          startLine: 10,
          endLine: 10,
          explanation:
            "再次呼叫 createCounter(10)，建立全新的環境 #2（count = 10），與環境 #1 完全隔離。",
          state: "環境 #1 count = 2 | 環境 #2 count = 10",
        },
        {
          startLine: 11,
          endLine: 12,
          explanation:
            "呼叫 anotherCounter() 只把環境 #2 加到 11；印出 firstNow 可確認環境 #1 依然停在 2。",
          state: "環境 #1 count = 2 | 環境 #2 count = 11",
          output: "anotherCounter: 11\ncounter 仍是: 2",
        },
      ],
      expectedOutput: "anotherCounter: 11\ncounter 仍是: 2",
      application:
        "當畫面上有多個相同元件（例如兩個獨立的搜尋框各自綁定 debounce）時，每次呼叫工廠函式都能給每個元件互不干擾的狀態。",
    },
  },

  "demo-event-loop:event-loop-stack": {
    language: "javascript",
    code: `console.log('A：開始');

setTimeout(() => {
  console.log('D：計時器');
}, 0);

Promise.resolve().then(() => {
  console.log('C：微任務');
});

console.log('B：結束');`,
    example: {
      title: "跟著中斷點走一遍 A → B → C → D",
      scenario:
        "同時寫下同步輸出、0 毫秒計時器與已完成的 Promise，觀察執行指標如何先跑完主程式，再依序跳回微任務與計時器。",
      environment: "JavaScript（瀏覽器隔離沙盒 / Event Loop）",
      walkthrough: [
        {
          startLine: 1,
          endLine: 1,
          explanation: "同步主程式開始執行，第一行立刻印出 A。",
          state: "呼叫堆疊 = [main] | 微任務 = [] | 計時器 = []",
          output: "A：開始",
        },
        {
          startLine: 3,
          endLine: 5,
          explanation:
            "向執行環境登記 0 ms 計時器；第 4 行的回呼只先排入計時器佇列，不會在此刻執行。",
          state: "微任務 = [] | 計時器 = [D]",
        },
        {
          startLine: 7,
          endLine: 9,
          explanation:
            "Promise 已是 fulfilled 狀態，.then 把第 8 行回呼排入微任務佇列，同樣等待主程式結束。",
          state: "微任務 = [C] | 計時器 = [D]",
        },
        {
          startLine: 11,
          endLine: 11,
          explanation:
            "執行最後一行同步程式印出 B，目前這段同步呼叫堆疊正式清空。",
          state: "呼叫堆疊清空 | 微任務 = [C] | 計時器 = [D]",
          output: "B：結束",
        },
        {
          startLine: 8,
          endLine: 8,
          explanation:
            "進入微任務檢查點，優先執行佇列中的 Promise.then 回呼，印出 C。",
          state: "微任務清空 | 計時器 = [D]",
          output: "C：微任務",
        },
        {
          startLine: 4,
          endLine: 4,
          explanation:
            "微任務清空後才輪到下一輪計時器任務上場，執行第 4 行印出 D。",
          state: "所有佇列清空",
          output: "D：計時器",
        },
      ],
      expectedOutput: "A：開始\nB：結束\nC：微任務\nD：計時器",
      application:
        "排查非同步狀態更新順序（例如 async/await 接續程式為何總是比 setTimeout(..., 0) 更早跑完）時最核心的心智模型。",
    },
  },

  "demo-event-loop:event-loop-microtask": {
    language: "javascript",
    code: `setTimeout(() => {
  console.log('D：計時器');
}, 0);

Promise.resolve()
  .then(() => {
    console.log('C1：第一個微任務');
  })
  .then(() => {
    console.log('C2：接續的微任務');
  });

console.log('B：同步結束');`,
    example: {
      title: "微任務鏈會一口氣清空，才輪到計時器",
      scenario:
        "在 Promise 鏈上串接兩個 .then，觀察第一個微任務衍生出的第二個微任務是否仍排在 0 ms 計時器之前。",
      environment: "JavaScript（瀏覽器隔離沙盒 / Event Loop）",
      walkthrough: [
        {
          startLine: 1,
          endLine: 3,
          explanation: "先登記 0 ms 計時器 D，等待後續任務階段。",
          state: "計時器 = [D]",
        },
        {
          startLine: 5,
          endLine: 11,
          explanation:
            "第一個 Promise 已完成，C1 進入微任務佇列；第二個 .then (C2) 則要等 C1 回傳後才會排入。",
          state: "微任務 = [C1] | 計時器 = [D]",
        },
        {
          startLine: 13,
          endLine: 13,
          explanation: "同步主程式先執行完畢並印出 B。",
          state: "呼叫堆疊清空",
          output: "B：同步結束",
        },
        {
          startLine: 7,
          endLine: 7,
          explanation:
            "微任務檢查點執行 C1 並印出結果，完成瞬間把接續的 C2 也排進微任務佇列。",
          state: "微任務 = [C2] | 計時器 = [D]",
          output: "C1：第一個微任務",
        },
        {
          startLine: 10,
          endLine: 10,
          explanation:
            "微任務檢查點會一路處理到佇列全空為止，因此 C2 緊接著執行，不必等下一輪任務。",
          state: "微任務清空 | 計時器 = [D]",
          output: "C2：接續的微任務",
        },
        {
          startLine: 2,
          endLine: 2,
          explanation: "直到整條微任務鏈清空後，計時器 D 才終於取得執行機會。",
          state: "所有佇列清空",
          output: "D：計時器",
        },
      ],
      expectedOutput: "B：同步結束\nC1：第一個微任務\nC2：接續的微任務\nD：計時器",
      application:
        "理解為什麼連續串接的 Promise / await 會在同一個畫面更新週期前完成，而無止境排入微任務會卡住計時器與渲染。",
    },
  },

  "demo-event-loop:event-loop-timer": {
    language: "javascript",
    code: `const start = Date.now();

setTimeout(() => {
  const elapsed = Date.now() - start;
  console.log('計時器在同步計算後才觸發：', elapsed >= 0);
}, 0);

let sum = 0;
for (let i = 0; i < 50000; i += 1) sum += i;
console.log('同步計算先完成：', sum);`,
    example: {
      title: "0 毫秒只是最早可排程門檻，不能插隊",
      scenario:
        "設定 0 ms 計時器後立刻執行一段同步迴圈計算，驗證計時器必須等主執行緒空出後才會觸發。",
      environment: "JavaScript（瀏覽器隔離沙盒 / Event Loop）",
      walkthrough: [
        {
          startLine: 3,
          endLine: 6,
          explanation:
            "設定延遲 0 ms 的計時器；即使時間門檻立刻滿足，回呼仍只能排隊等待目前程式讓出執行緒。",
          state: "計時器已就緒，等待主執行緒空閒",
        },
        {
          startLine: 8,
          endLine: 10,
          explanation:
            "主執行緒忙著跑完 50,000 次迴圈並印出總和，期間計時器回呼無法插隊。",
          state: "sum = 1249975000",
          output: "同步計算先完成： 1249975000",
        },
        {
          startLine: 4,
          endLine: 5,
          explanation:
            "同步程式結束後，計時器任務才被取出執行（你也可以點「微調實驗」直接印出 elapsed 毫秒數觀察）。",
          state: "elapsed >= 0 → true",
          output: "計時器在同步計算後才觸發： true",
        },
      ],
      expectedOutput:
        "同步計算先完成： 1249975000\n計時器在同步計算後才觸發： true",
      application:
        "解釋為什麼繁重的同步運算會讓 setTimeout 延遲、動畫掉格，以及為什麼需要將大計算拆小或移往 Web Worker。",
    },
  },

  "demo-debounce:debounce-reset": {
    language: "javascript",
    code: `function debounce(fn, delay) {
  let timerId;
  return (...args) => {
    clearTimeout(timerId);
    timerId = setTimeout(() => fn(...args), delay);
  };
}

const search = debounce((q) => console.log('搜尋：' + q), 80);
search('c');
search('cl');
search('closure');`,
    example: {
      title: "連續輸入三次，只執行最後一次搜尋",
      scenario:
        "模擬使用者快速輸入 c → cl → closure，觀察每次新呼叫如何取消舊計時器，最後只印出一次搜尋結果。",
      environment: "JavaScript（瀏覽器隔離沙盒 / 計時器排程）",
      walkthrough: [
        {
          startLine: 9,
          endLine: 9,
          explanation:
            "建立防抖版 search 函式（此處設為 80 ms 方便即時實測），閉包內準備好共用的 timerId。",
          state: "timerId = undefined",
        },
        {
          startLine: 10,
          endLine: 10,
          explanation:
            "第一次輸入 'c'：排入計時器 #1，預計 80 ms 後搜尋 'c'。",
          state: "timerId = #1 (等待 'c')",
        },
        {
          startLine: 11,
          endLine: 11,
          explanation:
            "緊接著輸入 'cl'：第 4 行 clearTimeout 先取消尚未觸發的 #1，再換上計時器 #2。",
          state: "取消 #1 → timerId = #2 (等待 'cl')",
        },
        {
          startLine: 12,
          endLine: 12,
          explanation:
            "最後輸入 'closure'：取消 #2，建立計時器 #3 並保留參數 'closure'。",
          state: "取消 #2 → timerId = #3 (等待 'closure')",
        },
        {
          startLine: 5,
          endLine: 5,
          explanation:
            "停下來滿 80 ms 沒有新呼叫，計時器 #3 順利到期並執行 fn('closure')。",
          state: "觸發 fn('closure')",
          output: "搜尋：closure",
        },
      ],
      expectedOutput: "搜尋：closure",
      application:
        "常用於即時搜尋框自動完成、視窗 resize 重新排版與編輯器自動儲存草稿，避免每次微小變動都發動昂貴工作。",
    },
  },

  "demo-debounce:debounce-closure": {
    language: "javascript",
    code: `function debounce(callback, delay) {
  let timerId;
  return function (...args) {
    clearTimeout(timerId);
    timerId = setTimeout(() => {
      callback.apply(this, args);
    }, delay);
  };
}

const searchBox = {
  prefix: '查詢關鍵字',
  run: debounce(function (word) {
    console.log(this.prefix + '：' + word);
  }, 60),
};

searchBox.run('re');
searchBox.run('react');`,
    example: {
      title: "閉包共用 timerId，並保留呼叫當下的 this 與參數",
      scenario:
        "將 debounce 包裝後的方法掛在物件上連續呼叫兩次，驗證 timerId 能跨呼叫共用，且物件的 this.prefix 不會遺失。",
      environment: "JavaScript（瀏覽器隔離沙盒 / ES2022）",
      walkthrough: [
        {
          startLine: 1,
          endLine: 2,
          explanation:
            "debounce 只在建立 searchBox.run 時執行一次，產生唯一一個供後續共用的 timerId。",
          state: "timerId = undefined",
        },
        {
          startLine: 18,
          endLine: 19,
          explanation:
            "連續呼叫兩次 searchBox.run：第二次透過閉包讀到第一次留下的 timerId 並取消它，同時記錄最新的 this (searchBox) 與 args (['react'])。",
          state: "this = searchBox, args = ['react']",
        },
        {
          startLine: 5,
          endLine: 7,
          explanation:
            "等待 60 ms 後箭頭函式觸發，透過 callback.apply(this, args) 把正確的 searchBox 與 'react' 傳給原函式。",
          state: "執行 callback.apply(searchBox, ['react'])",
          output: "查詢關鍵字：react",
        },
      ],
      expectedOutput: "查詢關鍵字：react",
      application:
        "實作通用工具函式時，用一般 function 接住呼叫端的動態 this，搭配計時器內層箭頭函式轉交，能相容物件方法與 DOM 事件處理器。",
    },
  },

  "demo-debounce:debounce-timing": {
    language: "javascript",
    code: `let inputs = 0;
let requests = 0;
let timerId;

function onInput(query) {
  inputs += 1;
  clearTimeout(timerId);
  timerId = setTimeout(() => {
    requests += 1;
    console.log(\`輸入 \${inputs} 次 → 實際送出 \${requests} 次（\${query}）\`);
  }, 60);
}

onInput('c');
onInput('cl');
onInput('closure');`,
    example: {
      title: "對照輸入次數與實際發送次數",
      scenario:
        "同時統計使用者的原始輸入次數（inputs）與真正進入搜尋回呼的次數（requests），直觀觀察防抖省下的請求量。",
      environment: "JavaScript（瀏覽器隔離沙盒 / 計時器排程）",
      walkthrough: [
        {
          startLine: 5,
          endLine: 7,
          explanation:
            "每次呼叫 onInput 都會把 inputs 加 1，並立即清除上一個尚未到期的計時器排程。",
          state: "inputs 隨每次呼叫遞增，requests 仍為 0",
        },
        {
          startLine: 14,
          endLine: 16,
          explanation:
            "同一段同步程式連續觸發三次輸入：inputs 累積為 3，但前兩次排程都在到期前被取消。",
          state: "inputs = 3, requests = 0, 等待 query = 'closure'",
        },
        {
          startLine: 8,
          endLine: 11,
          explanation:
            "安靜等待 60 ms 後，唯一存活的計時器執行，requests 只增加到 1 並印出統計結果。",
          state: "inputs = 3, requests = 1",
          output: "輸入 3 次 → 實際送出 1 次（closure）",
        },
      ],
      expectedOutput: "輸入 3 次 → 實際送出 1 次（closure）",
      application:
        "評估防抖效益或加上監控指標時，比較原始事件數與實際請求數即可量化節省的 API 呼叫比例；若請求已送出，別忘了再搭配 AbortController 處理競態。",
    },
  },
};

export function getDemoCodeExample(
  lessonId: string,
  sectionId: string,
): DemoCodeExampleEntry | undefined {
  return DEMO_CODE_EXAMPLES[`${lessonId}:${sectionId}`];
}

export function allDemoCodeExamples(): Readonly<Record<string, DemoCodeExampleEntry>> {
  return DEMO_CODE_EXAMPLES;
}
