import type { Lesson, SourceKind } from "./types";

const createdAt = new Date().toISOString();

const closureCode = `function createCounter(initial = 0) {
  let count = initial;

  return function increment() {
    count += 1;
    return count;
  };
}

const counter = createCounter();
console.log(counter()); // 1
console.log(counter()); // 2

const anotherCounter = createCounter(10);
console.log(anotherCounter()); // 11`;

const eventLoopCode = `console.log('A：開始');

setTimeout(() => {
  console.log('D：計時器');
}, 0);

Promise.resolve().then(() => {
  console.log('C：微任務');
});

console.log('B：結束');

// A：開始 → B：結束 → C：微任務 → D：計時器`;

const debounceCode = `function debounce(callback, delay) {
  let timerId;

  return function (...args) {
    clearTimeout(timerId);
    timerId = setTimeout(() => {
      callback.apply(this, args);
    }, delay);
  };
}

const search = debounce((query) => {
  console.log('搜尋：' + query);
}, 300);

search('c');
search('cl');
search('closure');

// 等待至少 300 ms，最後只印出「搜尋：closure」。`;

/** Authored teaching material. These lessons are explicitly marked as demos. */
export const exampleLessons: Lesson[] = [
  {
    id: "demo-closure",
    title: "閉包：函式的隨身背包",
    subtitle: "函式離開出生地，為什麼還記得裡面的變數？",
    summary:
      "閉包讓函式持續存取建立當下的詞法環境。用一個小小的計數器，看懂狀態如何留下來，以及不同計數器為什麼互不干擾。",
    category: "JavaScript",
    tags: ["JavaScript", "閉包", "作用域", "函式", "狀態管理"],
    source: {
      kind: "code",
      label: "JavaScript 閉包與獨立計數器",
      content: closureCode,
      scope: "人工編寫的互動示範",
    },
    sections: [
      {
        id: "closure-environment",
        heading: "01 / 函式記得自己在哪裡誕生",
        body: "increment 寫在 createCounter 裡面，因此可以透過詞法作用域找到外層的 count。呼叫 createCounter() 時，我們取得的是 increment 函式本身；外層呼叫雖然結束，回傳的函式仍能存取這次呼叫建立的 count。函式與它所保留的詞法環境，合起來就是閉包。",
        analogy:
          "想像你離開一間工作室時，帶走了工具箱的鑰匙。工作結束不代表工具消失；只要鑰匙仍有用，你就能回去使用那一套工具。",
        code: `function createCounter(initial = 0) {
  let count = initial;
  return function increment() {
    count += 1;
    return count;
  };
}

const counter = createCounter(); // 拿到函式，尚未加一`,
        language: "javascript",
        concepts: ["JavaScript", "閉包", "作用域", "函式"],
        visualStep: 1,
      },
      {
        id: "closure-state",
        heading: "02 / 留下的是變數，不是數字的照片",
        body: "每次呼叫 counter()，increment 都會讀寫同一個 count。第一次把 0 改成 1，第二次再把 1 改成 2。閉包保留的是對環境中變數的存取能力，不是把建立時的值複製一份。因此 count 的更新會延續到下一次呼叫。",
        analogy:
          "這個背包裡裝的是一本可以繼續寫的帳本。你每次翻開都看到最新紀錄，而不是第一次拿到帳本時的照片。",
        code: `console.log(counter()); // count：0 → 1，印出 1
console.log(counter()); // count：1 → 2，印出 2`,
        language: "javascript",
        concepts: ["閉包", "函式", "狀態管理"],
        visualStep: 3,
      },
      {
        id: "closure-instances",
        heading: "03 / 再呼叫一次，就有另一個背包",
        body: "每次執行 createCounter，都會建立新的呼叫環境與自己的 count。anotherCounter 從 10 開始，呼叫後得到 11，不會改到 counter 的 count。這也是閉包適合封裝小型狀態的原因；同樣的做法可以讓每個 debounce 函式保留自己獨立的計時器。",
        analogy:
          "同一份帳本範本，可以印給不同店家。格式相同不代表共用帳目；每家店都在自己的那一本上記帳。",
        code: `const anotherCounter = createCounter(10);
console.log(anotherCounter()); // 11

// 此時 counter 的 count 仍是 2。
// counter 與 anotherCounter 使用不同的環境。`,
        language: "javascript",
        concepts: ["閉包", "作用域", "狀態管理", "Debounce"],
        visualStep: 4,
      },
    ],
    visual: {
      kind: "closure",
      title: "追蹤一個被留下來的 count",
      caption: "沿著函式與環境的連結，觀察狀態如何跨越多次呼叫。",
      nodes: [
        {
          id: "factory",
          label: "createCounter",
          detail: "每次呼叫建立新的環境",
        },
        { id: "environment", label: "專屬環境", detail: "保留可讀寫的 count" },
        { id: "counter", label: "counter()", detail: "回傳的 increment 函式" },
        {
          id: "another",
          label: "anotherCounter()",
          detail: "另一個獨立計數器",
        },
      ],
      steps: [
        {
          title: "建立環境",
          description:
            "呼叫 createCounter()，建立 count = 0，並建立 increment 函式。",
          activeNodeIds: ["factory", "environment"],
          output: "count = 0\n尚無 console 輸出",
        },
        {
          title: "把函式帶走",
          description: "increment 回傳並指定給 counter；它仍連結到原本的環境。",
          activeNodeIds: ["environment", "counter"],
          output: "counter → increment → count\n尚無 console 輸出",
        },
        {
          title: "第一次呼叫",
          description: "counter() 更新同一個 count：0 → 1，回傳 1。",
          activeNodeIds: ["counter", "environment"],
          output: "> 1",
        },
        {
          title: "接著呼叫一次",
          description: "環境沒有重建。第二次從 1 繼續累加，回傳 2。",
          activeNodeIds: ["counter", "environment"],
          output: "> 1\n> 2",
        },
        {
          title: "另一個獨立環境",
          description:
            "createCounter(10) 建立另一個 count。anotherCounter() 得到 11，第一個 count 仍是 2。",
          activeNodeIds: ["factory", "another"],
          output: "> 1\n> 2\n> 11",
        },
      ],
    },
    connections: [
      {
        targetId: "demo-debounce",
        sectionId: "debounce-closure",
        reason: "Debounce 用同樣的閉包機制，讓連續呼叫讀寫同一個 timerId。",
      },
      {
        targetId: "demo-event-loop",
        sectionId: "event-loop-timer",
        reason:
          "函式可以稍後執行；Event Loop 說明回呼何時執行，閉包說明它能存取哪些變數。",
      },
    ],
    followUpQuestions: [
      "如果兩個變數指向同一個 counter 函式，它們會共用 count 嗎？",
      "為什麼把 createCounter() 放在每次按鈕點擊裡，計數可能一直停在 1？",
      "如果要同時提供 increment 與 reset，如何讓它們共用同一個 count？",
    ],
    createdAt,
    updatedAt: createdAt,
    isDemo: true,
    favorite: false,
  },
  {
    id: "demo-event-loop",
    title: "Event Loop：非同步的執行順序",
    subtitle: "明明先寫 setTimeout，為什麼 Promise 先出現？",
    summary:
      "從四行輸出看懂同步程式、微任務與計時器回呼的順序。先掌握「目前的程式跑完」，再理解排隊的工作如何輪到自己。",
    category: "JavaScript",
    tags: ["JavaScript", "非同步", "Event Loop", "Promise", "計時器", "函式"],
    source: {
      kind: "code",
      label: "瀏覽器中的同步程式、Promise 與計時器",
      content: eventLoopCode,
      scope: "人工編寫的互動示範",
    },
    sections: [
      {
        id: "event-loop-stack",
        heading: "01 / 先把手上的程式跑完",
        body: "在這個瀏覽器範例裡，目前這段同步程式會先執行完成。setTimeout 是登記稍後要做的事；對已 fulfilled 的 Promise 呼叫 .then，也只是安排微任務。兩個回呼都不會插進目前這段同步程式，所以先印出 A，再印出 B。",
        analogy:
          "像店員正在替眼前的客人結帳。即使有人留下待辦紙條，店員也會先把這筆交易處理完，再看下一件事。",
        code: `console.log('A：開始');
setTimeout(() => console.log('D：計時器'), 0);
Promise.resolve().then(() => console.log('C：微任務'));
console.log('B：結束');

// 同步階段先印出 A、B。`,
        language: "javascript",
        concepts: ["JavaScript", "非同步", "Event Loop", "函式"],
        visualStep: 2,
      },
      {
        id: "event-loop-microtask",
        heading: "02 / 接著處理微任務",
        body: "這段同步程式結束後，瀏覽器會在微任務檢查點處理待執行的微任務。本例中的 Promise 已經 fulfilled，所以 .then 的回呼已排入微任務佇列，會印出 C。檢查點會持續處理微任務，包含處理過程中新加入的微任務；如果不斷新增，也可能拖延後續工作與畫面更新。",
        analogy:
          "結帳完成後，先把這一筆交易衍生的收尾紙條處理完。收尾又產生了新的紙條，也會繼續處理，才接下一筆工作。",
        code: `Promise.resolve().then(() => {
  console.log('C：微任務');
});

// 在本例中：同步 A、B → 微任務 C`,
        language: "javascript",
        concepts: ["非同步", "Promise", "Event Loop"],
        visualStep: 3,
      },
      {
        id: "event-loop-timer",
        heading: "03 / 0 毫秒，不等於立刻執行",
        body: "setTimeout(fn, 0) 不會立刻呼叫 fn。計時器符合排程條件後，回呼會作為後續任務等待執行；目前工作與微任務都要先讓出執行機會。本例最後才印出 D。延遲參數也不是精準的執行時間，忙碌的主執行緒、背景分頁與瀏覽器的計時限制，都可能讓回呼更晚發生。",
        analogy:
          "號碼牌上寫「現在起可以叫號」，並不表示你立刻走到櫃台。櫃台還得完成手上的事，才有機會叫到你。",
        code: `setTimeout(() => {
  console.log('D：計時器');
}, 0);

// 完整順序：
// A：開始 → B：結束 → C：微任務 → D：計時器`,
        language: "javascript",
        concepts: ["非同步", "計時器", "Event Loop", "Debounce"],
        visualStep: 4,
      },
    ],
    visual: {
      kind: "event-loop",
      title: "跟著 A → B → C → D 走一遍",
      caption:
        "以這段瀏覽器程式為例，顯示相關排程階段；省略渲染與其他任務來源。",
      nodes: [
        { id: "stack", label: "呼叫堆疊", detail: "目前執行中的 JavaScript" },
        {
          id: "microtasks",
          label: "微任務",
          detail: "本例的 Promise.then 回呼",
        },
        { id: "timer", label: "計時器任務", detail: "等待條件滿足與執行機會" },
        { id: "console", label: "Console", detail: "累積輸出結果" },
      ],
      steps: [
        {
          title: "同步開始",
          description: "執行第一個 console.log，立刻印出 A。",
          activeNodeIds: ["stack", "console"],
          output: "> A：開始",
        },
        {
          title: "安排稍後的工作",
          description:
            "登記 setTimeout，再把已 fulfilled Promise 的 .then 回呼排為微任務；都還沒有執行回呼。",
          activeNodeIds: ["stack", "timer", "microtasks"],
          output: "> A：開始",
        },
        {
          title: "同步程式完成",
          description:
            "執行最後一行同步 console.log，印出 B，接著離開目前這段程式。",
          activeNodeIds: ["stack", "console"],
          output: "> A：開始\n> B：結束",
        },
        {
          title: "處理微任務",
          description: "在微任務檢查點執行 .then 回呼，印出 C。",
          activeNodeIds: ["microtasks", "stack", "console"],
          output: "> A：開始\n> B：結束\n> C：微任務",
        },
        {
          title: "計時器取得執行機會",
          description: "計時條件滿足後，瀏覽器執行計時器任務，印出 D。",
          activeNodeIds: ["timer", "stack", "console"],
          output: "> A：開始\n> B：結束\n> C：微任務\n> D：計時器",
        },
      ],
    },
    connections: [
      {
        targetId: "demo-debounce",
        sectionId: "debounce-timing",
        reason:
          "Debounce 的等待時間也受計時器排程影響；300 ms 是等待門檻，並非準時執行的承諾。",
      },
      {
        targetId: "demo-closure",
        sectionId: "closure-environment",
        reason: "排程延後的是執行時機；回呼仍可透過閉包存取建立時的外層環境。",
      },
    ],
    followUpQuestions: [
      "如果把 Promise.then 寫在 setTimeout 前面，這個範例的輸出會改變嗎？",
      "如果在微任務裡再排一個微任務，它會在計時器之前執行嗎？",
      "為什麼很耗時的同步迴圈，會讓 0 ms 的計時器與畫面更新一起延遲？",
    ],
    createdAt,
    updatedAt: createdAt,
    isDemo: true,
    favorite: false,
  },
  {
    id: "demo-debounce",
    title: "Debounce：等一下，再執行",
    subtitle: "把連續輸入收斂成最後一次有意義的動作。",
    summary:
      "用搜尋框理解防抖：每次新輸入都重新計時，停下來一段時間後才執行最後一次。把閉包與計時器串起來，做出一個實際可用的函式。",
    category: "前端開發",
    tags: ["JavaScript", "Debounce", "閉包", "非同步", "計時器", "函式"],
    source: {
      kind: "code",
      label: "使用閉包實作尾端觸發的 Debounce",
      content: debounceCode,
      scope: "人工編寫的互動示範",
    },
    sections: [
      {
        id: "debounce-reset",
        heading: "01 / 新輸入到來，就重新開始等待",
        body: "Debounce（防抖）把密集的呼叫合併處理。這個版本採用尾端觸發：每次呼叫先取消前一次尚未執行的計時器，再安排新的計時器。範例在同一段同步程式裡連續傳入 c、cl、closure，前兩次排程會被取消，最後只會搜尋 closure。",
        analogy:
          "電梯門準備關閉時，有人再按開門鍵，等待時間就重新計算。等一小段時間都沒人再按，門才真正關上。",
        code: `const search = debounce((query) => {
  console.log('搜尋：' + query);
}, 300);

search('c');
search('cl');
search('closure'); // 只留下這次排程`,
        language: "javascript",
        concepts: ["Debounce", "非同步", "計時器", "函式"],
        visualStep: 2,
      },
      {
        id: "debounce-closure",
        heading: "02 / 用閉包記住上一個計時器",
        body: "timerId 定義在 debounce 裡，回傳的包裝函式每次都讀寫同一個 timerId，因此能取消自己的上一個排程。每次呼叫又會建立自己的 args，最後存活的計時器就使用最後一次的參數。一般函式保留呼叫時的 this，計時器內的箭頭函式再用這個 this 呼叫 callback。實際綁定輸入事件時，要先建立一次 debounce 函式，讓後續事件重用它。",
        analogy:
          "服務台把最新一張預約單的編號放在同一個抽屜。新預約來時，先用抽屜裡的編號取消舊單，再換成新編號；如果每次都開一個新抽屜，就找不到上一張了。",
        code: `function debounce(callback, delay) {
  let timerId; // 包裝函式持續共用的狀態

  return function (...args) {
    clearTimeout(timerId);
    timerId = setTimeout(() => {
      callback.apply(this, args);
    }, delay);
  };
}`,
        language: "javascript",
        concepts: [
          "JavaScript",
          "Debounce",
          "閉包",
          "作用域",
          "函式",
          "狀態管理",
        ],
        visualStep: 3,
      },
      {
        id: "debounce-timing",
        heading: "03 / 停下來之後，才有執行機會",
        body: "最後一次呼叫後，至少等待設定的 300 ms，計時器回呼才有機會執行；若主執行緒忙碌，實際時間會更晚。這個簡化版本沒有 cancel、立即觸發或最長等待時間，也不會取消已開始的網路請求。如果用於遠端搜尋，還需要另外處理請求取消或忽略過期回應，避免較舊的結果覆蓋最新結果。",
        analogy:
          "預約單還沒送進廚房時，可以取消換單；一旦廚師開始做菜，撕掉預約單不會讓料理自動停止。等待中的排程與已開始的工作，是兩件不同的事。",
        code: `// 本例前三次呼叫都在同一段同步程式裡完成。
// 最後的計時器保留 query = 'closure'。
// 等待至少 300 ms，且主執行緒能執行時：
// > 搜尋：closure

// clearTimeout 取消的是尚未執行的排程，
// 不會中止 callback 已經啟動的 fetch。`,
        language: "javascript",
        concepts: ["Debounce", "非同步", "計時器", "Event Loop"],
        visualStep: 4,
      },
    ],
    visual: {
      kind: "debounce",
      title: "三次輸入，一次搜尋",
      caption: "示意連續同步呼叫 c、cl、closure；最後一次之後才開始有效等待。",
      nodes: [
        { id: "input", label: "輸入", detail: "c → cl → closure" },
        {
          id: "closure",
          label: "共用 timerId",
          detail: "閉包保留最新計時器編號",
        },
        {
          id: "timer",
          label: "等待 300 ms",
          detail: "新呼叫取消舊排程並重新計時",
        },
        { id: "search", label: "執行搜尋", detail: "使用最後一次呼叫的參數" },
      ],
      steps: [
        {
          title: "第一次輸入：c",
          description: "建立第一個計時器，timerId 記住它；目前還沒有搜尋。",
          activeNodeIds: ["input", "closure", "timer"],
          output: "等待：c\n搜尋執行次數：0",
        },
        {
          title: "接著輸入：cl",
          description: "取消 c 的計時器，建立 cl 的新計時器，更新 timerId。",
          activeNodeIds: ["input", "closure", "timer"],
          output: "取消：c\n等待：cl\n搜尋執行次數：0",
        },
        {
          title: "最後輸入：closure",
          description: "取消 cl 的計時器；只留下 closure 的計時器與參數。",
          activeNodeIds: ["input", "closure", "timer"],
          output: "取消：cl\n等待：closure\n搜尋執行次數：0",
        },
        {
          title: "安靜等待",
          description:
            "沒有新呼叫，所以不再重設計時器。最後一次呼叫的 args 仍可由計時器回呼存取。",
          activeNodeIds: ["closure", "timer"],
          output: "保留參數：closure\n等待至少 300 ms\n搜尋執行次數：0",
        },
        {
          title: "執行最後一次",
          description: "等待條件滿足並取得執行機會後，callback 收到 closure。",
          activeNodeIds: ["timer", "search"],
          output: "> 搜尋：closure\n搜尋執行次數：1",
        },
      ],
    },
    connections: [
      {
        targetId: "demo-closure",
        sectionId: "closure-state",
        reason: "timerId 與計數器的 count 一樣，是跨多次呼叫保留的可變狀態。",
      },
      {
        targetId: "demo-event-loop",
        sectionId: "event-loop-timer",
        reason:
          "計時器需要等待執行機會，解釋了為什麼 Debounce 不保證恰好在 300 ms 執行。",
      },
    ],
    followUpQuestions: [
      "如果每次 input 事件都重新呼叫 debounce()，為什麼舊計時器取消不了？",
      "如果使用者持續輸入都不停，這個尾端觸發版本會一直延後嗎？",
      "搜尋請求已經送出後，如何避免較舊的回應覆蓋最新結果？",
    ],
    createdAt,
    updatedAt: createdAt,
    isDemo: true,
    favorite: false,
  },
];

export const exampleInputs: {
  id: string;
  label: string;
  kind: SourceKind;
  content: string;
  description: string;
}[] = exampleLessons.map((lesson) => ({
  id: lesson.id,
  label: lesson.title,
  kind: lesson.source.kind,
  content: lesson.source.content,
  description: lesson.subtitle,
}));
